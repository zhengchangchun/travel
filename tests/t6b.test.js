const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('web/index.html');
const APP = read('web/js/app.js');
const ITIN = read('web/js/itinerary.js');

test('F2 行程视图每项有删除按钮并回调 onRemove', () => {
  assert.match(ITIN, /onRemove/, 'itinerary.js 应接受 onRemove 回调');
  assert.match(ITIN, /class="del"/, 'itinerary.js 应渲染删除按钮');
});

test('F2 删点走 DELETE /api/pins/:id（API.deletePin）且二次确认', () => {
  assert.match(APP, /deletePin/, 'app.js 应调用 API.deletePin');
  assert.match(APP, /confirmDialog\(/, '删点前应二次确认');
});

test('F3 行程卡片有「删除行程」入口', () => {
  assert.match(HTML, /id="trip-delete-btn"/, 'index 缺删除行程按钮');
});

test('F3 删行程走后端 DELETE（只删当前这一趟）+ 二次确认', () => {
  // 2026-11-19：一城多趟之后改成只删当前这一趟，别的趟不受影响
  assert.match(APP, /API\.deleteTrip\(state\.tripId\)/, 'app.js 应只删当前这一趟');
  assert.ok(!/clearCityTrips/.test(APP), '不再整城删（会连带删掉同城别的趟）');
  assert.match(APP, /confirmDialog\(/, '删行程前应二次确认');
});

test('二次确认弹层存在（confirm-modal，页内可取证）', () => {
  assert.match(HTML, /id="confirm-modal"/, 'index 缺确认弹层');
  assert.match(APP, /function confirmDialog/, 'app.js 缺 confirmDialog');
});

test('F3 选中后同步行程守卫（state.trip 为空时拉取城市行程）', () => {
  assert.match(APP, /syncTripFromServer/, 'app.js 应同步城市行程守卫');
  assert.match(APP, /Selection\.subscribe/, '应在选中变更时同步');
});
