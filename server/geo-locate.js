'use strict';
/*
 * 「当前在哪」：把一个坐标（或本机 IP）翻译成城市。
 *   - 给了坐标（浏览器定位）→ 高德逆地理编码，拿省/市/区
 *   - 没给坐标 → 高德 IP 定位（本机上就是这台机器所在的城市，够首页默认用）
 *   - 两条都失败 → city 为 null，交给页面回退默认城市
 *
 * 城市名统一成「去掉末尾的市」的短名（杭州 / 三亚），与库里 trips.city、地区精选库一致。
 */

const amapDefault = require('./amap');

// 可以注入一个假的高德（测试用）；默认就是项目里的 amap 模块
function clientOf(client) {
  return client && typeof client.amapGet === 'function' ? client : amapDefault;
}

function firstString(value) {
  if (Array.isArray(value)) {
    const found = value.find((v) => v != null && String(v).trim() !== '');
    return found == null ? '' : String(found);
  }
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

// 「杭州市」→「杭州」；「大理白族自治州」→「大理」；空值原样返回
function shortCity(name) {
  let s = firstString(name).trim();
  if (!s) return '';
  s = s.replace(/(特别行政区|自治州|地区|盟)$/, '');
  const m = s.match(/^(.+?)(市|县|区)$/);
  if (m && m[1]) s = m[1];
  return s;
}

async function locateByCoord({ lng, lat, client } = {}) {
  const amap = clientOf(client);
  const json = await amap.amapGet('/v3/geocode/regeo', {
    location: `${Number(lng)},${Number(lat)}`,
    extensions: 'base',
    radius: 1000,
  });
  const r = json && json.regeocode;
  if (!r) return null;
  const ac = r.addressComponent || {};
  const city = shortCity(ac.city) || shortCity(ac.province);
  if (!city) return null;
  return {
    city,
    cityFull: firstString(ac.city),
    district: firstString(ac.district),
    province: firstString(ac.province),
    adcode: firstString(ac.adcode),
    address: firstString(r.formatted_address),
    source: 'browser',
  };
}

async function locateByIp(client) {
  const amap = clientOf(client);
  const json = await amap.amapGet('/v3/ip', {});
  const city = shortCity(json && json.city);
  if (!city) return null;
  return {
    city,
    cityFull: firstString(json.city),
    district: '',
    province: firstString(json.province),
    adcode: firstString(json.adcode),
    address: [firstString(json.province), firstString(json.city)].filter(Boolean).join(' '),
    rectangle: firstString(json.rectangle),
    source: 'ip',
  };
}

// 先按坐标认（准），坐标没给或认不出来就退 IP（粗）；再不行返回 { city:null }
async function locate({ lng, lat, client } = {}) {
  const hasCoord = Number.isFinite(Number(lng)) && Number.isFinite(Number(lat));
  if (hasCoord) {
    try {
      const byCoord = await locateByCoord({ lng: Number(lng), lat: Number(lat), client });
      if (byCoord) return byCoord;
    } catch (err) {
      /* 逆地理失败：往下退 IP */
    }
  }
  try {
    const byIp = await locateByIp(client);
    if (byIp) return byIp;
  } catch (err) {
    /* IP 定位也失败：交给页面回退 */
  }
  return { city: '', cityFull: '', district: '', province: '', adcode: '', address: '', source: 'fallback' };
}

module.exports = { locate, locateByCoord, locateByIp, shortCity };
