/* 笔记流（P4）：粘贴分享文案/正文 → 存本地 → 提取地名 → 高德补全成候选点
   口径：
    · 平台侧不抓（抖音/小红书/快手在本机都被风控）⇒ 内容一律「用户粘贴」；
    · 「提取地名」零调用、可反复跑；「高德补全」每个名字 1 次调用（最多 8 个），失败如实报错不写假点；
    · 图片/封面下到本地（data/notes-img），页面之后从本地读。 */
(function () {
  const API = window.TravelAPI;

  const st = {
    city: '',
    parsed: null, // 识别结果（存本地时带上）
    list: [],
    detail: null,
    busy: false,
    hooks: {},
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function kindLabel(kind) {
    return kind === 'video' ? '视频' : '图文';
  }

  function badge(n) {
    return (
      '<span class="note-badge">' +
      esc(n.source || '其他') +
      '</span><span class="note-badge ghost-badge">' +
      kindLabel(n.kind) +
      '</span>'
    );
  }

  // ---------- 识别 ----------
  async function onParse() {
    const text = String($('note-share').value || '').trim();
    if (!text) return;
    try {
      const p = await API.parseNoteShare(text);
      st.parsed = p;
      renderPreview(p);
    } catch (err) {
      renderPreviewError(err.message);
    }
  }

  function renderPreviewError(msg) {
    const box = $('note-preview');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="note-err">识别失败：' + esc(msg) + '</div>';
  }

  function renderPreview(p) {
    const box = $('note-preview');
    box.classList.remove('hidden');
    box.innerHTML = [
      '<div class="note-meta">',
      badge(p),
      p.author ? '<span class="note-author">@' + esc(p.author) + '</span>' : '',
      p.url ? '<a class="note-link" href="' + esc(p.url) + '" target="_blank" rel="noopener">原链接</a>' : '',
      '</div>',
      '<label class="mini-label">标题</label>',
      '<input id="note-title" value="' + esc(p.title || '') + '" placeholder="没识别出来就自己填" />',
      '<label class="mini-label">作者</label>',
      '<input id="note-author" value="' + esc(p.author || '') + '" placeholder="可选" />',
      '<label class="mini-label">正文（地名就从这里提）</label>',
      '<textarea id="note-content" rows="4">' + esc(p.content_clean || '') + '</textarea>',
      '<label class="mini-label">图片 URL（一行一个，可选；视频封面也可以）</label>',
      '<textarea id="note-image-urls" rows="2" placeholder="https://....jpg"></textarea>',
      p.names && p.names.length
        ? '<div class="note-names">可能的地名：' + p.names.map((n) => '<span class="chip mini">' + esc(n) + '</span>').join('') + '</div>'
        : '',
    ].join('');
  }

  // ---------- 存本地 ----------
  async function onSave() {
    if (st.busy) return;
    const raw = String($('note-share').value || '').trim();
    if (!raw) return;
    const p = st.parsed || {};
    const titleEl = $('note-title');
    const authorEl = $('note-author');
    const contentEl = $('note-content');
    const imgEl = $('note-image-urls');
    const imageUrls = imgEl
      ? String(imgEl.value || '')
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const payload = {
      share_text: raw,
      city: st.city,
      title: titleEl ? titleEl.value.trim() : p.title,
      author: authorEl ? authorEl.value.trim() : p.author,
      content: contentEl ? contentEl.value.trim() : p.content_clean,
      url: p.url,
      source: p.source,
      source_type: p.source_type,
      kind: p.kind,
      image_urls: imageUrls,
    };
    st.busy = true;
    try {
      const note = await API.addNote(payload);
      // 顺手把地名候选落库（零调用），用户点「补全」才打高德
      try {
        await API.notePlaces(note.id, {});
      } catch (err) {
        /* 提取失败不影响已存下的笔记 */
      }
      $('note-share').value = '';
      st.parsed = null;
      $('note-preview').classList.add('hidden');
      $('note-preview').innerHTML = '';
      await refresh();
      await openDetail(note.id);
    } catch (err) {
      renderPreviewError(err.message);
    } finally {
      st.busy = false;
    }
  }

  // ---------- 列表 ----------
  async function refresh(city) {
    if (city !== undefined) st.city = city || '';
    try {
      const data = await API.searchNotes({ city: st.city, limit: 200 });
      st.list = data.items || [];
    } catch (err) {
      st.list = [];
    }
    renderList();
  }

  function renderList() {
    const box = $('note-list');
    const count = $('note-count');
    if (count) count.textContent = String(st.list.length);
    if (!box) return;
    if (!st.list.length) {
      box.innerHTML = '<li class="note-empty">还没有本地笔记：上面粘贴一段分享文案试试</li>';
      return;
    }
    box.innerHTML = st.list
      .map((n) => {
        const cover = n.cover_url
          ? '<img class="note-thumb" src="' + esc(n.cover_url) + '" alt="" />'
          : '<span class="note-thumb blank">' + kindLabel(n.kind) + '</span>';
        return [
          '<li class="note-item" data-id="' + n.id + '">',
          cover,
          '<div class="note-item-main">',
          '<div class="note-item-title">' + esc(n.title || '(无标题)') + '</div>',
          '<div class="note-item-sub">',
          badge(n),
          n.place_count ? '<span class="note-dot">·</span>' + n.place_count + ' 个地点' : '',
          '</div>',
          '</div>',
          '</li>',
        ].join('');
      })
      .join('');
    Array.from(box.querySelectorAll('.note-item')).forEach((li) => {
      li.onclick = () => openDetail(Number(li.getAttribute('data-id')));
    });
  }

  // ---------- 详情 ----------
  async function openDetail(id) {
    let note;
    try {
      note = await API.getNote(id);
    } catch (err) {
      return;
    }
    st.detail = note;
    renderDetail();
  }

  function placesHtml(note) {
    const list = note.places || [];
    if (!list.length) return '<div class="hint">还没提取地名</div>';
    return (
      '<ul class="poi-list note-places">' +
      list
        .map((p) => {
          const ok = !!p.poi_id;
          const right = ok
            ? '<span class="note-place-acts">' +
              (st.hooks.onSelect ? '<button class="chip mini" data-act="pick">加入选择</button>' : '') +
              (st.hooks.onFlyTo ? '<button class="chip mini" data-act="map">地图</button>' : '') +
              '</span>'
            : '<span class="note-place-acts"><span class="note-err-inline">未补全</span></span>';
          return [
            '<li class="note-place" data-name="' + esc(p.name) + '" data-idx="' + list.indexOf(p) + '">',
            '<div class="note-place-main">',
            '<b>' + esc(p.name) + '</b>',
            ok && p.rating ? '<span class="note-rating">★' + esc(p.rating) + '</span>' : '',
            '<div class="note-place-addr">' + esc(p.address || (ok ? '' : '还没查高德')) + '</div>',
            '</div>',
            right,
            '</li>',
          ].join('');
        })
        .join('') +
      '</ul>'
    );
  }

  function renderDetail() {
    const note = st.detail;
    const box = $('note-detail');
    if (!note || !box) return;
    box.classList.remove('hidden');
    const imgs = note.images || [];
    const names = (note.places || []).map((p) => p.name);
    box.innerHTML = [
      '<div class="note-detail-head">',
      '<div class="note-detail-title">' + esc(note.title || '(无标题)') + '</div>',
      '<button class="ghost mini" id="note-detail-close">关闭</button>',
      '</div>',
      '<div class="note-meta">',
      badge(note),
      note.author ? '<span class="note-author">@' + esc(note.author) + '</span>' : '',
      note.url ? '<a class="note-link" href="' + esc(note.url) + '" target="_blank" rel="noopener">原链接</a>' : '',
      note.video_url ? '<a class="note-link" href="' + esc(note.video_url) + '" target="_blank" rel="noopener">视频</a>' : '',
      '</div>',
      note.cover_url
        ? '<img class="note-cover" src="' + esc(note.cover_url) + '" alt="封面" />'
        : '',
      note.content ? '<div class="note-content">' + esc(note.content) + '</div>' : '',
      imgs.length
        ? '<div class="note-imgs">' + imgs.map((u) => '<img src="' + esc(u) + '" alt="" />').join('') + '</div>'
        : '<div class="hint">本地没存图（可以下次粘贴时带上图片 URL）</div>',
      '<div class="row note-actions">',
      '<button class="chip" id="note-extract-btn">提取地名</button>',
      '<button class="primary" id="note-resolve-btn" title="每个名字 1 次高德调用">高德补全</button>',
      '<button class="ghost" id="note-del-btn">删除</button>',
      '</div>',
      '<label class="mini-label">要补全的地名（可改，顿号/逗号/空格分隔）</label>',
      '<input id="note-names-input" value="' + esc(names.join('、')) + '" placeholder="如 西湖、南山路店" />',
      '<div class="hint" id="note-place-hint">候选：' + esc(names.join('、') || '—') + '</div>',
      placesHtml(note),
    ].join('');

    $('note-detail-close').onclick = () => {
      box.classList.add('hidden');
    };
    $('note-extract-btn').onclick = () => runPlaces({}, '已提取地名候选（0 次调用）');
    $('note-resolve-btn').onclick = () => runPlaces({ resolve: true }, '补全完成');
    $('note-del-btn').onclick = async () => {
      try {
        await API.deleteNote(note.id);
        box.classList.add('hidden');
        await refresh();
      } catch (err) {
        /* 删除失败保持原样 */
      }
    };
    // 图挂了就藏起来，别留破图框（本地缓存被清 / 源站防盗链时会碰上）
    Array.from(box.querySelectorAll('img')).forEach((img) => {
      img.onerror = () => img.classList.add('is-broken');
    });
    Array.from(box.querySelectorAll('.note-place')).forEach((li) => {
      const idx = Number(li.getAttribute('data-idx'));
      const place = (note.places || [])[idx];
      li.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const act = btn.getAttribute('data-act');
          if (act === 'map' && st.hooks.onFlyTo && place) {
            st.hooks.onFlyTo(place.lng, place.lat, place.name);
          } else if (act === 'pick' && st.hooks.onSelect && place) {
            st.hooks.onSelect({
              id: place.poi_id,
              poi_id: place.poi_id,
              name: place.poi_name || place.name,
              address: place.address,
              lng: place.lng,
              lat: place.lat,
              category: place.category,
              rating: place.rating,
            });
          }
        };
      });
    });
  }

  async function runPlaces(payload, okMsg) {
    if (st.busy || !st.detail) return;
    st.busy = true;
    const hint = $('note-place-hint');
    // 地名列表以输入框为准（用户剔掉噪声/手填名字后再补全）
    const namesEl = $('note-names-input');
    const typed = namesEl
      ? String(namesEl.value || '')
          .split(/[、,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const body = Object.assign({}, payload, typed.length ? { names: typed } : {});
    if (hint) hint.textContent = payload.resolve ? '正在补全（每个名字 1 次高德调用）…' : '提取中…';
    try {
      const r = await API.notePlaces(st.detail.id, body);
      const note = await API.getNote(st.detail.id);
      st.detail = note;
      renderDetail();
      const after = $('note-place-hint');
      if (after) {
        after.textContent =
          okMsg +
          '：' +
          r.names.length +
          ' 个候选 · ' +
          r.calls +
          ' 次调用 · 补全成功 ' +
          r.resolved +
          ' 个' +
          (r.errors && r.errors.length ? ' · 失败 ' + r.errors.length + ' 个（' + r.errors.map((e) => e.name).join('、') + '）' : '');
      }
      await refresh();
    } catch (err) {
      const after = $('note-place-hint');
      if (after) after.textContent = '失败：' + err.message;
    } finally {
      st.busy = false;
    }
  }

  function mount(hooks) {
    st.hooks = hooks || {};
    const parseBtn = $('note-parse-btn');
    const saveBtn = $('note-save-btn');
    const clearBtn = $('note-clear-btn');
    if (parseBtn) parseBtn.onclick = onParse;
    if (saveBtn) saveBtn.onclick = onSave;
    if (clearBtn) {
      clearBtn.onclick = () => {
        $('note-share').value = '';
        st.parsed = null;
        $('note-preview').classList.add('hidden');
        $('note-preview').innerHTML = '';
      };
    }
    const box = $('note-share');
    if (box) {
      box.onpaste = () => {
        // 粘完自动识别，省一步点击
        setTimeout(() => {
          if (String($('note-share').value || '').trim()) onParse();
        }, 0);
      };
    }
  }

  window.TravelNotes = { mount, refresh, openDetail, extractPlaceNamesFallback: null };
})();
