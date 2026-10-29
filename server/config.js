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
  return {
    port: Number(process.env.PORT) || Number(raw.port) || 8787,
    amap: {
      webServiceKey: amap.webServiceKey || '',
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
