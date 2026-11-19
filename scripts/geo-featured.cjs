#!/usr/bin/env node
'use strict';
/*
 * 给首页的推荐内容配图做坐标底稿：把 config/featured.json 里的
 *   ① 每个推荐地区的城市中心
 *   ② 每条推荐路线的每一站
 * 用高德正地理编码查一次，结果落 config/featured-geo.json（真源，可重跑增量补）。
 *
 * 为什么要单独一份：推荐路线的公开载荷里不带坐标（用户 2026-11-19 定的只浏览口径），
 * 但首页缩略图要真坐标才画得对 —— 这份文件只在服务端用。
 *
 * 用法：node scripts/geo-featured.cjs [--force]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FEATURED = path.join(ROOT, 'config', 'featured.json');
const LOCAL = path.join(ROOT, 'config', 'local.json');
const OUT = path.join(ROOT, 'config', 'featured-geo.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 有些点用全名（诗名/简称）查不到，换个更常见的叫法再查一次
const ALIASES = {
  '苏堤春晓': '苏堤',
  '九溪十八涧': '九溪烟树',
  '大东海': '大东海旅游区',
  '亚龙湾': '亚龙湾国家旅游度假区',
  '天涯海角': '天涯海角游览区',
  '南山文化旅游区': '南山寺',
};

function amapKey() {
  const cfg = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  const key = cfg && cfg.amap && (cfg.amap.webServiceKey || cfg.amap.key);
  if (!key) throw new Error('config/local.json 里没有 amap.webServiceKey');
  return key;
}

async function geocode(key, address, city) {
  const url =
    'https://restapi.amap.com/v3/geocode/geo?key=' +
    encodeURIComponent(key) +
    '&address=' +
    encodeURIComponent(address) +
    (city ? '&city=' + encodeURIComponent(city) : '');
  const res = await fetch(url);
  const json = await res.json();
  const g = json && Array.isArray(json.geocodes) ? json.geocodes[0] : null;
  if (!g || !g.location) return null;
  const [lng, lat] = String(g.location).split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return {
    lng: Number(lng.toFixed(6)),
    lat: Number(lat.toFixed(6)),
    level: g.level || '',
    adcode: g.adcode || '',
    formatted: g.formatted_address || '',
  };
}

async function main() {
  const force = process.argv.includes('--force');
  const key = amapKey();
  const featured = JSON.parse(fs.readFileSync(FEATURED, 'utf8'));
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const out = {
    generatedAt: prev.generatedAt || null,
    note: '首页配图用的坐标底稿：只在服务端用（推荐路线的公开载荷里不带坐标）',
    cities: force ? {} : { ...(prev.cities || {}) },
    routes: force ? {} : { ...(prev.routes || {}) },
  };

  let calls = 0;
  let miss = 0;

  for (const r of featured.regions || []) {
    if (out.cities[r.city]) continue;
    const hit = await geocode(key, r.city, r.city);
    calls += 1;
    if (hit) {
      out.cities[r.city] = { lng: hit.lng, lat: hit.lat, adcode: hit.adcode };
      console.log('城市 ' + r.city + ' → ' + hit.lng + ',' + hit.lat + '（' + hit.level + '）');
    } else {
      miss += 1;
      console.log('城市 ' + r.city + ' 没查到');
    }
    await sleep(260);
  }

  for (const rt of featured.routes || []) {
    const have = out.routes[rt.id];
    // 已有一份且每一站都有坐标 ⇒ 不用再查；缺的（含换别名后新查到的）就补一条
    if (have && have.length && have.every((s) => Number.isFinite(s.lng))) continue;
    const city = rt.city;
    const stops = (rt.stops || []).map((s, i) => {
      const cached = have && have[i] && Number.isFinite(have[i].lng) ? have[i] : null;
      return cached ? { name: s.name, lng: cached.lng, lat: cached.lat, level: cached.level || '' } : { name: s.name, lng: null, lat: null };
    });
    for (let i = 0; i < stops.length; i += 1) {
      if (Number.isFinite(stops[i].lng)) continue;
      const name = (rt.stops || [])[i].name;
      const tries = [name];
      if (ALIASES[name]) tries.push(ALIASES[name]);
      let hit = null;
      for (const t of tries) {
        hit = await geocode(key, t, city);
        calls += 1;
        if (hit) break;
        await sleep(260);
      }
      if (hit) {
        stops[i] = { name, lng: hit.lng, lat: hit.lat, level: hit.level };
        console.log('  ' + rt.id + ' · ' + name + ' → ' + hit.lng + ',' + hit.lat);
      } else {
        stops[i] = { name, lng: null, lat: null };
        miss += 1;
        console.log('  ' + rt.id + ' · ' + name + ' 还是没查到');
      }
      await sleep(260);
    }
    out.routes[rt.id] = stops;
  }

  out.generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const ok = Object.values(out.routes).reduce(
    (n, list) => n + list.filter((s) => Number.isFinite(s.lng)).length,
    0
  );
  console.log('完成：' + calls + ' 次地理编码（查不到 ' + miss + ' 个），可用站点坐标 ' + ok + ' 个 → ' + OUT);
}

main().catch((err) => {
  console.error('失败：' + (err && err.message));
  process.exit(1);
});
