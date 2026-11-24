// 分享文案解析 + 地名提取（纯函数，不起服务）
const test = require('node:test');
const assert = require('node:assert');

const {
  parseShareText,
  extractPlaceNames,
  cleanContent,
  extractUrl,
  sourceOfUrl,
  hostOf,
} = require('../server/note-share');

test('extractUrl / hostOf：链接取自文案，尾巴上的中文标点不粘进 URL', () => {
  const t = '标题在此 https://v.douyin.com/iJabcDE/，复制此链接打开抖音';
  assert.strictEqual(extractUrl(t), 'https://v.douyin.com/iJabcDE/');
  assert.strictEqual(hostOf('https://www.xiaohongshu.com/explore/abc'), 'www.xiaohongshu.com');
  assert.strictEqual(hostOf('v.kuaishou.com/abc'), 'v.kuaishou.com');
  assert.strictEqual(extractUrl('没有链接的正文'), '');
});

test('sourceOfUrl：六个平台的短链/主域都认得，含子域', () => {
  const cases = [
    ['https://v.douyin.com/iJabc/', 'douyin'],
    ['https://www.douyin.com/video/123', 'douyin'],
    ['http://xhslink.com/a/abcdef', 'xhs'],
    ['https://www.xiaohongshu.com/explore/abc', 'xhs'],
    ['https://v.kuaishou.com/abcDEF', 'kuaishou'],
    ['https://www.kuaishou.com/short-video/1', 'kuaishou'],
    ['https://b23.tv/abcdE', 'bilibili'],
    ['https://www.bilibili.com/video/BV1', 'bilibili'],
    ['https://weibo.com/1234/abcd', 'weibo'],
    ['https://t.cn/AbCdE', 'weibo'],
    ['https://mp.weixin.qq.com/s/abc', 'wechat'],
  ];
  cases.forEach(([url, want]) => {
    const got = sourceOfUrl(url);
    assert.strictEqual(got && got.source_type, want, url);
  });
  assert.strictEqual(sourceOfUrl('https://example.com/x'), null, '不认识的域名不算平台');
  assert.strictEqual(sourceOfUrl(''), null);
});

test('parseShareText：抖音分享文案（看看【X的作品】标题 + 短链）', () => {
  const text =
    '7.68 复制打开抖音，看看【郑嘉练的作品】健身房小白必看：三个动作练出直角肩 # 健身 # 塑形 https://v.douyin.com/iJabcDE/ 复制此链接，打开Dou音搜索，直接观看视频！';
  const p = parseShareText(text);
  assert.strictEqual(p.source, '抖音');
  assert.strictEqual(p.source_type, 'douyin');
  assert.strictEqual(p.kind, 'video');
  assert.strictEqual(p.author, '郑嘉练');
  assert.match(p.title, /健身房小白必看/);
  assert.ok(!p.title.includes('#'), '话题不进标题');
  assert.strictEqual(p.url, 'https://v.douyin.com/iJabcDE/');
});

test('parseShareText：小红书分享文案（标题 - 小红书）', () => {
  const text = '杭州咖啡地图｜10 家私藏 🥰 - 小红书\nhttp://xhslink.com/a/abcdef 复制本条信息，打开【小红书】App查看精彩内容！';
  const p = parseShareText(text);
  assert.strictEqual(p.source, '小红书');
  assert.strictEqual(p.source_type, 'xhs');
  assert.strictEqual(p.kind, 'note');
  assert.match(p.title, /杭州咖啡地图/);
  assert.strictEqual(p.url, 'http://xhslink.com/a/abcdef');
});

test('parseShareText：快手/微博/无链接都有一套兜底', () => {
  const ks = parseShareText('快手极速版，记录世界记录你 https://v.kuaishou.com/abcDEF 【夜爬泰山看日出】');
  assert.strictEqual(ks.source, '快手');
  assert.strictEqual(ks.source_type, 'kuaishou');
  assert.strictEqual(ks.kind, 'video');
  assert.match(ks.title, /夜爬泰山/);

  const wb = parseShareText('@阿茶 分享了成都三日游攻略 来自微博 https://weibo.com/1/2');
  assert.strictEqual(wb.source, '微博');
  assert.strictEqual(wb.author, '阿茶');

  const none = parseShareText('只贴一段正文：第一天去了西湖，晚上吃楼外楼');
  assert.strictEqual(none.source_type, 'other');
  assert.strictEqual(none.source, '其他');
  assert.strictEqual(none.url, '');
  assert.strictEqual(none.kind, 'note');
});

test('parseShareText：标题 + 平台名 + 链接挤在一行也认（小红书分享文案常见）', () => {
  const p = parseShareText('杭州咖啡地图 - 小红书 http://xhslink.com/a/abc123');
  assert.strictEqual(p.source, '小红书');
  assert.strictEqual(p.title, '杭州咖啡地图', '别把「 - 小红书」带进标题');
  assert.strictEqual(p.url, 'http://xhslink.com/a/abc123');
  const clean = cleanContent('杭州咖啡地图 - 小红书 http://xhslink.com/a/abc123', p);
  assert.ok(!clean.includes('小红书'), '正文里也别留平台名：' + clean);
});

test('extractPlaceNames：从正文抠地名候选（话题/链接/@/emoji 不算）', () => {
  const content = [
    '杭州3家必去咖啡店，附地址',
    '1. %Arabica 湖滨银泰店，拿铁超赞',
    '2. Seesaw 南山路店，落地窗能看西湖',
    '3. Manner 嘉里中心店，人均 25',
    '晚上去河坊街吃小吃，顺路逛了吴山广场',
    '停车可以停在涌金广场地下车库',
    '#杭州美食 #咖啡地图',
    '更多精彩内容请看主页 https://example.com/x @小红书',
  ].join('\n');
  const names = extractPlaceNames({ title: '杭州咖啡地图｜10 家私藏', content });
  assert.ok(names.includes('南山路店'), '带「店」的段落是候选：' + JSON.stringify(names));
  assert.ok(names.includes('河坊街'), '顺路逛的街能抠出来：' + JSON.stringify(names));
  assert.ok(names.includes('吴山广场'));
  assert.ok(!names.some((n) => n.includes('杭州美食')), '话题不算地名');
  assert.ok(!names.some((n) => /^https?:/.test(n)), '链接不算地名');
  assert.ok(!names.includes('美食'), '泛词不算地名');
  assert.ok(names.length <= 12);
});

test('extractPlaceNames：去重保序 + 上限 + 泛词剔除', () => {
  const content = '西湖 西湖 西湖 美食 推荐 攻略 西湖';
  const names = extractPlaceNames(content);
  assert.deepStrictEqual(names, ['西湖']);
  const many = [
    '西湖', '灵隐寺', '河坊街', '吴山广场', '南山路', '北山街', '雷峰塔', '六和塔',
    '九溪', '龙井村', '虎跑', '满觉陇', '云栖竹径', '宋城', '钱王祠',
  ].join('、');
  const capped = extractPlaceNames({ title: '', content: many }, { limit: 5 });
  assert.strictEqual(capped.length, 5);
});

test('cleanContent：正文初值去掉链接/引导语/遗留平台字样', () => {
  const text = [
    '杭州咖啡地图｜3 家私藏 🥰 - 小红书',
    '1. Seesaw 南山路店，落地窗能看西湖',
    '#杭州美食',
    'http://xhslink.com/a/abc123 复制本条信息，打开【小红书】App查看精彩内容！',
  ].join('\n');
  const p = parseShareText(text);
  const clean = cleanContent(text, p);
  assert.ok(!clean.includes('http'), '链接不留：' + clean);
  assert.ok(!clean.includes('复制本条信息'), '引导语不留：' + clean);
  assert.ok(!clean.includes('杭州咖啡地图｜3 家私藏'), '标题不和正文重复：' + clean);
  assert.ok(!/^\s*[-—]?\s*小红书\s*$/m.test(clean), '遗留下来的平台名行要去掉');
  assert.match(clean, /Seesaw 南山路店/);
});

test('cleanContent：抖音视频文案也清得干净（作者/作品的模板残渣）', () => {
  const text =
    '7.68 复制打开抖音，看看【郑嘉练的作品】杭州健身房探店：湖滨银泰和吴山广场 # 健身 https://v.douyin.com/iJabcDE/ 复制此链接，打开Dou音搜索，直接观看视频！';
  const p = parseShareText(text);
  const clean = cleanContent(text, p);
  assert.ok(!clean.includes('的作品'), '模板残渣不留：' + clean);
  assert.ok(!clean.includes('复制打开抖音'), '引导语不留：' + clean);
  assert.ok(!/^7\.68/.test(clean), '行首的播放量数字不留');
  assert.ok(!clean.includes('郑嘉练'), '作者不与正文重复');
});

test('extractPlaceNames：标题里的地名也算（用户常把地名写标题）', () => {
  const names = extractPlaceNames({ title: '周末去灵隐寺 + 西湖', content: '' });
  assert.ok(names.includes('灵隐寺'));
  assert.ok(names.includes('西湖'));
});

// 2026-11-24：行程笔记里最常见的「时间前缀」不能当地名的一部分
// （实测「第一天西湖断桥」拿去高德搜必然搜不到 ⇒ 补全全失败）
test('extractPlaceNames：剥掉「第一天 / 上午 / 晚上 / D1」这类时间前缀', () => {
  const cases = [
    ['第一天西湖断桥', '西湖断桥'],
    ['第二天西溪湿地', '西溪湿地'],
    ['第三天宋城', '宋城'],
    ['晚上河坊街', '河坊街'],
    ['上午灵隐寺', '灵隐寺'],
    ['下午良渚博物院', '良渚博物院'],
    ['D1 西湖', '西湖'],
    ['Day2 西溪', '西溪'],
    ['第1天 西湖', '西湖'],
  ];
  cases.forEach(([input, want]) => {
    const names = extractPlaceNames({ title: '', content: input }, { limit: 3 });
    assert.ok(names.includes(want), input + ' 应抠出 ' + want + '，实际 ' + JSON.stringify(names));
    assert.ok(
      !names.some((n) => /^(第[一二三四五六七八九十\d]+天|上午|下午|晚上|中午|早上|傍晚|day|d\d)/i.test(n)),
      input + ' 不该带时间前缀：' + JSON.stringify(names)
    );
  });
});

// 2026-11-24：词表漏了「院/潭/泉/岭…」⇒「良渚博物院」「日月潭」根本抠不出来
test('extractPlaceNames：博物院 / 潭 / 楼 这类真地名能抠出来', () => {
  ['良渚博物院', '日月潭', '楼外楼', '天目山', '浙江省博物院'].forEach((name) => {
    const names = extractPlaceNames({ title: '', content: name }, { limit: 3 });
    assert.ok(names.includes(name), name + ' 应被识别，实际 ' + JSON.stringify(names));
  });
});
