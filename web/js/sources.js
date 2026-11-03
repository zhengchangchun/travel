/* 多来源入口（标明来源）：同一个地点可以去看各平台的视频/笔记
   口径：只生成「跳转链接 + 来源标签」，不抓取任何平台内容（小红书/抖音风控 + 合规）
   平台任意：要加一家只在这里补一条（label＝来源名，会原样显示在按钮上） */
(function () {
  // 搜索引擎式入口：用「地点名 + 城市」当关键词
  const PLATFORMS = [
    {
      key: 'xhs',
      label: '小红书',
      kind: '笔记/视频',
      icon: '📕',
      url: (kw) => 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(kw),
    },
    {
      key: 'douyin',
      label: '抖音',
      kind: '视频',
      icon: '🎵',
      url: (kw) => 'https://www.douyin.com/search/' + encodeURIComponent(kw),
    },
    {
      key: 'bilibili',
      label: 'B站',
      kind: '视频',
      icon: '📺',
      url: (kw) => 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(kw),
    },
    {
      key: 'weibo',
      label: '微博',
      kind: '图文',
      icon: '🧣',
      url: (kw) => 'https://s.weibo.com/weibo?q=' + encodeURIComponent(kw),
    },
  ];

  function keywordOf(poi, city) {
    const name = String((poi && (poi.name || poi.poi_name)) || '').trim();
    if (!name) return '';
    const c = String(city || (poi && poi.city) || '').trim();
    return c ? name + ' ' + c : name;
  }

  // 高德自己的详情页（唯一「内容来源确定」的一条：数据本身就是高德给的）
  function amapEntry(poi) {
    const id = poi && (poi.id || poi.poi_id);
    if (!id) return null;
    return {
      key: 'amap',
      label: '高德',
      kind: '详情/评价',
      icon: '🗺️',
      url: 'https://www.amap.com/detail/' + encodeURIComponent(id),
      self: true,
    };
  }

  // 返回 [{key,label,kind,icon,url}]；没有名字时只给高德那条
  function sourcesFor(poi, city) {
    const out = [];
    const amap = amapEntry(poi);
    if (amap) out.push(amap);
    const kw = keywordOf(poi, city);
    if (kw) {
      PLATFORMS.forEach((p) => {
        out.push({ key: p.key, label: p.label, kind: p.kind, icon: p.icon, url: p.url(kw) });
      });
    }
    return out;
  }

  // 图片来源标注（高德的图分「官方图」与「用户实拍」，后者 URL 含 aos-comment）
  function photoSource(url) {
    const isComment = String(url || '').indexOf('aos-comment') >= 0;
    return { isComment, label: isComment ? '用户实拍' : '官方图', source: '高德' };
  }

  const api = { sourcesFor, keywordOf, photoSource, PLATFORMS };
  if (typeof window !== 'undefined') window.TravelSources = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
