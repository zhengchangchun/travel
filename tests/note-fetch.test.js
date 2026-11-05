// P5 抓取器外壳（services/note-fetch.js）：命令拼装、stdout 解析、超时、B站接口路径
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  platformOfUrl,
  profileFor,
  runFetcher,
  fetchNote,
  searchNotes,
  fetchBilibili,
  SCRIPT,
  PW_CJS,
} = require('../server/note-fetch');

function fakeSpawn(lines, opts = {}) {
  const calls = [];
  const spawnImpl = (cmd, argv) => {
    calls.push({ cmd, argv });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (!opts.hang) {
      setTimeout(() => {
        lines.forEach((l) => child.stdout.emit('data', Buffer.from(l + '\n')));
        if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
        child.emit('close', opts.code === undefined ? 0 : opts.code);
      }, opts.delay || 0);
    }
    return child;
  };
  return { spawnImpl, calls };
}

test('platformOfUrl / profileFor：链接认平台，平台认 profile', () => {
  assert.strictEqual(platformOfUrl('https://www.xiaohongshu.com/explore/abc'), 'xhs');
  assert.strictEqual(platformOfUrl('http://xhslink.com/a/x'), 'xhs');
  assert.strictEqual(platformOfUrl('https://v.douyin.com/iJabc/'), 'douyin');
  assert.strictEqual(platformOfUrl('https://v.kuaishou.com/abc'), 'kuaishou');
  assert.strictEqual(platformOfUrl('https://b23.tv/abcdE'), 'bilibili');
  assert.strictEqual(platformOfUrl('https://example.com/x'), '');
  assert.strictEqual(profileFor('xhs'), 'xhs');
  assert.strictEqual(profileFor('douyin'), 'douyin');
  assert.strictEqual(profileFor('bilibili'), '', 'B站不用浏览器');
});

test('profileFor：可以用环境变量换 profile（换号/换登录态）', () => {
  process.env.TRAVEL_PROFILE_XHS = 'xhs-main';
  try {
    assert.strictEqual(profileFor('xhs'), 'xhs-main');
    assert.strictEqual(profileFor('douyin'), 'douyin', '没设的仍走默认');
    assert.strictEqual(profileFor(''), '');
  } finally {
    delete process.env.TRAVEL_PROFILE_XHS;
  }
  assert.strictEqual(profileFor('xhs'), 'xhs');
});

test('runFetcher：取最后一行 JSON 当结果（日志噪音不算）', async () => {
  const { spawnImpl, calls } = fakeSpawn(['some log', '{"ok":true,"platform":"xhs"}']);
  const r = await runFetcher(['--profile', 'xhs', 'url', 'xhs', 'https://x/1'], { spawnImpl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.platform, 'xhs');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].argv.includes(PW_CJS), '应跑 pw.cjs');
  assert.ok(calls[0].argv.includes(SCRIPT), '应跑仓内抓取脚本');
  assert.strictEqual(calls[0].cmd.indexOf('node') >= 0, true, '用绝对路径的 node 起（不走登录 shell）');
  assert.strictEqual(calls[0].argv[1], 'run');
  assert.deepStrictEqual(calls[0].argv.slice(-3), ['url', 'xhs', 'https://x/1']);
});

test('runFetcher：超时如实报 TIMEOUT（不挂死）', async () => {
  const { spawnImpl } = fakeSpawn([], { hang: true });
  const r = await runFetcher(['--profile', 'xhs', 'url', 'xhs', 'u'], {
    spawnImpl,
    timeoutMs: 40,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'TIMEOUT');
});

test('runFetcher：没吐出 JSON ⇒ FETCH_FAIL（带 stderr 片段）', async () => {
  const { spawnImpl } = fakeSpawn(['no json here'], { stderr: 'boom: something broke' });
  const r = await runFetcher(['x'], { spawnImpl });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'FETCH_FAIL');
  assert.match(r.message, /boom/);
});

test('fetchNote：小红书/抖音走浏览器并带上平台 profile；不认识的域名直接拒', async () => {
  const { spawnImpl, calls } = fakeSpawn(['{"ok":true,"platform":"douyin"}']);
  const r = await fetchNote({ url: 'https://www.douyin.com/video/123', spawnImpl });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls[0].argv.slice(3, 7), ['--profile', 'douyin', 'url', 'douyin']);
  const bad = await fetchNote({ url: 'https://example.com/a', spawnImpl });
  assert.strictEqual(bad.error, 'BAD_PLATFORM');
  const empty = await fetchNote({ spawnImpl });
  assert.strictEqual(empty.error, 'BAD_REQUEST');
});

test('fetchNote：瞬挂（TIMEOUT/FETCH_FAIL）自动重试一次（profile 被占时常见）', async () => {
  let n = 0;
  const spawnImpl = (cmd, argv) => {
    n += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (n === 1) child.stdout.emit('data', Buffer.from('{"ok":false,"error":"FETCH_FAIL","message":"瞬挂"}\n'));
      else child.stdout.emit('data', Buffer.from('{"ok":true,"platform":"xhs"}\n'));
      child.emit('close', 0);
    }, 0);
    return child;
  };
  const r = await fetchNote({ url: 'https://www.xiaohongshu.com/explore/abc', spawnImpl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, 2, '失败后应重试一次');
  const hard = await fetchNote({
    url: 'https://www.xiaohongshu.com/explore/abc',
    spawnImpl: (cmd, argv) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('{"ok":false,"error":"NEED_LOGIN","message":"要登录"}\n'));
        child.emit('close', 0);
      }, 0);
      return child;
    },
  });
  assert.strictEqual(hard.error, 'NEED_LOGIN', '要登录这种不该重试（重试也没用）');
});

test('searchNotes：关键词搜（目前只放小红书），平台/profile 传对', async () => {
  const { spawnImpl, calls } = fakeSpawn(['{"ok":true,"items":[]}']);
  const r = await searchNotes({ platform: 'xhs', keyword: '杭州咖啡', limit: 5, spawnImpl });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls[0].argv.slice(3, 7), ['--profile', 'xhs', 'search', 'xhs']);
  assert.strictEqual(calls[0].argv[7], '杭州咖啡');
  assert.strictEqual(calls[0].argv[8], '5');
  const ks = await searchNotes({ platform: 'kuaishou', keyword: 'x', spawnImpl });
  assert.strictEqual(ks.ok, true, '快手也走同一条命令（抓取脚本里会如实报未实现/未登录）');
  const noKw = await searchNotes({ platform: 'xhs', keyword: '' });
  assert.strictEqual(noKw.error, 'BAD_REQUEST');
});

test('fetchBilibili：官方接口就能拿（BV 号 / 字段归一 / 失败如实报）', async () => {
  const fakeFetch = async (url, opts) => {
    assert.match(url, /bvid=BV1GJ411x7h7/);
    assert.match(opts.headers.Referer, /bilibili/);
    return {
      json: async () => ({
        code: 0,
        data: {
          bvid: 'BV1GJ411x7h7',
          title: '标题',
          desc: '简介',
          pic: 'https://i0.hdslb.com/x.jpg',
          owner: { name: 'UP 主' },
          tname: '生活',
          stat: { like: 10, reply: 2, share: 1, view: 100 },
        },
      }),
    };
  };
  const r = await fetchBilibili('https://www.bilibili.com/video/BV1GJ411x7h7', { fetchImpl: fakeFetch });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'video');
  assert.strictEqual(r.title, '标题');
  assert.strictEqual(r.author, 'UP 主');
  assert.strictEqual(r.cover_url, 'https://i0.hdslb.com/x.jpg');
  assert.strictEqual(r.stats.view, 100);

  const noBv = await fetchBilibili('https://www.bilibili.com/', { fetchImpl: fakeFetch });
  assert.strictEqual(noBv.error, 'BAD_REQUEST');

  const badJson = await fetchBilibili('https://www.bilibili.com/video/BV1GJ411x7h7', {
    fetchImpl: async () => ({ json: async () => ({ code: -404, message: '啥都木有' }) }),
  });
  assert.strictEqual(badJson.error, 'NO_DATA');
  assert.match(badJson.message, /啥都木有/);
});
