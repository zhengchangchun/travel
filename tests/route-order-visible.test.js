/* 「路线要合理 + 地图上能看出先后顺序」（2026-11-19）
   用户原话：「规划的路线不是很合理，没有先后顺序」
   ① 排序不再只是「每次去最近的一站」：最近邻之后再走一轮 2-opt，把「先跑到最东边再横穿回最西边」这类回头路减掉
   ② 地图上的点带站号（第 1 站…第 N 站），旗子与远看的小圆点都要带
   ③ 成功的那几段连线画方向箭头（showDir），先后顺序在地图上直接看得见 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Planner = require('../web/js/planner');
const Geo = require('../web/js/geo');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MAP = read('web/js/map.js');
const APP = read('web/js/app.js');
const CSS = read('web/css/style.css');

// 三亚九个点（用户 2026-11-17 那条行程，坐标取自真库 pins 表）
const SANYA = [
  ['三亚湾', 109.4642, 18.2826],
  ['第一市场', 109.5088, 18.2383],
  ['鹿回头', 109.4984, 18.2272],
  ['大东海', 109.5176, 18.2186],
  ['亚龙湾', 109.6242, 18.2244],
  ['亚龙湾热带天堂森林公园', 109.6212, 18.2502],
  ['蜈支洲岛', 109.7618, 18.3114],
  ['天涯海角', 109.345, 18.2926],
  ['南山文化旅游区', 109.2066, 18.3001],
].map(([name, lng, lat]) => ({ id: name, name, lng, lat }));

// 旧口径（纯最近邻）——只用来做对照，不进产品代码
function greedy(stops, start) {
  const rest = stops.slice();
  const out = [];
  let from = start || rest[0];
  while (rest.length) {
    let bi = 0;
    let bd = Infinity;
    rest.forEach((p, i) => {
      const d = Geo.distanceM(from, p);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const pick = rest.splice(bi, 1)[0];
    out.push(pick);
    from = pick;
  }
  return out;
}

const names = (list) => list.map((p) => p.name);

test('排序：起点固定不动，返回的点一个都不少', () => {
  const order = Planner.orderStops(SANYA);
  assert.equal(order.length, SANYA.length);
  assert.equal(order[0].name, '三亚湾', '出发点（第一个点）不能被换到别处');
  assert.deepEqual([...new Set(names(order))].sort(), [...new Set(names(SANYA))].sort());
});

test('排序：三亚这条不再「先跑到最东边、再横穿回最西边」', () => {
  const order = Planner.orderStops(SANYA);
  const dist = Planner.pathDistance(order).distanceM;
  const greedyDist = Planner.pathDistance(greedy(SANYA)).distanceM;
  assert.ok(dist < greedyDist, `2-opt 之后应更短：${dist} vs ${greedyDist}`);
  // 旧顺序会在末尾从蜈支洲岛（最东）折回天涯海角/南山（最西），新顺序把它去掉了
  const last = order[order.length - 1].name;
  assert.equal(last, '蜈支洲岛', '东端的岛应该排在最后，而不是折回来再往西走');
  assert.ok(order.indexOf(order.find((p) => p.name === '天涯海角')) < 3, '西线要早点去，别留到最后');
});

test('排序：2-opt 只认严格变短，同一输入永远同一结果', () => {
  const start = SANYA[0]; // 起点给死，输入顺序打乱也不该换结果
  const a = names(Planner.orderStops(SANYA, { start }));
  const b = names(Planner.orderStops(SANYA.slice().reverse(), { start }));
  assert.deepEqual(a, b, '输入顺序不同也应给同一结果');
  const once = Planner.pathDistance(Planner.orderStops(SANYA)).distanceM;
  const twice = Planner.pathDistance(Planner.orderStops(Planner.orderStops(SANYA))).distanceM;
  assert.equal(twice, once, '再排一遍不该变（幂等）');
});

test('排序：点少 / 坐标无效时行为不变', () => {
  const bad = [{ id: 'X', name: '无坐标', lng: null, lat: 1 }];
  const order = Planner.orderStops(SANYA.concat(bad));
  assert.equal(order[order.length - 1].name, '无坐标', '无效坐标的点仍附在末尾');
  assert.deepEqual(names(Planner.orderStops(SANYA.slice(0, 2))), ['三亚湾', '第一市场']);
});

test('planner 暴露出 twoOpt；orderStops 走它', () => {
  assert.equal(typeof Planner.twoOpt, 'function');
  assert.match(read('web/js/planner.js'), /return twoOpt\(out, 8\)\.concat\(invalid\)/);
});

test('地图：旗子与远看的小圆点都带站号', () => {
  assert.match(MAP, /flag-no/, '旗子缺站号角标');
  assert.match(MAP, /poi-dot-no/, '圆点缺站号');
  assert.match(MAP, /has-no/, '两处都要有 has-no 样式类');
  assert.match(MAP, /第 ' \+ no \+ ' 站/, '悬停说明要写「第 N 站」');
});

test('地图：站号跟着当前路线走，顺序没变就不重画', () => {
  assert.match(MAP, /function setOrder\(pins\)/, 'setOrder 要能收到「眼前这条路线」');
  assert.match(MAP, /if \(sig === orderSig\) return 0/, '顺序没变时不重画（避免闪）');
  assert.match(MAP, /setContent\(contentFor\(/, '顺序变了就地换内容，不整屏重画');
  assert.match(MAP, /orderCount/, '要能读出现在有几个点带站号');
});

test('地图：站号表按 poi 键对齐，锚点也跟着挪', () => {
  assert.match(MAP, /orderNos\.set\(k, i \+ 1\)/, '序号从 1 开始');
  assert.match(MAP, /return orderNo\(poi\) \? new AMap\.Pixel\(-10, -10\) : new AMap\.Pixel\(-6, -6\)/);
});

test('地图：成功的段画方向箭头（先后顺序看得见）', () => {
  assert.match(MAP, /showDir: !failed/, '连线要有方向箭头；规划失败的段不必画');
});

test('页面：两张清单每画一次都把顺序交给地图', () => {
  assert.match(APP, /function syncOrderToMap\(\)/, '缺 syncOrderToMap');
  assert.match(APP, /MapCtl\.setOrder\(orderedPins\(\)\)/);
  const calls = APP.match(/syncOrderToMap\(\)/g) || [];
  assert.ok(calls.length >= 4, `挑点 / 行程 / 落点前都要调：只看到 ${calls.length} 处`);
  assert.match(APP, /renderMap[\s\S]{0,120}syncOrderToMap\(\);/, '落点之前先编号，新画的点直接带站号');
});

test('CSS：站号角标与小圆点数字都有样式', () => {
  assert.match(CSS, /\.flag-no \{/, '缺 flag-no 样式');
  assert.match(CSS, /\.poi-dot\.has-no \{/, '缺带号圆点的尺寸');
  assert.match(CSS, /\.poi-dot-no \{/, '缺圆点里的数字样式');
});
