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

test('F3 删行程走 DELETE /api/trips/:id（API.deleteTrip）且二次确认', () => {
  assert.match(APP, /deleteTrip/, 'app.js 应调用 API.deleteTrip');
  assert.match(APP, /confirmDialog\(/, '删行程前应二次确认');
});

test('二次确认弹层存在（confirm-modal，页内可取证）', () => {
  assert.match(HTML, /id="confirm-modal"/, 'index 缺确认弹层');
  assert.match(APP, /function confirmDialog/, 'app.js 缺 confirmDialog');
});
