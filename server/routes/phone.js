'use strict';
/*
 * 手机访问（2026-11-24 用户「手机也能用」）：
 *   GET /api/phone   这台机器上、能在同一 Wi-Fi 里打开的地址
 *
 * 为什么要有这个接口：服务默认只听 127.0.0.1 时，手机永远打不开；
 * 就算改成 0.0.0.0，用户也得自己知道本机局域网 IP。这里把网卡过一遍，
 * 只挑私网 IPv4（192.168 / 10. / 172.16-31），把可直接用的地址算好给页面。
 */

const os = require('os');

// 私网 IPv4 才算「手机能用」；回环与公网都挑出去
function isPrivateV4(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// 网卡名排出个先后：Wi-Fi / 有线在前，虚拟网卡（docker/utun/bridge/vmnet）在后
function ifaceRank(name) {
  if (/^(en|eth)\d+$/i.test(name)) return 0;
  if (/^(wl|wlan)/i.test(name)) return 1;
  if (/^(bridge|vmnet|docker|veth|utun|tun|tap|llw|awdl)/i.test(name)) return 3;
  return 2;
}

function lanAddresses(port) {
  const out = [];
  const nets = os.networkInterfaces() || {};
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((info) => {
      if (!info || info.internal) return;
      const family = typeof info.family === 'string' ? info.family : info.family === 4 ? 'IPv4' : 'IPv6';
      if (family !== 'IPv4') return;
      if (!isPrivateV4(info.address)) return;
      out.push({ iface: name, ip: info.address, url: `http://${info.address}:${port}` });
    });
  });
  out.sort((a, b) => (ifaceRank(a.iface) - ifaceRank(b.iface)) || a.ip.localeCompare(b.ip));
  return out;
}

const routes = [
  {
    method: 'GET',
    path: '/api/phone',
    handler(ctx) {
      const port = (ctx.config && ctx.config.port) || 8787;
      const host = process.env.HOST || '0.0.0.0';
      const lan = lanAddresses(port);
      return {
        port,
        // 只听本机时手机连不上，页面要照实说，不能假装能把地址发出去
        lanOpen: host !== '127.0.0.1' && host !== 'localhost',
        host,
        addresses: lan,
        primary: lan.length ? lan[0].url : null,
        // 手机上要登录同一个账号；凭据就是本机这套用户名口令
        note: '同一 Wi-Fi 下打开，用同一个账号登录',
      };
    },
  },
];

// 启动日志也要用（server/index.js）
routes.lanAddresses = lanAddresses;

module.exports = routes;
