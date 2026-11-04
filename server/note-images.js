// 笔记图片本地化：把平台图 URL 下载到 data/notes-img/，库里只存文件名（幂等，同 URL 复用）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};
const ALL_EXTS = ['.jpg', '.png', '.webp', '.gif', '.avif'];

function extFor(contentType, url) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct];
  const m = String(url || '').match(/\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i);
  if (!m) return '.jpg';
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? '.jpg' : '.' + e;
}

function nameFor(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
}

// 图片常有防盗链：带上来路（同源）
function refererFor(url) {
  try {
    return new URL(url).origin + '/';
  } catch (err) {
    return undefined;
  }
}

// 下载一张图；返回 { file, bytes, cached }（file 只是文件名，调用方负责拼访问路径）
async function downloadImage(url, dir, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const name = nameFor(url);
  for (const ext of ALL_EXTS) {
    const p = path.join(dir, name + ext);
    if (fs.existsSync(p)) return { file: name + ext, bytes: fs.statSync(p).size, cached: true };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const ref = refererFor(url);
    const res = await fetchImpl(url, {
      headers: Object.assign({ 'User-Agent': UA }, ref ? { Referer: ref } : {}),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('空响应');
    const ext = extFor(res.headers && res.headers.get ? res.headers.get('content-type') : '', url);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + ext), buf);
    return { file: name + ext, bytes: buf.length, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

// 批量下载：单张失败不影响其余，逐张如实回报
async function downloadImages(urls, dir, opts) {
  const out = [];
  for (const u of urls || []) {
    const url = String(u || '').trim();
    if (!url) continue;
    try {
      const r = await downloadImage(url, dir, opts);
      out.push({ url, ok: true, ...r });
    } catch (err) {
      out.push({ url, ok: false, error: (err && err.message) || String(err) });
    }
  }
  return out;
}

module.exports = { downloadImage, downloadImages, extFor, nameFor, UA, ALL_EXTS };
