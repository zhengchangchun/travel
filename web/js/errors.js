/* 错误人话化（P9-②）：把高德 / 本机后端的原始 code 换成「出了什么事 + 下一步做什么」。
   用法：window.TravelErrors.humanize(err) —— err 可以是 Error（带 .code/.message），也可以是字符串。
   原则：已知码 → 固定人话；认不出来 → 「暂时没成功（原文截断）」，既不吞掉线索、也不把裸 code 甩给用户。 */
(function () {
  const CODE_TEXT = {
    // ---- 高德（infocode 或 info 名）----
    USER_DAILY_QUERY_OVER_LIMIT:
      '高德这个月的搜索额度用完了（下月 1 日恢复）· 已经取到的点照常能看',
    DAILY_QUERY_OVER_LIMIT:
      '高德这个月的搜索额度用完了（下月 1 日恢复）· 已经取到的点照常能看',
    QPS_HAS_EXCEEDED_THE_LIMIT: '请求太密了（超出高德 QPS 限制）· 等几秒再试',
    CALL_LIMIT: '高德调用次数到上限了 · 等额度恢复（已取到的点仍可用）',
    INVALID_USER_KEY: '高德 Key 无效 · 检查 config/local.json 里的 Web 服务 Key',
    INVALID_USER_SCODE: '高德安全密钥不对 · 检查 config/local.json 的 jsApiSecurityCode',
    SERVICE_NOT_AVAILABLE: '高德服务暂时不可用 · 过几分钟再试',
    INSUFFICIENT_PRIVILEGES: '这把高德 Key 没开通该接口权限',
    // ---- 本机后端 / 网络 ----
    NETWORK_ERROR: '连不上本机后端 · 确认 node server/index.js 还在跑',
    // ---- 笔记抓取 ----
    TIMEOUT: '抓取超时（站点慢或要登录）· 重试一次或换条链接',
    FETCH_FAIL: '抓取失败（站点拦截或网络问题）· 重试一次',
    NEED_LOGIN: '这个平台要先在本机浏览器登录一次 · 登录后回来重试',
    NEED_CAPTCHA: '触发平台验证码 · 在本机浏览器手动过一次再回来',
    NO_DATA: '没抓到内容（链接失效或要登录）· 换一条链接',
    BAD_PLATFORM: '暂不支持这个平台 · 换小红书 / 抖音 / 快手 / B站',
    NOT_IMPLEMENTED: '这个平台还没接抓取',
    // ---- 城市轮廓 ----
    BOUNDARY_UNAVAILABLE: '城市轮廓暂时拿不到（高德配额或网络）· 先按主城区显示',
  };
  const KEYS = Object.keys(CODE_TEXT);

  // 这两个是 api.js 拿不到具体 error.code / msg 时的兜底值，本身没有信息量：
  // 后端若已经写了中文说明就听它的，真什么都没有才用这两句。
  const GENERIC = {
    HTTP_ERROR: '后端报错 · 稍后重试',
    BAD_RESPONSE: '后端返回了看不懂的内容 · 稍后重试',
  };

  function clip(text, n) {
    const s = String(text == null ? '' : text).trim();
    const max = n || 60;
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  function rawOf(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    return String(err.message || '');
  }

  function codeOf(err) {
    if (err && typeof err === 'object' && err.code) return String(err.code);
    return '';
  }

  // 原始串里认已知码：高德的失败只给一句 errors[0]（没有 code），照样能认出来
  function findKey(blob) {
    const s = String(blob || '').toUpperCase();
    for (let i = 0; i < KEYS.length; i += 1) {
      if (s.indexOf(KEYS[i]) >= 0) return KEYS[i];
    }
    return '';
  }

  // 已经是人话（后端 / 本地写好的中文说明）就别再包一层，否则「行程不存在」会变成
  // 「暂时没成功（行程不存在）」——原文没多给信息，反而更难读
  function looksHuman(raw) {
    return /[\u4e00-\u9fa5]/.test(String(raw || ''));
  }

  // 认不出来时的兜底：网络类关键词 → 网络话术；其余 → 「暂时没成功（原文）」
  function fallbackText(raw) {
    if (/fetch|network|econnrefused|socket hang up|etimedout|enotfound/i.test(raw)) {
      return '网络连不上 · 检查网络 / 本机后端后重试';
    }
    if (/timeout|超时/i.test(raw)) return '请求超时 · 稍后重试';
    if (!raw) return '操作没成功 · 稍后重试';
    return '暂时没成功（' + clip(raw, 48) + '）';
  }

  function humanize(err, opts) {
    const opt = opts || {};
    const raw = rawOf(err);
    const code = codeOf(err);
    const generic = Object.prototype.hasOwnProperty.call(GENERIC, code);
    // 1) 具体码 → 表里的固定话术（兜底码不算，它没信息量）
    if (!generic && code && CODE_TEXT[code]) return CODE_TEXT[code];
    // 2) 从码 / 原文里认出已知码（高德常只给一句 errors[0]，没有 code）
    const byKey = findKey(code) || findKey(raw);
    if (byKey) return CODE_TEXT[byKey];
    // 3) 已经是中文人话（后端 msg）→ 原样给，只截长
    if (looksHuman(raw)) return clip(raw, 120);
    // 4) 真什么都没有：兜底码用固定话术，其余进 fallback
    if (generic) return GENERIC[code];
    return opt.fallback || fallbackText(raw);
  }

  // 数组形态（后端 live.errors）：只人话化第一条 + 剩余条数
  function humanizeList(list) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return '';
    const head = humanize(arr[0]);
    return arr.length > 1 ? head + '（另有 ' + (arr.length - 1) + ' 条同类失败）' : head;
  }

  window.TravelErrors = { humanize, humanizeList, CODE_TEXT, clip, looksHuman };
})();
