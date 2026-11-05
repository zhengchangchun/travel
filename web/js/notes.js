/* 笔记流（P4/P5）：自己抓 → 本地库 → 提取地名 → 高德补全成候选点
   两条入口：
     ① 抓取：粘链接（或分享文案）→ 本机浏览器用平台已登录 profile 把笔记/视频抓回来（标题/正文/作者/图/封面）
     ② 搜笔记：按关键词在小红书搜一批候选 → 挑一条抓详情落本地
   口径：
    · 抓取失败（需登录/超时/风控）如实报原因，不造数据；
    · 图/封面下到本地（data/notes-img），页面之后从本地读；
    · 「提取地名」零调用、可反复跑；「高德补全」每个名字 1 次调用（≤8）。 */
(function () {
  const API = window.TravelAPI;

  const st = {
    city: '',
    parsed: null, // 识别结果（手动贴文案时用）
    list: [],
    detail: null,
    candidates: [],
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

  function setHint(text, isErr) {
    const el = $('note-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('note-err', !!isErr);
  }

  // ---------- ① 抓取（链接 / 分享文案） ----------
  async function onFetch() {
    if (st.busy) return;
    const linkEl = $('note-link');
    const raw = String((linkEl && linkEl.value) || $('note-share').value || '').trim();
    if (!raw) {
      setHint('先粘一条链接（小红书/抖音/快手/B站），或整段分享文案', true);
      return;
    }
    st.busy = true;
    setHint('抓取中…本机浏览器在跑，一般 10–25 秒');
    try {
      const r = await API.fetchNote({ share_text: raw, city: st.city, save: true });
      setHint(
        '抓好了：' +
          (r.note.title || '(无标题)') +
          ' · ' +
          (r.note.images || []).length +
          ' 张图' +
          (r.updated ? ' · 更新了已有记录' : '')
      );
      if (linkEl) linkEl.value = '';
      // 抓完顺手提地名（零调用）
      try {
        await API.notePlaces(r.note.id, {});
      } catch (err) {
        /* 提取失败不影响抓取结果 */
      }
      await refresh();
      await openDetail(r.note.id);
    } catch (err) {
      setHint('抓取失败：' + err.message + '（' + (err.code || '') + '）', true);
    } finally {
      st.busy = false;
    }
  }

  // ---------- ② 按关键词搜一批候选 ----------
  async function onSearch() {
    if (st.busy) return;
    const kwEl = $('note-keyword');
    const pfEl = $('note-platform');
    const keyword = String((kwEl && kwEl.value) || '').trim();
    if (!keyword) {
      setHint('先填个关键词，如 杭州咖啡', true);
      return;
    }
    st.busy = true;
    setHint('搜「' + keyword + '」中…（本机浏览器，10–25 秒）');
    try {
      const r = await API.discoverNotes({
        keyword,
        platform: (pfEl && pfEl.value) || 'xhs',
        limit: 12,
      });
      st.candidates = r.items || [];
      setHint('搜到 ' + st.candidates.length + ' 条候选，点「存到本地」会把正文和图一起抓回来');
      renderCandidates();
    } catch (err) {
      st.candidates = [];
      renderCandidates();
      setHint('搜索失败：' + err.message + '（' + (err.code || '') + '）', true);
    } finally {
      st.busy = false;
    }
  }

  function renderCandidates() {
    const box = $('note-candidates');
    if (!box) return;
    if (!st.candidates.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML =
      '<div class="mini-label">搜到的候选（未入库）</div><ul class="poi-list note-cands">' +
      st.candidates
        .map((c, i) => {
          const cover = c.cover_url
            ? '<img class="note-thumb" src="' + esc(c.cover_url) + '" alt="" />'
            : '<span class="note-thumb blank">无图</span>';
          return [
            '<li class="note-cand" data-i="' + i + '">',
            cover,
            '<div class="note-cand-main">',
            '<div class="note-item-title">' + esc(c.title || '(无标题)') + '</div>',
            '<div class="note-item-sub">' +
              esc(c.author || '') +
              (c.liked ? ' · ♥' + esc(String(c.liked)) : '') +
              (c.exists ? ' · <b>已在本地</b>' : '') +
              '</div>',
            '</div>',
            '<button class="chip mini" data-act="save">' + (c.exists ? '重抓' : '存到本地') + '</button>',
            '</li>',
          ].join('');
        })
        .join('') +
      '</ul>';
    Array.from(box.querySelectorAll('.note-cand')).forEach((li) => {
      const c = st.candidates[Number(li.getAttribute('data-i'))];
      const btn = li.querySelector('button[data-act="save"]');
      if (btn) btn.onclick = (ev) => {
        ev.stopPropagation();
        saveCandidate(c, btn);
      };
    });
  }

  async function saveCandidate(c, btn) {
    if (st.busy) return;
    st.busy = true;
    if (btn) btn.textContent = '抓取中…';
    setHint('抓取《' + (c.title || '').slice(0, 20) + '》中…');
    try {
      const r = await API.fetchNote({ url: c.url, city: st.city, save: true });
      try {
        await API.notePlaces(r.note.id, {});
      } catch (err) {
        /* 忽略 */
      }
      setHint('已存到本地：' + (r.note.title || '') + ' · ' + (r.note.images || []).length + ' 张图');
      await refresh();
      await openDetail(r.note.id);
      renderCandidates();
    } catch (err) {
      setHint('抓取失败：' + err.message + '（' + err.code + '）', true);
      if (btn) btn.textContent = c.exists ? '重抓' : '存到本地';
    } finally {
      st.busy = false;
    }
  }

  // ---------- 手动贴文案（备用路径，P4 保留） ----------
  async function onParse() {
    const text = String($('note-share').value || '').trim();
    if (!text) return;
    try {
      const p = await API.parseNoteShare(text);
      st.parsed = p;
      renderPreview(p);
    } catch (err) {
      setHint('识别失败：' + err.message, true);
    }
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
      '<label class="mini-label">图片 URL（一行一个，可选）</label>',
      '<textarea id="note-image-urls" rows="2" placeholder="https://....jpg"></textarea>',
      p.names && p.names.length
        ? '<div class="note-names">可能的地名：' + p.names.map((n) => '<span class="chip mini">' + esc(n) + '</span>').join('') + '</div>'
        : '',
      '<div class="row"><button id="note-save-btn2" class="ghost">存到本地（手动）</button></div>',
    ].join('');
    const b = $('note-save-btn2');
    if (b) b.onclick = onSave;
  }

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
    st.busy = true;
    try {
      const note = await API.addNote({
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
      });
      try {
        await API.notePlaces(note.id, {});
      } catch (err) {
        /* 忽略 */
      }
      $('note-share').value = '';
      st.parsed = null;
      $('note-preview').classList.add('hidden');
      $('note-preview').innerHTML = '';
      setHint('已存到本地（手动）');
      await refresh();
      await openDetail(note.id);
    } catch (err) {
      setHint('保存失败：' + err.message, true);
    } finally {
      st.busy = false;
    }
  }

  // ---------- 本地列表 ----------
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
      box.innerHTML = '<li class="note-empty">还没有本地笔记：上面粘链接抓一条试试</li>';
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
    Array.from(box.querySelectorAll('img')).forEach((img) => {
      img.onerror = () => img.classList.add('is-broken');
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
        .map((p, idx) => {
          const ok = !!p.poi_id;
          const right = ok
            ? '<span class="note-place-acts">' +
              (st.hooks.onSelect ? '<button class="chip mini" data-act="pick">加入选择</button>' : '') +
              (st.hooks.onFlyTo ? '<button class="chip mini" data-act="map">地图</button>' : '') +
              '</span>'
            : '<span class="note-place-acts"><span class="note-err-inline">未补全</span></span>';
          return [
            '<li class="note-place" data-name="' + esc(p.name) + '" data-idx="' + idx + '">',
            '<div class="note-place-main">',
            '<b>' + esc(p.name) + '</b>',
            ok && p.rating ? '<span class="note-rating">★' + esc(p.rating) + '</span>' : '',
            ok && p.source === 'osm' ? '<span class="note-src">OSM</span>' : '',
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
      note.video_url && note.video_url !== note.url
        ? '<a class="note-link" href="' + esc(note.video_url) + '" target="_blank" rel="noopener">视频</a>'
        : '',
      '</div>',
      note.cover_url ? '<img class="note-cover" src="' + esc(note.cover_url) + '" alt="封面" />' : '',
      note.content ? '<div class="note-content">' + esc(note.content) + '</div>' : '',
      imgs.length
        ? '<div class="note-imgs">' + imgs.map((u) => '<img src="' + esc(u) + '" alt="" />').join('') + '</div>'
        : '<div class="hint">本地没存图</div>',
      '<div class="row note-actions">',
      '<button class="chip" id="note-extract-btn">提取地名</button>',
      '<button class="primary" id="note-resolve-btn" title="每个名字 1 次高德调用">高德补全</button>',
      note.url ? '<button class="ghost" id="note-refresh-btn" title="用原链接重新抓一遍">重抓</button>' : '',
      '<button class="ghost" id="note-del-btn">删除</button>',
      '</div>',
      '<label class="mini-label">要补全的地名（可改，顿号/逗号/空格分隔）</label>',
      '<input id="note-names-input" value="' + esc(names.join('、')) + '" placeholder="如 西湖、南山路店" />',
      '<div class="hint" id="note-place-hint">候选：' + esc(names.join('、') || '—') + '</div>',
      placesHtml(note),
    ].join('');

    $('note-detail-close').onclick = () => box.classList.add('hidden');
    $('note-extract-btn').onclick = () => runPlaces({}, '已提取地名候选（0 次调用）');
    $('note-resolve-btn').onclick = () => runPlaces({ resolve: true }, '补全完成');
    const refBtn = $('note-refresh-btn');
    if (refBtn) {
      refBtn.onclick = async () => {
        if (st.busy) return;
        st.busy = true;
        setHint('重抓中…');
        try {
          const r = await API.refreshNote(note.id);
          st.detail = r.note;
          setHint('已重抓：' + (r.note.title || '') + ' · ' + (r.note.images || []).length + ' 张图');
          await refresh();
          renderDetail();
        } catch (err) {
          setHint('重抓失败：' + err.message, true);
        } finally {
          st.busy = false;
        }
      };
    }
    $('note-del-btn').onclick = async () => {
      try {
        await API.deleteNote(note.id);
        box.classList.add('hidden');
        await refresh();
      } catch (err) {
        /* 删除失败保持原样 */
      }
    };
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
    const namesEl = $('note-names-input');
    const typed = namesEl
      ? String(namesEl.value || '')
          .split(/[、,，\n]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const body = Object.assign({}, payload, typed.length ? { names: typed } : {});
    if (hint) {
      hint.textContent = payload.resolve
        ? '正在补全（每个名字先试高德，没配额时走 OSM）…'
        : '提取中…';
    }
    try {
      const r = await API.notePlaces(st.detail.id, body);
      st.detail = await API.getNote(st.detail.id);
      renderDetail();
      const after = $('note-place-hint');
      if (after) {
        after.textContent =
          okMsg +
          '：' +
          r.names.length +
          ' 个候选 · 高德 ' +
          r.calls +
          ' 次' +
          (r.osm_calls ? ' · OSM 兜底 ' + r.osm_calls + ' 次' : '') +
          ' · 补全成功 ' +
          r.resolved +
          ' 个' +
          (r.errors && r.errors.length
            ? ' · 失败 ' + r.errors.length + ' 个（' + r.errors.map((e) => e.name).join('、') + '）'
            : '');
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
    const fetchBtn = $('note-fetch-btn');
    const searchBtn = $('note-search-btn');
    if (fetchBtn) fetchBtn.onclick = onFetch;
    if (searchBtn) searchBtn.onclick = onSearch;
    if (parseBtn) parseBtn.onclick = onParse;
    if (saveBtn) saveBtn.onclick = onParse; // 「识别」→ 出预览（存走预览里的按钮）
    if (clearBtn) {
      clearBtn.onclick = () => {
        $('note-share').value = '';
        st.parsed = null;
        $('note-preview').classList.add('hidden');
        $('note-preview').innerHTML = '';
        setHint('');
      };
    }
    const box = $('note-share');
    if (box) {
      box.onpaste = () => {
        setTimeout(() => {
          if (String($('note-share').value || '').trim()) onParse();
        }, 0);
      };
    }
  }

  window.TravelNotes = { mount, refresh, openDetail };
})();
