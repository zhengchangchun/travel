/* 详情面板（T5）：图集（用户实拍优先）/ 招牌菜 chip / 评分 / 详细地址 / 去高德看评价。
   与 T2 的「信息卡」合并为同一个面板（容器仍为 #infocard），不再并存两套。 */
(function () {
  const API = window.TravelAPI;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function colorOf(key) {
    return window.TravelCategories.colorOf(key);
  }

  function labelOf(key) {
    return window.TravelCategories.labelOf(key);
  }

  function isComment(url) {
    return String(url || '').indexOf('aos-comment') >= 0;
  }

  // 客户端兜底：把列表/旗子上已有的 poi 组装成详情结构（后端权威值随后覆盖）
  function fromPoi(poi) {
    const raw = Array.isArray(poi.photos) ? poi.photos : poi.photo ? [poi.photo] : [];
    const photos = raw
      .map((u) => (typeof u === 'string' ? u : (u && u.url) || ''))
      .filter(Boolean)
      .map((url) => ({ url, isComment: isComment(url), source: 'amap' }));
    const id = poi.id || poi.poi_id;
    return {
      poi_id: id,
      name: poi.name || '',
      category: poi.category || '',
      address: poi.address || '',
      lng: poi.lng,
      lat: poi.lat,
      rating: poi.rating || '',
      cost: poi.cost || '',
      tel: poi.tel || '',
      opentime: poi.opentime || '',
      photos,
      tags: Array.isArray(poi.tags) ? poi.tags.slice(0, 12) : [],
      amapUrl: poi.amapUrl || 'https://www.amap.com/detail/' + (id == null ? '' : id),
    };
  }

  // 评论实拍图优先，其余保持原序
  function sortPhotos(photos) {
    const list = Array.isArray(photos) ? photos : [];
    return list.filter((p) => p.isComment).concat(list.filter((p) => !p.isComment));
  }

  function topStarHtml(rating) {
    const SC = window.TravelScoreColor;
    if (!SC || !SC.isTop(rating)) return '';
    return '<span class="top-star" title="满分 ' + esc(rating) + '">★</span>';
  }

  function starButton(selected, color) {
    return (
      '<button class="star' + (selected ? ' active' : '') + '" ' +
      'title="' + (selected ? '取消选中' : '选中') + '" ' +
      'style="--star-color:' + esc(color) + '">' +
      (selected ? '★' : '☆') +
      '</button>'
    );
  }

  function galleryHtml(photos) {
    if (!photos.length) {
      return '<div class="gallery gallery-empty"><span class="gallery-empty-text">暂无图片</span></div>';
    }
    const first = photos[0];
    const multi = photos.length > 1;
    return (
      '<div class="gallery" data-count="' + photos.length + '">' +
      '<div class="gallery-main">' +
      '<img class="gallery-img" src="' + esc(first.url) + '" alt="" />' +
      '<span class="badge-comment' + (first.isComment ? '' : ' hidden') + '">用户实拍</span>' +
      (multi
        ? '<button class="gallery-prev" type="button" title="上一张">‹</button>' +
          '<button class="gallery-next" type="button" title="下一张">›</button>'
        : '') +
      '</div>' +
      '<div class="gallery-count">1 / ' + photos.length + '</div>' +
      '</div>'
    );
  }

  function render(card, data, city, handlers) {
    const photos = sortPhotos(data.photos);
    const color = colorOf(data.category);
    const label = labelOf(data.category);
    const navUrl =
      'https://uri.amap.com/marker?position=' +
      data.lng + ',' + data.lat + '&name=' + encodeURIComponent(data.name || '');
    const xhsUrl =
      'https://www.xiaohongshu.com/search_result?keyword=' +
      encodeURIComponent((city || '') + (data.name || ''));

    const meta = [];
    if (data.rating) meta.push('★ ' + data.rating);
    if (data.cost) meta.push('¥' + data.cost);
    if (data.opentime) meta.push(data.opentime);

    const tagsHtml =
      Array.isArray(data.tags) && data.tags.length
        ? '<div class="dish-tags">' +
          data.tags.map((t) => '<span class="dish-chip">' + esc(t) + '</span>').join('') +
          '</div>'
        : '';

    card.innerHTML =
      galleryHtml(photos) +
      '<div class="card-head">' +
      '<span class="dot" style="background:' + esc(color) + '"></span>' +
      '<b class="detail-name">' + esc(data.name || '') + '</b>' +
      topStarHtml(data.rating) +
      '<span class="poi-tag">' + esc(label) + '</span>' +
      starButton(!!(handlers && handlers.isSelected && handlers.isSelected(data)), color) +
      '<button class="card-close" title="关闭">×</button>' +
      '</div>' +
      (meta.length ? '<div class="detail-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
      '<div class="card-addr">' +
      '<span class="addr-text">' + esc(data.address || '（无详细地址）') + '</span>' +
      '<button class="copy-addr" title="复制地址">复制</button>' +
      '</div>' +
      tagsHtml +
      '<div class="card-actions">' +
      (data.category === 'stay' ? '<button class="btn base-pick">定为住宿</button>' : '') +
      '<a class="btn" href="' + esc(navUrl) + '" target="_blank" rel="noopener">导航</a>' +
      '<a class="btn amap" href="' + esc(data.amapUrl) + '" target="_blank" rel="noopener">去高德看评价</a>' +
      '<a class="btn xhs" href="' + esc(xhsUrl) + '" target="_blank" rel="noopener">去小红书看笔记</a>' +
      '<button class="btn primary add-pin">加入行程</button>' +
      '</div>' +
      '<p class="detail-note">高德接口不提供评价正文，点「去高德看评价」看真实评价</p>';

    card.classList.remove('hidden');

    // 图集左右翻
    let idx = 0;
    const main = card.querySelector('.gallery-main');
    const img = card.querySelector('.gallery-img');
    const badge = card.querySelector('.badge-comment');
    const counter = card.querySelector('.gallery-count');
    function showPhoto(i) {
      if (!photos.length || !img) return;
      idx = (i + photos.length) % photos.length;
      const p = photos[idx];
      img.style.display = '';
      if (main) main.classList.remove('img-failed');
      img.src = p.url;
      if (badge) badge.classList.toggle('hidden', !p.isComment);
      if (counter) counter.textContent = idx + 1 + ' / ' + photos.length;
    }
    if (img) {
      img.onerror = () => {
        img.style.display = 'none';
        if (main) main.classList.add('img-failed');
      };
    }
    const prev = card.querySelector('.gallery-prev');
    const next = card.querySelector('.gallery-next');
    if (prev) prev.onclick = (e) => { e.stopPropagation(); showPhoto(idx - 1); };
    if (next) next.onclick = (e) => { e.stopPropagation(); showPhoto(idx + 1); };
    showPhoto(0);

    const close = card.querySelector('.card-close');
    if (close) close.onclick = () => card.classList.add('hidden');

    const copy = card.querySelector('.copy-addr');
    if (copy) {
      copy.onclick = async (e) => {
        e.stopPropagation();
        const text = data.address || '';
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = '已复制';
        } catch (err) {
          window.prompt('复制地址：', text);
        }
        setTimeout(() => (copy.textContent = '复制'), 1500);
      };
    }

    const star = card.querySelector('.star');
    if (star && handlers && handlers.onToggleSelect) {
      star.onclick = async (e) => {
        e.stopPropagation();
        star.disabled = true;
        try {
          await handlers.onToggleSelect(data);
        } finally {
          star.disabled = false;
        }
        const on = handlers.isSelected ? handlers.isSelected(data) : false;
        star.classList.toggle('active', on);
        star.textContent = on ? '★' : '☆';
        star.title = on ? '取消选中' : '选中';
      };
    }

    const add = card.querySelector('.add-pin');
    if (add && handlers && handlers.onAddPin) add.onclick = () => handlers.onAddPin(data);

    // 住宿铺点：把这家定为行程锚点（后续「看周边美食/景点」以它为中心）
    const bp = card.querySelector('.base-pick');
    if (bp && handlers && handlers.onSetBase) {
      bp.onclick = () => {
        handlers.onSetBase(data);
        bp.textContent = '已设为住宿';
        bp.classList.add('active');
      };
    }
  }

  // 打开详情面板：先用列表/旗子已有数据即时渲染 → 再向后端取权威详情覆盖
  async function show(card, poi, city, handlers) {
    if (!card || !poi) return;
    const base = fromPoi(poi);
    const mergedHandlers = Object.assign({}, handlers);
    render(card, base, city, mergedHandlers);
    const id = base.poi_id;
    if (!id) return;
    const token = Date.now() + ':' + Math.random();
    card.dataset.detailToken = token;
    try {
      const detail = await API.getPoiDetail(id);
      if (card.dataset.detailToken !== token) return;
      if (detail) render(card, detail, city, mergedHandlers);
    } catch (err) {
      /* 详情拿不到：保留基础渲染，不阻断 */
    }
  }

  window.TravelDetail = { show, fromPoi, sortPhotos };
})();
