/* 旅迹 · 极简二维码编码器（2026-11-24，给「手机访问」那张卡用）
   只干一件事：把一小段 ASCII（局域网地址）编成格子矩阵，交给页面画出来。
   范围刻意压到最小：字节模式 + 纠错等级 M + 版本 1–6（最多 106 字节）——
   一个 http://192.168.x.x:8787 最长 30 来字节，用不到更大的版本，
   因此可以省掉「版本信息块」与「多组分块」这些分支。
   实现照 QR 规范走：数据码 → RS 纠错码 → 交错 → 铺模块（定位/校准/定时/格式）
   → 八种掩码逐一代入、按四条罚分挑最好的那个 → 写格式信息。
   浏览器与 Node 两用（测试要 require 它）：window.TravelQR / module.exports。 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TravelQR = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 版本 → [每块纠错码字数, 块数, 每块数据码字数]（等级 M；版本 1–6 都是等分块、无余数块）
  var EC_M = {
    1: [10, 1, 16],
    2: [16, 1, 28],
    3: [26, 1, 44],
    4: [18, 2, 32],
    5: [24, 2, 43],
    6: [16, 4, 27],
  };
  // 校准图案中心坐标（版本 1 没有）
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
  var EC_LEVEL_BITS = 0; // M = 00

  // ---------- GF(256) ----------
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // 生成多项式 ∏(x − a^i)，i = 0..deg-1
  function rsGenerator(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= mul(poly[j], 1);
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  // 一段数据码 → 纠错码（多项式除法取余）
  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (var j = 0; j < gen.length - 1; j++) res[j] ^= mul(gen[j + 1], factor);
      }
    }
    return res;
  }

  // ---------- 数据码 ----------
  function toBytes(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function dataCodewords(version) {
    var t = EC_M[version];
    return t[1] * t[2];
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 6; v++) {
      // 4 bit 模式 + 8 bit 长度（版本 1–9 都是 8 位）
      if (4 + 8 + byteLen * 8 <= dataCodewords(v) * 8) return v;
    }
    return 0;
  }

  function buildCodewords(text) {
    var bytes = toBytes(text);
    var version = pickVersion(bytes.length);
    if (!version) return null;
    var cap = dataCodewords(version) * 8;
    var bits = [];
    function push(value, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    }
    push(0x4, 4); // 字节模式
    push(bytes.length, 8);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);
    var remaining = cap - bits.length;
    var terminator = Math.min(4, remaining);
    for (var t = 0; t < terminator; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var codewords = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      codewords.push(v);
    }
    var pad = [0xec, 0x11];
    var p = 0;
    while (codewords.length < dataCodewords(version)) {
      codewords.push(pad[p++ % 2]);
    }
    // 分块 + 纠错 + 交错
    var conf = EC_M[version];
    var ecLen = conf[0];
    var blocks = conf[1];
    var perBlock = conf[2];
    var dataBlocks = [];
    var ecBlocks = [];
    for (var n = 0; n < blocks; n++) {
      var chunk = codewords.slice(n * perBlock, (n + 1) * perBlock);
      dataBlocks.push(chunk);
      ecBlocks.push(rsEncode(chunk, ecLen));
    }
    var out = [];
    for (var c = 0; c < perBlock; c++) {
      for (var m = 0; m < blocks; m++) out.push(dataBlocks[m][c]);
    }
    for (var e = 0; e < ecLen; e++) {
      for (var m2 = 0; m2 < blocks; m2++) out.push(ecBlocks[m2][e]);
    }
    return { version: version, codewords: out };
  }

  // ---------- 铺模块 ----------
  function newMatrix(size) {
    var m = [];
    for (var i = 0; i < size; i++) m.push(new Array(size).fill(0));
    return m;
  }

  function makeBase(version) {
    var size = version * 4 + 17;
    var m = newMatrix(size);
    var fixed = newMatrix(size); // 1＝功能模块（不参与掩码）

    function set(r, c, v) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      m[r][c] = v ? 1 : 0;
      fixed[r][c] = 1;
    }
    // 定位图案 + 分隔带
    function finder(r0, c0) {
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          var dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          set(r0 + r, c0 + c, dark ? 1 : 0);
        }
      }
    }
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);
    // 定时图案
    for (var i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0 ? 1 : 0);
      set(i, 6, i % 2 === 0 ? 1 : 0);
    }
    // 校准图案
    var centers = ALIGN[version] || [];
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var r0 = centers[a];
        var c0 = centers[b];
        if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === size - 7) || (r0 === size - 7 && c0 === 6)) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var darkA = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            set(r0 + dr, c0 + dc, darkA ? 1 : 0);
          }
        }
      }
    }
    // 固定深色模块
    set(size - 8, 8, 1);
    // 预留格式信息区（先占位，后面写真正的值）
    for (var k = 0; k <= 8; k++) {
      if (k !== 6) {
        set(8, k, 0);
        set(k, 8, 0);
      }
    }
    for (var k2 = 0; k2 < 8; k2++) {
      set(8, size - 1 - k2, 0);
      set(size - 1 - k2, 8, 0);
    }
    return { size: size, modules: m, fixed: fixed };
  }

  function placeData(base, codewords) {
    var size = base.size;
    var m = base.modules;
    var fixed = base.fixed;
    var bits = [];
    for (var i = 0; i < codewords.length; i++) {
      for (var b = 7; b >= 0; b--) bits.push((codewords[i] >> b) & 1);
    }
    // 版本 2–6 都有 7 个剩余位（补 0 即可，规范允许）
    var idx = 0;
    var up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5; // 跳过竖向定时图案那一列
      for (var step = 0; step < size; step++) {
        var row = up ? size - 1 - step : step;
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (fixed[row][cc]) continue;
          m[row][cc] = idx < bits.length ? bits[idx++] : 0;
        }
      }
      up = !up;
    }
  }

  var MASK = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; },
  ];

  function formatBits(mask) {
    var data = (EC_LEVEL_BITS << 3) | mask;
    var v = data << 10;
    for (var i = 4; i >= 0; i--) {
      if ((v >> (i + 10)) & 1) v ^= 0x537 << i;
    }
    return ((data << 10) | v) ^ 0x5412;
  }

  function applyFormat(base, mask) {
    var size = base.size;
    var m = base.modules;
    var bits = formatBits(mask);
    function bit(i) { return (bits >> i) & 1; }
    // 第一份：从 (8,0) 往左下绕到 (0,8)，高位在前
    var path = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    for (var i = 0; i < 15; i++) m[path[i][0]][path[i][1]] = bit(14 - i);
    // 第二份：左下往上 7 个（高位），再右上一行 8 个（低位）
    for (var k = 0; k < 7; k++) m[size - 1 - k][8] = bit(14 - k);
    for (var j = 0; j < 8; j++) m[8][size - 8 + j] = bit(7 - j);
    m[size - 8][8] = 1; // 固定深色（此位置在第二份预留区里，规范如此）
  }

  function penalty(m) {
    var size = m.length;
    var score = 0;
    // ① 同色连排
    function scanLine(get, len) {
      var line = 0;
      for (var i = 0; i < len; i++) {
        var same = i > 0 && get(i) === get(i - 1);
        if (same) line++;
        else line = 0;
        if (line === 5) score += 3;
        else if (line > 5) score += 1;
      }
    }
    for (var r = 0; r < size; r++) scanLine(function (c) { return m[r][c]; }, size);
    for (var c2 = 0; c2 < size; c2++) scanLine(function (rr) { return m[rr][c2]; }, size);
    // ② 2×2 同色块
    for (var r2 = 0; r2 < size - 1; r2++) {
      for (var c3 = 0; c3 < size - 1; c3++) {
        var v = m[r2][c3];
        if (v === m[r2][c3 + 1] && v === m[r2 + 1][c3] && v === m[r2 + 1][c3 + 1]) score += 3;
      }
    }
    // ③ 1:1:3:1:1 且一侧有 4 个浅色
    var pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matchAt(get, i, p) {
      for (var k = 0; k < 11; k++) if (get(i + k) !== p[k]) return false;
      return true;
    }
    for (var r3 = 0; r3 < size; r3++) {
      for (var c4 = 0; c4 <= size - 11; c4++) {
        var g = (function (rr) { return function (i) { return m[rr][i]; }; })(r3);
        if (matchAt(g, c4, pat) || matchAt(g, c4, pat2)) score += 40;
      }
    }
    for (var c5 = 0; c5 < size; c5++) {
      for (var r4 = 0; r4 <= size - 11; r4++) {
        var g2 = (function (cc) { return function (i) { return m[i][cc]; }; })(c5);
        if (matchAt(g2, r4, pat) || matchAt(g2, r4, pat2)) score += 40;
      }
    }
    // ④ 深浅比例
    var dark = 0;
    for (var r5 = 0; r5 < size; r5++) for (var c6 = 0; c6 < size; c6++) dark += m[r5][c6];
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function encode(text) {
    var built = buildCodewords(String(text));
    if (!built) return null;
    var base = makeBase(built.version);
    placeData(base, built.codewords);
    var best = null;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var m = base.modules.map(function (row) { return row.slice(); });
      var f = base.fixed;
      var cond = MASK[mask];
      for (var r = 0; r < base.size; r++) {
        for (var c = 0; c < base.size; c++) {
          if (!f[r][c] && cond(r, c)) m[r][c] ^= 1;
        }
      }
      var candidate = { size: base.size, modules: m, fixed: f };
      applyFormat(candidate, mask);
      var s = penalty(m);
      if (s < bestScore) {
        bestScore = s;
        best = { version: built.version, mask: mask, size: base.size, modules: m };
      }
    }
    return best;
  }

  // 画成 SVG 字符串（页面直接塞进容器；一个模块一个格子，扫描用）
  function toSvg(qr, opts) {
    opts = opts || {};
    var quiet = opts.quiet == null ? 4 : opts.quiet;
    var dark = opts.dark || '#14210f';
    var light = opts.light || '#ffffff';
    var n = qr.size + quiet * 2;
    var path = '';
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) path += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img">' +
      '<rect width="' + n + '" height="' + n + '" fill="' + light + '"/>' +
      '<path d="' + path + '" fill="' + dark + '"/>' +
      '</svg>'
    );
  }

  return { encode: encode, toSvg: toSvg, capacityBytes: function () { return 106; } };
});
