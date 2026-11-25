/* 最近去哪便宜（2026-11-25）
   从杭州出发，看未来一段时间各目的地哪天最便宜。
   价格只在服务端内存里放 30 分钟，不落盘 —— 页面要如实标「多久前抓的」。 */
(function () {
  const Site = window.TravelSite;
  const $ = (id) => document.getElementById(id);
  const esc = Site.esc;

  const state = { data: null, busy: false };

  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return iso || '';
    return Number(m[2]) + '月' + Number(m[3]) + '日';
  }

  function weekday(iso) {
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '';
    return '周' + '日一二三四五六'[d.getDay()];
  }

  function ageText(sec) {
    if (sec == null) return '';
    if (sec < 60) return '刚刚抓的';
    if (sec < 3600) return Math.round(sec / 60) + ' 分钟前抓的';
    return Math.round(sec / 3600) + ' 小时前抓的';
  }

  function metaText(d) {
    const bits = [];
    bits.push('出发：' + (d.origin && d.origin.city ? d.origin.city : '杭州'));
    bits.push('看 ' + d.windowDays + ' 天内 · 玩 ' + d.span + ' 天');
    if (d.cached) bits.push(ageText(d.ageSeconds) + '（缓存 ' + Math.round(d.ttlSeconds / 60) + ' 分钟）');
    else bits.push('刚抓的');
    if (d.stale) bits.push('⚠ 这次没抓成功，下面是上次的价');
    return bits.join(' · ');
  }

  function card(item, rank) {
    const best = item.best;
    const lowLine = best
      ? '<div class="fare-best">' +
        '<span class="fare-best-label">最便宜的 ' + best.days + ' 天</span>' +
        '<b class="fare-best-date">' + esc(fmtDate(best.start)) + ' – ' + esc(fmtDate(best.end)) + '</b>' +
        '<span class="fare-best-avg">均价 ¥' + best.avg + '/天</span>' +
        '</div>'
      : '<div class="fare-best"><span class="fare-best-label">窗口内最低</span>' +
        '<b class="fare-best-date">' + esc(fmtDate(item.lowDate)) + '</b>' +
        '<span class="fare-best-avg">¥' + item.low + '</span></div>';

    const saving =
      item.savingPct >= 8
        ? '<span class="fare-saving" title="比这段时间的中位价便宜">比平时便宜 ' + item.savingPct + '%</span>'
        : '';

    return (
      '<div class="card fare-card">' +
      '<div class="fare-head">' +
      '<span class="fare-rank">' + rank + '</span>' +
      '<b class="fare-city">' + esc(item.city) + '</b>' +
      saving +
      '</div>' +
      lowLine +
      '<div class="fare-foot">' +
      '<span class="fare-low">最低单日 ¥' + item.low + '（' + esc(fmtDate(item.lowDate)) + ' ' + weekday(item.lowDate) + '）</span>' +
      '<a class="btn small" href="https://www.ly.com/flights/itinerary/oneway/HGH-' +
      encodeURIComponent(airportOf(item.city)) +
      '?date=' + encodeURIComponent(best ? best.start : item.lowDate) +
      '" target="_blank" rel="noreferrer">去同程看</a>' +
      '</div>' +
      '</div>'
    );
  }

  // 城市 → 机场码（与 server/fares.js 的 DESTINATIONS 对齐；这里只用于拼链接）
  const AIRPORT = {
    三亚: 'SYX', 厦门: 'XMN', 成都: 'CTU', 重庆: 'CKG', 昆明: 'KMG',
    西安: 'XIY', 长沙: 'CSX', 青岛: 'TAO', 大连: 'DLC', 沈阳: 'SHE',
  };
  function airportOf(city) {
    return AIRPORT[city] || '';
  }

  function render() {
    const box = $('main');
    const d = state.data;
    if (!d) return;
    $('fr-meta').textContent = metaText(d);
    if (!d.destinations || !d.destinations.length) {
      box.innerHTML = '<div class="empty-box">这次没抓到价格，点「刷新价格」再试一次</div>';
      return;
    }
    const cards = d.destinations.map((it, i) => card(it, i + 1)).join('');
    const missing =
      d.missing && d.missing.length
        ? '<p class="hint" style="margin-top:14px">这次没抓到：' + d.missing.map(esc).join('、') + '</p>'
        : '';
    box.innerHTML =
      '<div class="fare-grid">' + cards + '</div>' +
      '<p class="hint" style="margin-top:16px">' + esc(d.note || '') + '</p>' +
      missing;
  }

  async function load(force) {
    if (state.busy) return;
    state.busy = true;
    const msg = $('fr-msg');
    msg.className = 'form-msg';
    msg.textContent = force ? '正在抓价格（要开浏览器，约 1–2 分钟）…' : '读取中…';
    try {
      const windowDays = $('fr-window').value;
      const span = $('fr-span').value;
      const qs = '?windowDays=' + encodeURIComponent(windowDays) + '&span=' + encodeURIComponent(span) + (force ? '&force=1' : '');
      const res = await fetch('/api/fares' + qs);
      const json = await res.json();
      if (!json.ok) throw new Error((json.error && json.error.msg) || '读取失败');
      state.data = json.data;
      msg.textContent = '';
      render();
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message || '读取失败';
    } finally {
      state.busy = false;
    }
  }

  (async function init() {
    if (window.TravelHead) await window.TravelHead.start();
    $('fr-refresh').onclick = () => load(true);
    $('fr-window').onchange = () => load(false);
    $('fr-span').onchange = () => load(false);
    await load(false);
  })();
})();
