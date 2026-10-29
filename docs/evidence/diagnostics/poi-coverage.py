#!/usr/bin/env python3.12
"""诊断2：城市级搜索(200上限) vs 按点周边搜索 —— 覆盖差多少？"""
import json, urllib.request, urllib.parse, time

KEY = json.load(open('/Users/zhengchangchun/Documents/travel/config/local.json'))['amap']['webServiceKey']
BASE = 'https://restapi.amap.com/v3'

def get(path, **params):
    params['key'] = KEY
    url = f'{BASE}{path}?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)

# 1) 城市级搜索：把"美食"能拿到的全拿（上限 200）
city_names = []
for pg in range(1, 9):
    time.sleep(0.35)
    r = get('/place/text', keywords='美食', city='杭州', offset=25, page=pg, extensions='base')
    city_names += [(p['name'], p['id']) for p in r.get('pois', [])]
city_ids = {i for _, i in city_names}
print(f'城市级「美食」搜索拿到: {len(city_names)} 条（去重 id {len(city_ids)}）')

# 2) 三处按点周边搜（模拟"顺着视野分片搜"）
spots = [('来福士', '120.212943,30.24917'), ('西湖', '120.155070,30.274150'), ('火车东站', '120.212600,30.290500')]
all_near, missing_total = [], []
for label, loc in spots:
    time.sleep(0.35)
    r = get('/place/around', location=loc, types='050000', radius=1000, offset=25, page=1, extensions='base')
    pois = r.get('pois', [])
    miss = [(p['name'], p['id']) for p in pois if p['id'] not in city_ids]
    all_near += pois
    missing_total += miss
    print(f'  {label}: 周边 25 条，其中【城市级搜索里没有】的: {len(miss)}')
    for n, _ in miss[:4]:
        print(f'      ✳ {n}')

uniq_missing = {i: n for n, i in missing_total}
print()
print(f'合计：周边搜到、城市级搜索拿不到的店 = {len(uniq_missing)} 家')
print(f'（城市级只能拿 {len(city_names)} 条，杭州餐饮实际有 count≈600+ 家，长尾小店铺根本排不进来）')
