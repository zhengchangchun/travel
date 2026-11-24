// 多平台分享文案解析 + 地名提取（纯函数 / 零依赖 / 可离线单测）
//
// 口径（P4，2026-11-04 用户「小红书 抖音 快手 等等，笔记和视频都可以」）：
//  · 平台侧我们**不抓**（本机全部被风控，见 P3 调研）⇒ 内容一律由用户**粘贴**进来；
//  · 粘贴物通常是 App「分享 → 复制链接」吐的那段文案（标题 + 短链 + 一堆引导语），
//    这里是把它拆成 平台/形态/标题/作者/链接，拆不出的留空由用户在页面上补；
//  · 「按笔记搜地方」的前半段＝从正文里抠出**地名候选**（后半段＝高德补全，在路由层）。

const SOURCE_DEFS = [
  {
    type: 'xhs',
    name: '小红书',
    kind: 'note',
    hosts: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
    words: ['小红书'],
  },
  {
    type: 'douyin',
    name: '抖音',
    kind: 'video',
    hosts: ['douyin.com', 'iesdouyin.com'],
    words: ['抖音', 'dou音', 'Dou音'],
  },
  {
    type: 'kuaishou',
    name: '快手',
    kind: 'video',
    hosts: ['kuaishou.com', 'gifshow.com', 'chenzhongtech.com', 'kwai.com'],
    words: ['快手'],
  },
  {
    type: 'bilibili',
    name: 'B站',
    kind: 'video',
    hosts: ['bilibili.com', 'b23.tv'],
    words: ['哔哩哔哩', '哔哩', 'B站', 'b站'],
  },
  {
    type: 'weibo',
    name: '微博',
    kind: 'note',
    hosts: ['weibo.com', 'weibo.cn', 't.cn'],
    words: ['微博'],
  },
  {
    type: 'wechat',
    name: '微信',
    kind: 'note',
    hosts: ['mp.weixin.qq.com', 'weixin.qq.com'],
    words: ['微信公众号', '公众号'],
  },
];

const OTHER = { type: 'other', name: '其他', kind: 'note' };

function defOf(type) {
  return SOURCE_DEFS.find((d) => d.type === type) || null;
}

function nameOfType(type) {
  const d = defOf(type);
  return d ? d.name : OTHER.name;
}

function kindOfType(type, fallback) {
  const d = defOf(type);
  return d ? d.kind : fallback || OTHER.kind;
}

function hostOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch (err) {
    const m = raw.match(/^[a-z]+:\/\/([^/?#]+)/i) || raw.match(/^([a-z0-9.\-]+\.[a-z]{2,})(?:\/|$)/i);
    return m ? m[1].toLowerCase() : '';
  }
}

// 链接 → 平台（域名后缀匹配，覆盖 v.douyin.com / www.xiaohongshu.com 这类子域）
function sourceOfUrl(url) {
  const host = hostOf(url);
  if (!host) return null;
  const hit = SOURCE_DEFS.find((d) => d.hosts.some((h) => host === h || host.endsWith('.' + h)));
  return hit ? { source: hit.name, source_type: hit.type, kind: hit.kind } : null;
}

// 文案里没有可识别链接时的兜底：按平台名关键词认
function sourceOfWords(text) {
  const s = String(text || '');
  const hit = SOURCE_DEFS.find((d) => d.words.some((w) => s.includes(w)));
  return hit ? { source: hit.name, source_type: hit.type, kind: hit.kind } : null;
}

// 取第一个 http(s) 链接（去掉尾巴上的中文标点/括号，分享文案常把标点粘在链接后）
function extractUrl(text) {
  // 汉字也当作 URL 的终止符：分享文案里链接后面常直接跟中文，没有空格
  const m = String(text || '').match(/https?:\/\/[^\s"'<>）)】\]\u4e00-\u9fa5，。、；：！？【】（）]+/i);
  if (!m) return '';
  return m[0].replace(/[，。、；：！？,.!?;:'"）)】\]]+$/g, '');
}

// 取全部链接（2026-11-24：一次粘多条攻略一起解析 —— 对标圆周旅迹 5.0 的「多条整合解析」）。
// 去重、保序；同一篇笔记的短链与长链算两条（各自抓，抓回来按 url 去重由上层处理）。
function extractUrls(text) {
  const re = /https?:\/\/[^\s"'<>）)】\]\u4e00-\u9fa5，。、；：！？【】（）]+/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const url = m[0].replace(/[，。、；：！？,.!?;:'"）)】\]]+$/g, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

// 分享文案里的引导语（认出平台用的，不是内容）
const BOILER_PHRASES = [
  /复制打开抖音[，,]?/g,
  /打开(?:Dou|抖)音(?:搜索)?[^，。\n]*[，。]?/gi,
  /复制此链接[^，。\n]*[，。]?/g,
  /复制链接[^，。\n]*[，。]?/g,
  /直接观看视频[！!]?/g,
  /记录世界记录你[，,]?/g,
  /快手极速版[，,]?/g,
  /来小红书[^，。\n]*[，。]?/g,
  /打开APP[^，。\n]*[，。]?/gi,
  /打开小红书[^，。\n]*[，。]?/g,
  /复制本条信息[^，。\n]*[，。]?/g,
  /打开【?[^】\n]{1,12}】?App[^，。\n]*[，。]?/g,
  /查看精彩内容[！!]?/g,
  /源自?【?(?:小红书|抖音|快手|B站|微博|微信)】?App?/g,
  /戳链接[^，。\n]*[，。]?/g,
  /长按复制[^，。\n]*[，。]?/g,
  /更多精彩内容[^，。\n]*[，。]?/g,
  /看看/g,
];

function stripBoilerplate(text) {
  let s = String(text || '');
  BOILER_PHRASES.forEach((re) => {
    s = s.replace(re, '');
  });
  return s.replace(EMOJI_RE, '').trim();
}

// 标题：按平台模板逐个试，成功即止
function extractTitle(text, source_type) {
  const raw = String(text || '').replace(EMOJI_RE, '');
  const url = extractUrl(raw);
  const head = url ? raw.slice(0, raw.indexOf(url)) : raw;

  let m;
  // 抖音/快手：「看看【<作者>的作品】<标题>」
  m = raw.match(/【[^】]{1,24}的作品】\s*([^#\n]{2,80})/);
  if (m) return cleanTitle(m[1]);
  // 小红书 App：「<标题> - 小红书」
  m = raw.match(/([^\n]{2,80}?)\s*[-—|]\s*(?:小红书|抖音|快手|哔哩哔哩|B站|微博)\s*(?=\n|$|https?:)/);
  if (m) return cleanTitle(m[1]);
  // 「【<标题>】」（快手/抖音的标题常挂在链接后面）
  m = raw.match(/【([^】]{2,80})】/);
  if (m) return cleanTitle(m[1]);
  // 兜底：清掉引导语后，取第一段像标题的（≥4 字、非链接）
  const cleaned = stripBoilerplate(head);
  const line = cleaned
    .split(/[\n\r]/)
    .map((l) => l.trim())
    .find((l) => l.length >= 4 && !/^https?:/i.test(l));
  return line ? cleanTitle(line) : '';
}

function cleanTitle(s) {
  let t = String(s || '').replace(EMOJI_RE, '');
  t = t.replace(/^[\s,，。、！!？?\-—|:：]+/, '');
  t = t.split('#')[0]; // 「标题 #话题 #话题」：标题在第一个 # 之前
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 80);
}

// 作者：抖音/快手「【X的作品】」；其余平台「@X」/「X 在小红书」
function extractAuthor(text) {
  const raw = String(text || '');
  let m = raw.match(/【([^】]{1,24})的作品】/);
  if (m) return m[1].trim();
  m = raw.match(/@([A-Za-z0-9_\u4e00-\u9fa5.\-]{1,24})/);
  if (m) return m[1].trim();
  m = raw.match(/([A-Za-z0-9_\u4e00-\u9fa5.\-]{1,24})\s*(?:发布|分享)?\s*在小红书/);
  if (m) return m[1].trim();
  return '';
}

// 页面拿去当「正文」初值：原文去掉链接、引导语、标题与作者
function cleanContent(text, parsed = {}) {
  let s = String(text || '').replace(parsed.url || '', ' ');
  s = stripBoilerplate(s);
  if (parsed.title) s = s.split(parsed.title).join(' ');
  if (parsed.author) s = s.split(parsed.author).join(' ');
  // 视频分享文案里的「看看【X的作品】」模板残渣
  s = s.replace(/【[^】]{0,24}的作品】/g, ' ').replace(/【\s*】/g, ' ');
  const plat = SOURCE_DEFS.map((d) => d.name).concat(['B站', 'b站']);
  return s
    .split(/\n/)
    .map((l) =>
      l
        .trim()
        .replace(/^[0-9]+(\.[0-9]+)?\s+/, '')
        .replace(/^[-—·•|]+\s*/, '')
        .replace(/\s*[-—·•|]+$/, '')
        .trim()
    )
    .filter((l) => l && !plat.includes(l))
    .join('\n')
    .trim();
}

// 分享文案 → 结构化（拆不出的留空，页面可改）
function parseShareText(raw) {
  const text = String(raw || '').trim();
  const url = extractUrl(text);
  const byUrl = url ? sourceOfUrl(url) : null;
  const byWord = sourceOfWords(text);
  const hit = byUrl || byWord;
  const source_type = hit ? hit.source_type : OTHER.type;
  const kind = hit ? hit.kind : OTHER.kind;
  return {
    share_text: text,
    url,
    source: hit ? hit.source : OTHER.name,
    source_type,
    kind,
    title: extractTitle(text, source_type),
    author: extractAuthor(text),
  };
}

// ---------- 地名提取（「按笔记搜地方」第一步，零调用） ----------

// 地名特征词（含其中任意一个就当地名候选）
const PLACE_WORDS = [
  '店', '馆', '铺', '银行', '城', '楼', '厦', '苑', '园', '轩', '阁',
  '咖啡', '茶', '酒馆', '酒吧', '餐厅', '饭店', '饭馆', '面馆', '食堂', '夜市', '市场', '超市',
  '广场', '公园', '花园', '植物园', '动物园', '游乐园', '乐园', '湿地', '景区', '风景区', '度假区',
  '寺', '庙', '祠', '观', '教堂', '山', '峰', '湖', '河', '江', '溪', '桥', '塔', '岛', '湾', '港',
  '海滩', '沙滩', '温泉', '古镇', '古街', '老街', '街', '路', '巷', '弄', '里', '坊', '村', '镇',
  '码头', '机场', '站', '书店', '图书馆', '剧院', '影院', '博物馆', '美术馆', '展览馆', '艺术馆',
  '科技馆', '体育馆', '体育场', '中心', '酒店', '宾馆', '民宿', '客栈', '营地', '峡谷', '瀑布',
  '洞穴', '观景台', '步行街', '大道',
  // 2026-11-24 补：实测「良渚博物院」「日月潭」这类根本抠不出来（词表里没有「院」「潭」）
  '院', '潭', '泉', '洞', '岭', '崖', '洲', '滩', '渡', '关', '陵', '墓',
  '遗址', '故居', '会馆', '书院', '城墙', '石窟', '摩崖',
];

// 明显不是地名的（整段全等即丢）
const NOT_PLACE = new Set([
  '小红书', '抖音', '快手', 'B站', '微博', '视频', '笔记', '图文', '分享', '攻略', '指南', '地图',
  '推荐', '探店', '打卡', '合集', '教程', '日常', '记录', '美食', '景点', '住宿', '游玩', '旅行',
  '旅游', '周末', '假期', '出发', '拍照', '自驾', '交通', '路线', '行程', '预约', '排队', '人均',
  '营业', '时间', '地址', '导航', '停车', '门票', '价格', '必吃', '必去', '必看', '好吃', '好喝',
  '推荐指数', '避雷', '总结', '注意', '第一次', '姐妹', '朋友', '情侣', '亲子', '今天', '昨天',
  '明天', '下次', '这里', '那里', '怎么', '什么', '为什么', '值得', '安排', '清单', '好去处',
]);

// 段首动词/语气词（「打卡南山路」⇒「南山路」）
const LEAD_STRIP = [
  '打卡', '探店', '推荐', '安利', '分享', '去了', '去吃', '去逛', '来到', '去了趟', '喝了',
  '吃了', '住了', '逛了', '逛', '去', '来', '到', '在', '顺路', '顺便', '必去', '必吃',
];

const SPLIT_RE = /[，,。.、；;：:！!？?（）()[\]【】{}|｜/\\~—\-–—\s"“”'’]+/;

// 段内噪声（「必去」「3家」这类形容，不是名字的一部分）
const NOISE_SUBSTR = ['必去', '必吃', '必看', '必打卡', '推荐', '安利', '超赞', '超好', '攻略', '合集', '排行', '清单'];

// 行程笔记里最常见的「时间前缀」：第一天 / 第2天 / D1 / Day2 / 上午 / 下午 / 晚上…
// 它们不是地名的一部分，留着会让高德搜「第一天西湖断桥」直接搜不到（2026-11-24 实测）
const TIME_PREFIX_RE = /^(?:第\s*[一二三四五六七八九十\d]+\s*[天日]|(?:day|d)\s*\d+|上午|下午|中午|早上|早晨|清晨|晚上|夜里|夜晚|傍晚|凌晨|白天|今天|明天|昨天)\s*[:：、,，.\-—]?\s*/i;

function stripLead(s) {
  // 行首的 ▫ 📍 ⏰ ☕ · 这类标记先去掉（笔记正文常用它们当行首）
  let t = String(s || '').replace(/^[^\w\u4e00-\u9fa5]+/, '');
  // 时间前缀可能叠两层（「第一天 上午 灵隐寺」）⇒ 最多剥两次
  for (let i = 0; i < 2; i += 1) {
    const next = t.replace(TIME_PREFIX_RE, '');
    if (next === t) break;
    t = next;
  }
  for (const w of LEAD_STRIP) {
    if (t.startsWith(w) && t.length > w.length + 1) t = t.slice(w.length);
  }
  NOISE_SUBSTR.forEach((w) => {
    t = t.split(w).join('');
  });
  t = t.replace(/[0-9]+\s*[家个处条]/g, '');
  return trimConnectors(t.trim());
}

// 从最后一次「连接字」处切开：「晚上去河坊街」⇒「河坊街」、「停车可以停在涌金广场」⇒「涌金广场」
const CONNECT_CHARS = '的了在和与及就到去看逗吃住玩停能又也还都很超顺然后接被把给从对向当';

function trimConnectors(s) {
  let t = s;
  let cut = -1;
  for (let i = 0; i < t.length - 1; i += 1) {
    if (CONNECT_CHARS.includes(t[i])) cut = i;
  }
  if (cut >= 0 && t.length - cut - 1 >= 2) t = t.slice(cut + 1);
  return t.trim();
}

// 文风噪声（出现就说明它不是地名，而是一句描述）
const NOT_PLACE_SUBSTR = [
  '一家', '这家', '那家', '两家', '三家', '几家', '这些', '那些', '这份', '那份', '值得',
  '必去', '必吃', '必看', '百佳', '新鲜出炉', '合集', '清单', '推荐', '种草', '攻略', '排行',
  '年度', '冲进', '拿下', '不错', '完全', '结果', '发现', '原来', '其实', '终于', '喜欢',
  '朋友', '爱喝', '大家', '一起', '收藏', '快收好', '步行', '地铁',
];

// 抓回来的文案清洗：去链接、去平台自带的分享话术（抖音的 desc 里常混着它自己的分享串）
const TIDY_PHRASES = [
  /https?:\/\/\S+/gi,
  /复制此链接[^，。\n]*[，。]?/g,
  /打开抖音搜索[^，。\n]*[，。]?/g,
  /打开抖音[^，。\n]*[，。]?/g,
  /直接观看视频[！!]?/g,
  /复制本条信息[^，。\n]*[，。]?/g,
  /打开【?[^】\n]{1,12}】?App[^，。\n]*[，。]?/g,
  /查看精彩内容[！!]?/g,
  /\b[A-Za-z0-9]{2,4}:\/\s*[A-Za-z0-9@._-]+/g,
  /\b\d{2}\/\d{2}\b/g,
];

function tidyText(text, maxLen) {
  let t = String(text == null ? '' : text);
  TIDY_PHRASES.forEach((re) => {
    t = t.replace(re, ' ');
  });
  t = t
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return maxLen ? t.slice(0, maxLen) : t;
}

function looksLikePlace(s) {
  if (s.length < 2 || s.length > 14) return false;
  if (NOT_PLACE.has(s)) return false;
  if (/^\d+$/.test(s)) return false;
  // 量词/序数开头（「3个」「2处」「1份」）不是地名。
  // ⚠️ 2026-11-24 收窄：原来还拦了 家/天/年/月/日/楼 ⇒ 把「楼外楼」「天目山」「日月潭」
  // 这些真地名一起误杀了（实测）。只留真正不可能做地名首字的量词。
  if (/^(个|处|条|份|些|种|次|号|栋|室|层|座|期)/.test(s)) return false;
  if (NOT_PLACE_SUBSTR.some((w) => s.includes(w))) return false;
  return PLACE_WORDS.some((w) => s.includes(w));
}

// 一整段里可能塞了好几个地名（「周末去灵隐寺 + 西湖」「停在涌金广场地下车库」）
// ⇒ 先按地名特征词贪婪切出 ≤10 字的子串，切不出来才把整段当一个候选
const PLACE_SUB_RE = new RegExp(
  '([\\u4e00-\\u9fa5A-Za-z0-9%&\\.]{1,10}(?:' + PLACE_WORDS.join('|') + '))',
  'g'
);

function candidatesOf(segment) {
  const seg = String(segment || '').trim();
  if (!seg) return [];
  const hits = seg.match(PLACE_SUB_RE) || [];
  const base = hits.length ? hits : [seg];
  const out = [];
  base.forEach((b) => {
    const name = stripLead(b);
    if (looksLikePlace(name)) out.push(name);
  });
  return out;
}

// 从标题+正文里抠地名候选（去重保序，最多 limit 条）
function extractPlaceNames(input, opts = {}) {
  const src = typeof input === 'string'
    ? { title: '', content: input }
    : { title: (input && input.title) || '', content: (input && input.content) || '' };
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 12;

  // 话题标签、超链接、@某人 都不是地名
  const text = [src.title, src.content]
    .join('\n')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/#[^#\s]{1,30}/g, ' ')
    .replace(/@[A-Za-z0-9_\u4e00-\u9fa5.\-]+/g, ' ')
    .replace(EMOJI_RE, ' ');

  const out = [];
  const seen = new Set();
  text.split(SPLIT_RE).forEach((segRaw) => {
    // 「1. 湖滨银泰in77店」这类行首序号先摘掉
    const seg = segRaw.replace(/^[0-9]+[.、)）]?\s*/, '').trim();
    candidatesOf(seg).forEach((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(name);
    });
  });
  return out.slice(0, limit);
}

module.exports = {
  tidyText,
  parseShareText,
  extractPlaceNames,
  cleanContent,
  extractUrl,
  extractUrls,
  extractTitle,
  extractAuthor,
  sourceOfUrl,
  sourceOfWords,
  nameOfType,
  kindOfType,
  hostOf,
  SOURCE_DEFS,
};
