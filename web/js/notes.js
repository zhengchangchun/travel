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

  // 错误人话化（P9-②）：抓取/搜索的失败码不直接给用户看
  function human(err) {
    return window.TravelErrors
      ? window.TravelErrors.humanize(err)
      : String((err && err.message) || err || '');
  }

  const st = {
    city: '',
    parsed: null, // 识别结果（手动贴文案时用）
    list: [],
    detail: null,
    candidates: [],
    busy: false,
    job: '', // 正在跑的任务 id（P10-⑩）：有没有值决定界面显示不显示「取消」
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

  // 长任务的进度行（P10-⑩）：显示「已 N 秒 · 当前到哪一步」，旁边是可以点的「取消」
  function setProgress(text) {
    const el = $('note-progress');
    if (el) el.textContent = text || '';
  }

  function setLive(on) {
    const btn = $('note-cancel-btn');
    if (btn) btn.classList.toggle('hidden', !on);
    if (!on) setProgress('');
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 抓一条 / 搜一批都是「本机浏览器跑十几秒到几分钟」：交给服务端后台任务，界面上看得到进度、随时能取消
  const JOB_POLL_MS = 500;
  const JOB_MAX_MS = 6 * 60 * 1000; // 兜底：超过 6 分钟就当它卡住了

  async function runJob(kind, body, title) {
    const started = Date.now();
    let cur = null;
    try {
      cur = await API.startNoteJob(Object.assign({ kind }, body));
    } catch (err) {
      return { ok: false, canceled: false, err };
    }
    const id = cur && cur.id ? cur.id : '';
    if (!id) {
      return { ok: false, canceled: false, err: { code: 'BAD_RESPONSE', message: '后端没给任务号' } };
    }
    st.job = id;
    setLive(true);
    const paint = (job) => {
      const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
      const stage = job && job.status === 'running' && job.stage ? ' · ' + job.stage : '';
      setProgress(title + '：已 ' + secs + ' 秒' + stage);
    };
    paint(cur);
    try {
      while (Date.now() - started < JOB_MAX_MS) {
        await sleep(JOB_POLL_MS);
        if (st.job !== id) return { ok: false, canceled: true }; // 被取消 / 被新任务顶替
        try {
          cur = await API.getNoteJob(id);
        } catch (err) {
          continue; // 一次读不到不算结束，接着等
        }
        if (!cur || cur.status === 'running') {
          paint(cur);
          continue;
        }
        break;
      }
    } finally {
      if (st.job === id) {
        st.job = '';
        setLive(false);
      }
    }
    if (cur && cur.status === 'done') return { ok: true, result: cur.result };
    if (cur && cur.status === 'canceled') return { ok: false, canceled: true };
    if (cur && cur.status === 'failed') {
      return { ok: false, canceled: false, err: { code: cur.error, message: cur.message } };
    }
    // 超过兜底时长还在跑：把服务端那个任务也取消掉
    try {
      await API.cancelNoteJob(id);
    } catch (err) {
      /* 忽略 */
    }
    return { ok: false, canceled: false, err: { code: 'TIMEOUT', message: '任务跑太久（超过 6 分钟）' } };
  }

  async function onCancelJob() {
    const id = st.job;
    st.job = '';
    setLive(false);
    setHint('已取消（本机浏览器那一步也停了）');
    if (!id) return;
    try {
      await API.cancelNoteJob(id);
    } catch (err) {
      /* 已经跑完/没了都无所谓 */
    }
  }

  // ---------- ① 抓取（链接 / 分享文案） ----------
  // 一次粘多条（2026-11-24，对标圆周旅迹 5.0）：文案里有几个链接就抓几个，逐条报结果。
  function countUrls(text) {
    const re = /https?:\/\/[^\s"'<>）)】\]\u4e00-\u9fa5，。、；：！？【】（）]+/gi;
    const seen = new Set();
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      const u = m[0].replace(/[，。、；：！？,.!?;:'"）)】\]]+$/g, '');
      if (u) seen.add(u);
    }
    return seen.size;
  }

  // 抓取失败时把人引到「手动贴正文」那条路（2026-11-25，P1-4）：
  // 抓取依赖本机登录态与平台风控（NEED_LOGIN / NEED_CAPTCHA / FETCH_FAIL / NO_DATA），
  // 这些情况下用户手里其实就有那段正文 —— 与其让他卡在「抓不到」，不如把备用入口直接摊开。
  const FALLBACK_CODES = ['NEED_LOGIN', 'NEED_CAPTCHA', 'FETCH_FAIL', 'NO_DATA', 'TIMEOUT'];

  function openManualFallback(reason) {
    const box = $('note-manual') || document.querySelector('.note-manual');
    if (box) box.open = true;
    const ta = $('note-share');
    if (ta) {
      // 把刚才那条链接/文案带过去，他只需要补上正文
      const linkEl = $('note-link');
      const raw = String((linkEl && linkEl.value) || '').trim();
      if (raw && !String(ta.value || '').trim()) ta.value = raw;
      setTimeout(() => ta.focus(), 60);
    }
    setHint(
      (reason ? reason + ' · ' : '') + '把笔记正文粘到下面「手动贴正文」里，一样能提地名（不用等抓取）',
      true
    );
  }

  function errCode(err) {
    if (!err) return '';
    return String(err.code || err.message || '').trim();
  }

  async function onFetch() {
    if (st.busy) {
      setHint('上一个任务还在跑：等它跑完，或点「取消」', true);
      return;
    }
    const linkEl = $('note-link');
    const raw = String((linkEl && linkEl.value) || $('note-share').value || '').trim();
    if (!raw) {
      setHint('先粘一条链接（小红书/抖音/快手/B站），或整段分享文案', true);
      return;
    }
    const n = countUrls(raw);
    if (n > 1) {
      await onFetchMany(raw, n);
      return;
    }
    st.busy = true;
    setHint('抓取中：本机浏览器在跑');
    try {
      const r = await runJob('fetch', { share_text: raw, city: st.city, save: true }, '抓取');
      if (r.canceled) {
        setHint('已取消（没写入任何内容）');
        return;
      }
      if (!r.ok) {
        const code = errCode(r.err);
        if (FALLBACK_CODES.includes(code)) {
          openManualFallback(human(r.err));
          return;
        }
        setHint('抓取失败：' + human(r.err), true);
        return;
      }
      const note = r.result && r.result.note;
      if (!note) {
        setHint('抓取返回里没有笔记内容', true);
        return;
      }
      setHint(
        '抓好了：' +
          (note.title || '(无标题)') +
          ' · ' +
          (note.images || []).length +
          ' 张图' +
          (r.result.updated ? ' · 更新了已有记录' : '')
      );
      if (linkEl) linkEl.value = '';
      // 抓完顺手提地名（零调用）
      try {
        await API.notePlaces(note.id, {});
      } catch (err) {
        /* 提取失败不影响抓取结果 */
      }
      await refresh();
      await openDetail(note.id);
    } finally {
      st.busy = false;
    }
  }

  // 多条一起抓：逐条报「第几条 / 成功几条」，失败的单独列出来（不因为一条失败就整批白跑）
  async function onFetchMany(raw, n) {
    st.busy = true;
    setHint('一次抓 ' + n + ' 条：本机浏览器逐条跑，可能要几分钟');
    try {
      const r = await runJob('fetch-many', { share_text: raw, city: st.city, save: true }, '批量抓取');
      if (r.canceled) {
        setHint('已取消（已抓到的那些已经存下来了）');
        return;
      }
      if (!r.ok) {
        const code = errCode(r.err);
        if (FALLBACK_CODES.includes(code)) {
          openManualFallback(human(r.err));
          return;
        }
        setHint('批量抓取失败：' + human(r.err), true);
        return;
      }
      const res = r.result || {};
      const items = Array.isArray(res.items) ? res.items : [];
      const okItems = items.filter((it) => it.ok);
      const badItems = items.filter((it) => !it.ok);
      const bits = ['抓到 ' + okItems.length + ' / ' + (res.total || items.length) + ' 条'];
      if (res.skipped) bits.push('（超出上限跳过 ' + res.skipped + ' 条）');
      if (badItems.length) bits.push('· 失败 ' + badItems.length + ' 条：' + badItems.map((it) => (it.message || it.error || '').slice(0, 18)).join('、'));
      setHint(bits.join(' '), badItems.length > 0);
      const linkEl = $('note-link');
      if (linkEl) linkEl.value = '';
      // 抓完顺手给每条提地名（零调用）
      for (const it of okItems) {
        if (!it.note_id) continue;
        try {
          await API.notePlaces(it.note_id, {});
        } catch (err) {
          /* 单条提取失败不影响其他 */
        }
      }
      await refresh();
      if (okItems.length === 1 && okItems[0].note_id) await openDetail(okItems[0].note_id);
    } finally {
      st.busy = false;
    }
  }

  // ---------- ② 按关键词搜一批候选 ----------
  async function onSearch() {
    if (st.busy) {
      setHint('上一个任务还在跑：等它跑完，或点「取消」', true);
      return;
    }
    const kwEl = $('note-keyword');
    const pfEl = $('note-platform');
    const keyword = String((kwEl && kwEl.value) || '').trim();
    if (!keyword) {
      setHint('先填个关键词，如 杭州咖啡', true);
      return;
    }
    st.busy = true;
    setHint('搜「' + keyword + '」中：本机浏览器在跑');
    try {
      const r = await runJob(
        'discover',
        { keyword, platform: (pfEl && pfEl.value) || 'xhs', limit: 12 },
        '搜「' + keyword + '」'
      );
      if (r.canceled) {
        setHint('已取消（上次搜到的候选还在）');
        return;
      }
      if (!r.ok) {
        st.candidates = [];
        renderCandidates();
        setHint('搜索失败：' + human(r.err), true);
        return;
      }
      st.candidates = (r.result && r.result.items) || [];
      setHint('搜到 ' + st.candidates.length + ' 条候选，点「存到本地」会把正文和图一起抓回来');
      renderCandidates();
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
    if (st.busy) {
      setHint('上一个任务还在跑：等它跑完，或点「取消」', true);
      return;
    }
    st.busy = true;
    if (btn) btn.textContent = '抓取中…';
    setHint('抓《' + (c.title || '').slice(0, 20) + '》中：本机浏览器在跑');
    try {
      const r = await runJob(
        'fetch',
        { url: c.url, city: st.city, save: true },
        '抓《' + (c.title || '').slice(0, 12) + '》'
      );
      if (r.canceled) {
        setHint('已取消');
        renderCandidates();
        return;
      }
      if (!r.ok || !r.result || !r.result.note) {
        setHint(r.ok ? '抓取返回里没有笔记内容' : '抓取失败：' + human(r.err), true);
        renderCandidates();
        return;
      }
      const note = r.result.note;
      try {
        await API.notePlaces(note.id, {});
      } catch (err) {
        /* 忽略 */
      }
      setHint('已存到本地：' + (note.title || '') + ' · ' + (note.images || []).length + ' 张图');
      await refresh();
      await openDetail(note.id);
      renderCandidates();
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
      setHint('识别失败：' + human(err), true);
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
      setHint('保存失败：' + human(err), true);
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
        if (st.busy) {
          setHint('上一个任务还在跑：等它跑完，或点「取消」', true);
          return;
        }
        st.busy = true;
        setHint('重抓中：本机浏览器在跑');
        try {
          const r = await runJob('refresh', { note_id: note.id }, '重抓');
          if (r.canceled) {
            setHint('已取消');
            return;
          }
          if (!r.ok || !r.result || !r.result.note) {
            setHint(r.ok ? '重抓返回里没有笔记内容' : '重抓失败：' + human(r.err), true);
            return;
          }
          st.detail = r.result.note;
          setHint(
            '已重抓：' + (r.result.note.title || '') + ' · ' + (r.result.note.images || []).length + ' 张图'
          );
          await refresh();
          renderDetail();
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
      if (after) after.textContent = '失败：' + human(err);
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
    const cancelBtn = $('note-cancel-btn');
    if (fetchBtn) fetchBtn.onclick = onFetch;
    if (searchBtn) searchBtn.onclick = onSearch;
    if (cancelBtn) cancelBtn.onclick = onCancelJob;
    // 回车即抓 / 即搜（少一次鼠标移动）
    const linkEl = $('note-link');
    if (linkEl) {
      linkEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onFetch();
        }
      });
    }
    const kwEl = $('note-keyword');
    if (kwEl) {
      kwEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSearch();
        }
      });
    }
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
