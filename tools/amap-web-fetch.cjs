// 高德网页版搜索：打开搜索页，拦 poiInfo 响应，解析成结构化 POI
// 这是给 server/amap-web.js 用的抓取脚本（子进程跑，stdout 一行 JSON）
const PORT = process.env.NS_PORT || '8787';

module.exports = async ({ page }) => {
  const keyword = process.env.AMAP_WEB_KEYWORD || '楼外楼';
  const city = process.env.AMAP_WEB_CITY || '330100';
  const t0 = Date.now();

  let captured = null;
  page.on('response', async (r) => {
    const u = r.url();
    if (!/amap\.com\/service\/poiInfo/.test(u)) return;
    try {
      const body = await r.text();
      if (body.length < 500) return;
      const j = JSON.parse(body);
      const list = (j.data && j.data.poi_list) || [];
      if (list.length) captured = list;
    } catch (e) {}
  });

  await page.goto(
    'https://www.amap.com/search?query=' + encodeURIComponent(keyword) + '&city=' + city,
    { waitUntil: 'domcontentloaded', timeout: 45000 }
  );

  // 等 poiInfo 回来（最多 25 秒）
  const deadline = Date.now() + 25000;
  while (!captured && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  if (!captured) {
    console.log(JSON.stringify({ ok: false, error: 'NO_DATA', ms: Date.now() - t0 }));
    return;
  }

  const pick = (p) => {
    const d = {};
    (p.domain_list || []).forEach((x) => { d[x.name] = x.value; });
    const strip = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();
    return {
      id: p.id,
      name: p.name,
      address: p.address || '',
      lng: Number(p.longitude),
      lat: Number(p.latitude),
      rating: p.rating || '',
      cost: p.cost || d.price || '',
      tel: p.tel || '',
      typecode: p.typecode || p.new_type || '',
      photo: d.pic_info || '',
      tag: strip(d.tag),
      businessArea: d.business_area || '',
    };
  };

  console.log(JSON.stringify({
    ok: true,
    ms: Date.now() - t0,
    count: captured.length,
    items: captured.map(pick).filter((p) => p.id && p.name && Number.isFinite(p.lng) && Number.isFinite(p.lat)),
  }));
};
