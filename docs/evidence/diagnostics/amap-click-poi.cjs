module.exports = async ({ page }) => {
  const KEY = 'REDACTED';
  const html = `<!doctype html><meta charset=utf-8>
  <div id="map" style="width:1200px;height:800px"></div>
  <script src="https://webapi.amap.com/maps?v=2.0&key=${KEY}"></script>
  <script>
    window.__hits = [];
    window.__ready = false;
    const m = new AMap.Map('map', { zoom: 16, center: [120.212943, 30.24917] });
    m.on('click', (e) => {
      if (e && e.poi) window.__hits.push({ name: e.poi.name, id: e.poi.id, lnglat: [e.poi.location && e.poi.location.lng, e.poi.location && e.poi.location.lat] });
      else window.__hits.push({ name: null, raw: Object.keys(e || {}).join(',') });
    });
    m.on('complete', () => { window.__ready = true; });
  </script>`;

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(9000);
  console.log('地图就绪:', await page.evaluate(() => window.__ready));

  // 在图上打 6x5 网格点击，看有多少次能点到"底图 POI"
  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      const x = 120 + gx * 170;
      const y = 120 + gy * 130;
      await page.mouse.click(x, y);
      await page.waitForTimeout(120);
    }
  }
  await page.waitForTimeout(1000);

  const hits = await page.evaluate(() => window.__hits || []);
  const withPoi = hits.filter(h => h.name);
  console.log(`点击 ${hits.length} 次，其中点到 POI 的: ${withPoi.length} 次`);
  console.log('示例:', JSON.stringify(withPoi.slice(0, 8), null, 2));
  console.log('未命中时的 e 键名示例:', hits.find(h => !h.name)?.raw || '(全部命中)');
};
