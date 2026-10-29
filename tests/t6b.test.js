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
  assert.match(APP, /window\.confirm\(/, '删点前应二次确认');
});
