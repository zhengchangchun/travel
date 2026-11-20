const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, loadCategories, ROOT } = require('./config');
const { createCache } = require('./cache');
const defaultAmap = require('./amap');
const { createDb } = require('./db');
const {
  createRateLimiter,
  createViewportRunRegistry,
  DEFAULT_VIEWPORT_RATE_PER_MIN,
  CATEGORY_ROTATION,
} = require('./collect');

const cityRoutes = require('./routes/city');
const poiRoutes = require('./routes/poi');
const poisRoutes = require('./routes/pois');
const tripsRoutes = require('./routes/trips');
const notesRoutes = require('./routes/notes');
const { createNoteJobs } = require('./note-jobs');
const selectionRoutes = require('./routes/selection');
const routeRoutes = require('./routes/route');
const authRoutes = require('./routes/auth');
const homeRoutes = require('./routes/home');
const sharesRoutes = require('./routes/shares');
const legacyRoutes = require('./routes/legacy');
const buddiesRoutes = require('./routes/buddies');
const backupRoutes = require('./routes/backup');
const photos = require('./featured-photos');
const homeImg = require('./home-img');

class HttpError extends Error {
  constructor(status, code, msg) {
    super(msg);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendOk(res, data) {
  writeJson(res, 200, { ok: true, data, error: null });
}

function sendErr(res, status, code, msg) {
  writeJson(res, status, { ok: false, data: null, error: { code, msg } });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(pattern) {
  const parts = pattern.split('/').filter(Boolean);
  const keys = [];
  const source = parts
    .map((p) => {
      if (p.startsWith(':')) {
        keys.push(p.slice(1));
        return '([^/]+)';
      }
      return escapeRegExp(p);
    })
    .join('/');
  return { regex: new RegExp(`^/${source}/?$`), keys };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }
}

// 页面路由：首页 / 各子页 / 地图应用（应用本身在 /app，链接别的页面不用带 .html）
const PAGES = {
  '/': 'home.html',
  '/home': 'home.html',
  '/app': 'index.html',
  '/trips': 'trips.html',
  '/shares': 'shares.html',
  '/buddies': 'buddies.html',
  '/settings': 'settings.html',
  '/login': 'login.html',
};

function serveStatic(req, res, pathname, baseDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendErr(res, 405, 'METHOD_NOT_ALLOWED', '静态资源仅支持 GET/HEAD');
    return;
  }
  const webRoot = baseDir || path.join(ROOT, 'web');
  const page = !baseDir && PAGES[pathname.replace(/\/+$/, '') || '/'];
  const rel = page || (pathname === '/' ? '/index.html' : pathname);
  const filePath = path.normalize(path.join(webRoot, rel));
  if (filePath !== webRoot && !filePath.startsWith(webRoot + path.sep)) {
    sendErr(res, 403, 'FORBIDDEN', '路径非法');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      sendErr(res, 404, 'NOT_FOUND', '资源不存在');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function createApp(opts = {}) {
  const config = opts.config || loadConfig();
  const categories = opts.categories || loadCategories();
  const cache = opts.cache || createCache();
  const db = opts.db || createDb(process.env.TRAVEL_DB || path.join(ROOT, 'data', 'travel.db'));
  const amap = opts.amap || defaultAmap;
  if (!opts.amap && typeof amap.setConfig === 'function') amap.setConfig(config);

  const rawRoutes = [
    {
      method: 'GET',
      path: '/api/health',
      handler: (ctx) => ({ status: 'up', uptime: process.uptime(), cache: ctx.cache.stats() }),
    },
    {
      method: 'GET',
      path: '/api/config',
      handler: (ctx) => ({
        jsApiKey: ctx.config.amap.jsApiKey,
        jsApiSecurityCode: ctx.config.amap.jsApiSecurityCode,
        defaultCity: ctx.config.defaultCity,
        categories: ctx.categories,
        categoryRotation: CATEGORY_ROTATION,
      }),
    },
    ...cityRoutes,
    ...poiRoutes,
    ...poisRoutes,
    ...tripsRoutes,
    ...notesRoutes,
    ...selectionRoutes,
    ...routeRoutes,
    ...authRoutes,
    ...homeRoutes,
    ...sharesRoutes,
    ...legacyRoutes,
    ...buddiesRoutes,
    ...backupRoutes,
  ];

  const routes = rawRoutes.map((r) => ({ ...r, ...compile(r.path) }));

  const baseCtx = {
    config,
    categories,
    db,
    cache,
    amap,
    HttpError,
    // 只在老测试里用：有些用例早于账号体系，写死一个假登录用户（生产永远不设）
    fallbackUser: opts.authFallbackUser === true ? { id: 1, username: 'tester', nickname: 'tester' } : null,
    // 笔记抓取（P5）：可注入（测试里换成假抓取器，不起浏览器）
    noteFetch: opts.noteFetch || require('./note-fetch'),
    // 笔记长任务（P10-⑩）：抓取/搜索的后台任务表（内存），可注入
    noteJobs: opts.noteJobs || createNoteJobs(opts.noteJobsOpts || {}),
    // 地名补全兜底（OSM/Photon，免 key）：高德没配额时用，可注入
    osm: opts.osm || require('./geocode-osm'),
    routeIntervalMs:
      opts.routeIntervalMs !== undefined
        ? Number(opts.routeIntervalMs) || 0
        : Number(process.env.ROUTE_LEG_INTERVAL_MS || 300),
    collectIntervalMs:
      opts.collectIntervalMs !== undefined
        ? Number(opts.collectIntervalMs) || 0
        : Number(process.env.COLLECT_INTERVAL_MS || 200),
    viewportRateLimiter:
      opts.viewportRateLimiter !== undefined
        ? opts.viewportRateLimiter
        : createRateLimiter({
            maxPerMin:
              Number(process.env.VIEWPORT_RATE_PER_MIN || DEFAULT_VIEWPORT_RATE_PER_MIN) ||
              DEFAULT_VIEWPORT_RATE_PER_MIN,
          }),
    // T9 R2：同一 (city,category) 单飞 + 作废旧 run
    viewportRuns: opts.viewportRuns || createViewportRunRegistry(),
    // 分享文件「在文件管理器里显示」：可注入（测试里换成假实现，别真弹 Finder）
    reveal: opts.reveal,
  };

  async function handleApi(req, res, ctx, method, pathname, query) {
    let pathMatched = false;
    for (const route of routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;

      const params = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      const callCtx = {
        ...ctx,
        req,
        res,
        method,
        pathname,
        query,
        params,
        cacheKey: `${method} ${pathname}?${new URLSearchParams(query).toString()}`,
      };
      try {
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
          callCtx.body = await readBody(req);
        } else {
          callCtx.body = {};
        }
        const data = await route.handler(callCtx);
        if (!res.writableEnded) sendOk(res, data === undefined ? null : data);
      } catch (err) {
        handleError(res, err);
      }
      return;
    }
    if (pathMatched) {
      sendErr(res, 405, 'METHOD_NOT_ALLOWED', `不支持的方法 ${method}`);
    } else {
      sendErr(res, 404, 'NOT_FOUND', `未找到接口 ${pathname}`);
    }
  }

  function handleError(res, err) {
    if (res.writableEnded) return;
    if (err instanceof HttpError) {
      sendErr(res, err.status, err.code, err.message);
      return;
    }
    if (err && err.code === 'AMAP_ERROR') {
      sendErr(res, 502, 'AMAP_ERROR', err.message);
      return;
    }
    console.error('[error]', err);
    sendErr(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
  }

  // 首页配图（静态地图缩略图）：文件在就直接发，不在就现生成一张（高德不可用就 404，页面自己退化成渐变底）
  async function serveHomeImg(res, pathname) {
    const rel = decodeURIComponent(pathname.slice('/home-img/'.length));
    const m = rel.match(/^(region|route)-(.+)\.png$/);
    if (!m) {
      sendErr(res, 404, 'NOT_FOUND', '图片不存在');
      return;
    }
    const [, kind, key] = m;
    let built = null;
    try {
      built =
        kind === 'region'
          ? await homeImg.ensureRegion({ amap, city: key })
          : await homeImg.ensureRoute({ amap, id: key });
    } catch (err) {
      built = null;
    }
    if (!built || !built.file) {
      sendErr(res, 404, 'NOT_FOUND', '这张图还没有（地图服务不可用或没有坐标）');
      return;
    }
    try {
      const buf = fs.readFileSync(built.file);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buf.length,
        // 不做强缓存：这些图会随精选库/坐标重生成，本地读一次文件几乎不花钱
        'Cache-Control': 'no-cache, must-revalidate',
      });
      res.end(buf);
    } catch (err) {
      sendErr(res, 404, 'NOT_FOUND', '图片读取失败');
    }
  }

  async function requestHandler(req, res) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = decodeURIComponent(u.pathname);
      const query = Object.fromEntries(u.searchParams.entries());
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, baseCtx, req.method, pathname, query);
      } else if (pathname.startsWith('/photo/')) {
        // 实景图（推荐路程 / 行程清单里用，拼在本机 data/featured-photos/）
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendErr(res, 405, 'METHOD_NOT_ALLOWED', '图片仅支持 GET/HEAD');
          return;
        }
        const dir = path.resolve(photos.dir());
        const full = path.resolve(dir, path.basename(pathname.slice('/photo/'.length)));
        if (path.dirname(full) !== dir || !fs.existsSync(full)) {
          sendErr(res, 404, 'NOT_FOUND', '这张图还没有');
          return;
        }
        serveStatic(req, res, pathname.slice('/photo'.length), dir);
      } else if (pathname.startsWith('/home-img/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendErr(res, 405, 'METHOD_NOT_ALLOWED', '图片仅支持 GET/HEAD');
          return;
        }
        await serveHomeImg(res, pathname);
      } else if (pathname.startsWith('/share/')) {
        // 行程分享包（P13）：生成出来的自包含 HTML，同一个服务里就能打开预览
        serveStatic(
          req,
          res,
          pathname.slice('/share'.length),
          process.env.TRAVEL_SHARE_DIR || path.join(ROOT, 'share')
        );
      } else if (pathname.startsWith('/notes-img/')) {
        // 笔记图片：本地缓存目录（data/notes-img），不放 web/ 代码目录
        serveStatic(
          req,
          res,
          pathname.slice('/notes-img'.length),
          process.env.TRAVEL_NOTE_IMG_DIR || path.join(ROOT, 'data', 'notes-img')
        );
      } else {
        serveStatic(req, res, pathname);
      }
    } catch (err) {
      handleError(res, err);
    }
  }

  const server = http.createServer(requestHandler);
  return { server, requestHandler, ctx: baseCtx, config, categories, db, cache, routes };
}

function start(overrides = {}) {
  const app = createApp(overrides);
  const { port } = app.config;
  // 默认只听本机；要给手机/同事看就 HOST=0.0.0.0（同网段可直接打开，数据仍要登录才看得到）
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => {
    console.log(`服务已启动: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
    if (host === '0.0.0.0') console.log(`同一 Wi-Fi 下也能开: http://<本机局域网IP>:${port}`);
  });
  return app;
}

if (require.main === module) {
  start();
}

module.exports = { createApp, start, sendOk, sendErr, HttpError };
