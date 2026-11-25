/* 营业时间解析 + 时段冲突判定（2026-11-25）
   高德返回的营业时间是自由文本，形态极不统一；这里只做两件事：
     ① 抽成时间区间（分钟），再和「上午/下午/傍晚/晚上」四个窗口求交
     ② 周一闭馆这类信息单独提示，不参与冲突判定（行程里没有具体日期，判不了周几）
   口径：解析不出来 ⇒ unknown，**不报警**（宁可不提示，也不能瞎提示）。 */
const test = require('node:test');
const assert = require('node:assert');

const hours = require('../server/hours');

// ---------- 解析 ----------

test('parseRanges：单段 / 午休两段 / 跨零点 / 各种分隔符', () => {
  assert.deepStrictEqual(
    hours.parseRanges('07:30-18:00').map((r) => [r.start, r.end]),
    [[450, 1080]]
  );
  assert.deepStrictEqual(
    hours.parseRanges('10:30-14:00,16:30-20:30').map((r) => [r.start, r.end]),
    [[630, 840], [990, 1230]]
  );
  // 跨零点拆两段（先凌晨那段、再深夜那段 —— 顺序不影响求交，但断言要写对）
  const cross = hours.parseRanges('22:00-02:00').map((r) => [r.start, r.end]);
  assert.deepStrictEqual(cross, [[0, 120], [1320, 1440]]);
  // 分隔符：- – — ~ 至
  ['09:00-17:00', '09:00–17:00', '09:00—17:00', '09:00~17:00', '09:00至17:00'].forEach((s) => {
    assert.strictEqual(hours.parseRanges(s).length, 1, s + ' 应解析出一段');
  });
});

test('isAllDay：24小时 / 全天营业 / 00:00-24:00', () => {
  assert.strictEqual(hours.isAllDay('24小时营业'), true);
  assert.strictEqual(hours.isAllDay('全天营业'), true);
  assert.strictEqual(hours.isAllDay('周一至周日 00:00-24:00'), true);
  assert.strictEqual(hours.isAllDay('07:30-18:00'), false);
  assert.strictEqual(hours.isAllDay(''), false);
});

test('parseClosedWeekdays：只认「周一 全天不开放」这种明确写法', () => {
  assert.deepStrictEqual(hours.parseClosedWeekdays('周一 全天不开放'), [1]);
  assert.deepStrictEqual(
    hours.parseClosedWeekdays('周二至周日 09:00-17:00开放； 周一 全天不开放(遇法定节假日正常开放)'),
    [1]
  );
  // 只是提到周一但没说闭馆 ⇒ 不算
  assert.deepStrictEqual(hours.parseClosedWeekdays('周一至周日 07:30-18:00'), []);
  assert.deepStrictEqual(hours.parseClosedWeekdays(''), []);
});

// ---------- 时段判定 ----------

test('灵隐寺 07:30-18:00：上午/下午/傍晚能去，晚上不行', () => {
  const v = hours.slotVerdicts('周一至周日 07:30-18:00');
  assert.strictEqual(v.morning.status, 'ok');
  assert.strictEqual(v.afternoon.status, 'ok');
  assert.strictEqual(v.evening.status, 'ok');
  assert.strictEqual(v.night.status, 'conflict');
  assert.match(v.night.reason, /晚上不开门/);
  assert.match(v.night.reason, /07:30–18:00/, '文案要用原文的时间');
});

test('楼外楼 10:30-14:00,16:30-20:30：四段都能去（午休不影响时段判定）', () => {
  const v = hours.slotVerdicts('周一至周日 10:30-14:00,16:30-20:30');
  ['morning', 'afternoon', 'evening', 'night'].forEach((k) => {
    assert.strictEqual(v[k].status, 'ok', k + ' 应能去');
  });
});

test('浙博 09:00-17:00：傍晚与晚上都不行，且周一闭馆单独提示', () => {
  const text = '周二至周日 09:00-17:00开放 最晚进入16:30； 周一 全天不开放(遇法定节假日正常开放)';
  const v = hours.slotVerdicts(text);
  assert.strictEqual(v.morning.status, 'ok');
  assert.strictEqual(v.afternoon.status, 'ok');
  assert.strictEqual(v.evening.status, 'conflict');
  assert.strictEqual(v.night.status, 'conflict');
  assert.deepStrictEqual(hours.parseClosedWeekdays(text), [1]);
});

test('24 小时：四段全 ok', () => {
  const v = hours.slotVerdicts('24小时营业');
  ['morning', 'afternoon', 'evening', 'night'].forEach((k) => {
    assert.strictEqual(v[k].status, 'ok');
  });
});

test('解析不出来 ⇒ unknown，不报警（宁可不提示也不能瞎提示）', () => {
  ['', null, undefined, '营业时间以现场为准', '详情咨询商家'].forEach((t) => {
    const v = hours.slotVerdicts(t);
    ['morning', 'afternoon', 'evening', 'night'].forEach((k) => {
      assert.strictEqual(v[k].status, 'unknown', JSON.stringify(t) + ' 的 ' + k + ' 应是 unknown');
      assert.strictEqual(v[k].reason, '', 'unknown 不该给理由（会像在报警）');
    });
  });
});

test('时段窗口首尾相接不重叠：12:00 只算下午，17:00 只算傍晚', () => {
  const w = hours.SLOT_WINDOWS;
  assert.strictEqual(w.morning.end, w.afternoon.start);
  assert.strictEqual(w.afternoon.end, w.evening.start);
  assert.strictEqual(w.evening.end, w.night.start);
  assert.strictEqual(w.night.end, 24 * 60);
});

test('只开上午的店：下午/傍晚/晚上都判冲突', () => {
  const v = hours.slotVerdicts('08:00-11:30');
  assert.strictEqual(v.morning.status, 'ok');
  assert.strictEqual(v.afternoon.status, 'conflict');
  assert.strictEqual(v.evening.status, 'conflict');
  assert.strictEqual(v.night.status, 'conflict');
});

// ---------- 接口接线 ----------

test('/api/poi/business 把时段判定一起返回（前端不用再解析自由文本）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'poi.js'), 'utf8');
  const block = src.match(/path: '\/api\/poi\/business'[\s\S]*?\n  \},/);
  assert.ok(block, '缺 /api/poi/business');
  assert.match(block[0], /hours\.slotVerdicts\(/, '要算时段判定');
  assert.match(block[0], /closedWeekdays/, '要带闭馆日');
  assert.match(block[0], /allDay/, '要带是否全天');
});
