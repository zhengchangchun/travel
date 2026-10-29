#!/usr/bin/env python3.12
"""诊断：高德 POI 召回 —— 是"没登记"还是"我们没取到"？"""
import json, urllib.request, urllib.parse, time

KEY = json.load(open('/Users/zhengchangchun/Documents/travel/config/local.json'))['amap']['webServiceKey']
BASE = 'https://restapi.amap.com/v3'

def get(path, **params):
    params['key'] = KEY
    url = f'{BASE}{path}?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)

print('===== A. 关键词搜索：杭州 美食 =====')
a = get('/place/text', keywords='美食', city='杭州', offset=25, page=1, extensions='base')
print('总命中 count =', a.get('count'), '| 本页返回 =', len(a.get('pois', [])))

print()
print('===== B. 周边搜索：来福士周边 5km 内 餐饮服务(050000) =====')
b = get('/place/around', location='120.212943,30.24917', types='050000', radius=5000, offset=25, page=1, extensions='base')
print('总命中 count =', b.get('count'), '| 本页返回 =', len(b.get('pois', [])))

# 从 B 里挑 3 个"长尾"店（排序靠后），逐个拿去 A 的关键词搜索里找
names = [p['name'] for p in b.get('pois', [])][:5]
print()
print('===== C. 交叉验证：周边搜索到的店，能否被"关键词搜索"找到？ =====')
found, missing = 0, 0
for nm in names:
    time.sleep(0.35)
    r = get('/place/text', keywords=nm, city='杭州', offset=5, page=1, extensions='base')
    hit = [p['name'] for p in r.get('pois', [])]
    ok = any(nm[:6] in h for h in hit)
    print(f'  {"✅" if ok else "❌"} {nm[:24]:26s} 关键词搜索命中 {r.get("count")} 条 {hit[:2]}')
    found += ok; missing += (not ok)
print(f'  → 周边能拿到但关键词搜不到的: {missing}/{len(names)}')

print()
print('===== D. 深翻页：关键词搜索能翻多远？ =====')
for pg in (1, 2, 8, 20, 25):
    time.sleep(0.35)
    r = get('/place/text', keywords='美食', city='杭州', offset=25, page=pg, extensions='base')
    print(f'  page={pg:2d} 返回 {len(r.get("pois", [])):2d} 条  (count={r.get("count")})')
