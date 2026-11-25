const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadConfig(root = ROOT) {
  const localPath = path.join(root, 'config', 'local.json');
  const examplePath = path.join(root, 'config', 'example.json');

  let filePath;
  if (fs.existsSync(localPath)) {
    filePath = localPath;
  } else if (fs.existsSync(examplePath)) {
    filePath = examplePath;
  } else {
    throw new Error(
      '缺少配置文件：请在 config/local.json 填写高德 key（可复制 config/example.json 作为模板）'
    );
  }

  const usingExample = filePath === examplePath;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`配置文件解析失败 (${filePath}): ${err.message}`);
  }

  if (usingExample) {
    console.error(
      '[config] 未找到 config/local.json，已回退到 config/example.json 占位配置。' +
        '请执行 cp config/example.json config/local.json 并填入高德 key。'
    );
  }

  const amap = raw.amap || {};
  // 多 key 轮换（2026-11-25）：高德配额是**按 key 按月**算的，一个 key 用尽就换下一个。
  // 配置两种写法都认：
  //   "webServiceKey": "k1"                      单 key（老写法，照旧能用）
  //   "webServiceKeys": ["k1", "k2", "k3"]      多 key（推荐）
  // 单 key 写法会自动包成数组，调用方只认数组。
  const keys = Array.isArray(amap.webServiceKeys)
    ? amap.webServiceKeys.map((k) => String(k || '').trim()).filter(Boolean)
    : [];
  const single = String(amap.webServiceKey || '').trim();
  if (single && !keys.includes(single)) keys.unshift(single);
  return {
    port: Number(process.env.PORT) || Number(raw.port) || 8787,
    amap: {
      // 第一个 key 仍叫 webServiceKey（兼容老调用点），全部 key 在 webServiceKeys
      webServiceKey: keys[0] || '',
      webServiceKeys: keys,
      jsApiKey: amap.jsApiKey || '',
      jsApiSecurityCode: amap.jsApiSecurityCode || '',
    },
    defaultCity: raw.defaultCity || '杭州',
    usingExample,
    filePath,
  };
}

function loadCategories(root = ROOT) {
  const filePath = path.join(root, 'config', 'categories.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return raw.categories || [];
}

module.exports = { loadConfig, loadCategories, ROOT };
