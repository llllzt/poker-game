/*
 * 德州扑克 —— 局域网游戏服务器（零依赖，仅用 Node 内置模块）
 *
 * 用途：
 *  - 在自己电脑 / 内网机器上运行：node server.js
 *  - 同一 WiFi 下的手机 / 电脑打开 http://<本机局域网IP>:3000 即可加入。
 *  - 本服务器是"权威节点"，在内存中运行游戏引擎(Room)，通过 SSE 向各客户端
 *    实时推送状态；客户端操作通过 HTTP 接口上报。完全不依赖外网。
 *
 * 前端会自动探测：若页面来自本服务器（/api/health 命中），则走"服务器模式"；
 * 若来自静态托管（如 CloudStudio），探测失败则回退到 P2P 模式。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const crypto = require('crypto');
const Engine = require('./engine');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// code(大写) -> Room
const rooms = new Map();
// SSE 客户端：{ res, code, playerId }
const sseClients = [];

function getRoom(code, create) {
  let r = rooms.get(code);
  if (!r && create) {
    r = new Engine.Room({ code: code, startingChips: 1000, smallBlind: 10, bigBlind: 20 });
    rooms.set(code, r);
  }
  return r;
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(c));
  return c;
}

// 向某房间所有已订阅客户端推送其个性化状态
function pushRoom(room) {
  sseClients.forEach(function (c) {
    if (c.code === room.code && c.res && !c.res.destroyed) {
      try {
        c.res.write('data: ' + JSON.stringify({ type: 'state', state: room.serialize(c.playerId) }) + '\n\n');
      } catch (e) { /* 连接已断，稍后 close 事件清理 */ }
    }
  });
}

// 超时托管 / 挂机自动弃牌（与 P2P 房主侧逻辑一致）：每秒检查所有房间
setInterval(function () {
  rooms.forEach(function (room) {
    if (room.stage === 'waiting' || room.stage === 'showdown') return;
    const p = room.getPlayerBySeat(room.turnSeat);
    if (!p || p.folded || p.allIn || !p.connected) return;
    let acted = false;
    if (p.sitOut) {
      room.doAction(p.id, 'fold');
      room.message = p.name + ' 挂机自动弃牌';
      acted = true;
    } else if (Date.now() - room.turnStartedAt > room.turnTime * 1000) {
      const toCall = Math.max(0, room.currentBet - p.bet);
      const action = toCall <= 0 ? 'check' : (p.chips >= toCall ? 'call' : 'fold');
      room.doAction(p.id, action, undefined);
      p.sitOut = true; // 超时一次即进入托管，直到点「回桌」
      const label = action === 'check' ? '过牌' : (action === 'call' ? '跟注' : '弃牌');
      room.message = p.name + ' 超时自动' + label + '（已挂机）';
      acted = true;
    }
    if (acted) pushRoom(room);
  });
}, 1000);

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let data = '';
  req.on('data', function (c) {
    data += c;
    if (data.length > 1e6) req.destroy(); // 防滥用
  });
  req.on('end', function () {
    let b = {};
    try { b = JSON.parse(data || '{}'); } catch (e) { b = {}; }
    cb(b);
  });
}

function lanIPs() {
  const ifs = os.networkInterfaces();
  const out = [];
  Object.keys(ifs).forEach(function (k) {
    (ifs[k] || []).forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    });
  });
  return out;
}

// ---------------- HTTP 路由 ----------------
const server = http.createServer(function (req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ---- API：优先于静态文件 ----
  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, mode: 'server' });
    return;
  }

  // 房间目录：返回当前服务器上所有房间（仅同局域网可见）
  if (pathname === '/api/rooms') {
    const list = [];
    rooms.forEach(function (r, code) {
      const host = r.getPlayer(r.hostId);
      list.push({
        code: code,
        name: r.name || '牌局',
        count: r.players.length,
        stage: r.stage,
        hostName: host ? host.name : ''
      });
    });
    sendJson(res, 200, { rooms: list });
    return;
  }

  // 创建房间：服务器分配房间码并建房，房主即首位玩家
  if (pathname === '/api/create' && req.method === 'POST') {
    readBody(req, function (body) {
      const name = ((body.name || '牌局').toString().trim().slice(0, 24)) || '牌局';
      const code = genCode();
      const room = new Engine.Room({ code: code, name: name, startingChips: 1000, smallBlind: 10, bigBlind: 20 });
      rooms.set(code, room);
      const pid = body.playerId || ('s_' + crypto.randomBytes(6).toString('hex'));
      room.addPlayer(pid, body.hostName || '房主', true);
      sendJson(res, 200, { code: code, playerId: pid, isHost: true, state: room.serialize(pid) });
      pushRoom(room);
    });
    return;
  }

  if (pathname === '/api/join' && req.method === 'POST') {
    readBody(req, function (body) {
      const code = (body.code || '').toUpperCase();
      if (!code) return sendJson(res, 400, { error: '缺少房间码' });
      const room = rooms.get(code); // 目录模式：房间须先经 /api/create 建立
      if (!room) return sendJson(res, 404, { error: '房间不存在或已解散' });
      let pid = body.playerId;
      let p = pid ? room.getPlayer(pid) : null;
      if (p) {
        p.name = body.name || p.name;
        p.connected = true;
      } else {
        // 合并：等待阶段同名离线玩家视为同一人换设备，复用其 id（避免多设备累积重复条目）
        if (room.stage === 'waiting' && body.name) {
          for (let i = 0; i < room.players.length; i++) {
            const pp = room.players[i];
            if (pp.name === body.name && !pp.connected) { pid = pp.id; p = pp; break; }
          }
        }
        if (!p) {
          pid = pid || ('s_' + crypto.randomBytes(6).toString('hex'));
          p = room.addPlayer(pid, body.name || '玩家', true);
        } else {
          p.name = body.name || p.name;
          p.connected = true;
        }
      }
      sendJson(res, 200, { playerId: pid, isHost: (room.hostId === pid), state: room.serialize(pid) });
      pushRoom(room);
    });
    return;
  }

  if (pathname === '/api/action' && req.method === 'POST') {
    readBody(req, function (body) {
      const room = rooms.get((body.code || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const r = room.doAction(body.playerId, body.action, body.amount);
      if (r && r.error) return sendJson(res, 400, { error: r.error });
      sendJson(res, 200, { ok: true });
      pushRoom(room);
    });
    return;
  }

  if (pathname === '/api/control' && req.method === 'POST') {
    readBody(req, function (body) {
      const room = rooms.get((body.code || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      if (room.hostId !== body.playerId) return sendJson(res, 403, { error: '只有房主可以操作' });
      let ok = false, err = null;
      if (body.op === 'start' || body.op === 'next') ok = room.startHand();
      else if (body.op === 'reset') { room.resetChips(); ok = true; }
      if (!ok) err = '操作失败（人数不足或当前状态不可操作）';
      if (err) return sendJson(res, 400, { error: err });
      sendJson(res, 200, { ok: true });
      pushRoom(room);
    });
    return;
  }

  if (pathname === '/api/leave' && req.method === 'POST') {
    readBody(req, function (body) {
      const code = (body.code || '').toUpperCase();
      const room = rooms.get(code);
      if (room) {
        room.removePlayer(body.playerId);
        if (room.players.length === 0 || room.players.every(function (p) { return !p.connected; })) rooms.delete(code); // 全员离线即清理，避免目录残留
        else pushRoom(room);
      }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // 挂机/回桌：标记 sitOut，轮到该玩家时自动弃牌，直到回桌
  if (pathname === '/api/sitout' && req.method === 'POST') {
    readBody(req, function (body) {
      const room = rooms.get((body.code || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const p = room.getPlayer(body.playerId);
      if (!p) return sendJson(res, 404, { error: '玩家不存在' });
      p.sitOut = !!body.sitOut;
      sendJson(res, 200, { ok: true });
      pushRoom(room);
    });
    return;
  }

  // 改名：仅本人可改自己的昵称
  if (pathname === '/api/rename' && req.method === 'POST') {    readBody(req, function (body) {
      const room = rooms.get((body.code || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const p = room.getPlayer(body.playerId);
      if (!p) return sendJson(res, 404, { error: '玩家不存在' });
      const name = (body.name || '').toString().trim().slice(0, 10);
      if (!name) return sendJson(res, 400, { error: '昵称不能为空' });
      p.name = name;
      sendJson(res, 200, { ok: true });
      pushRoom(room);
    });
    return;
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    const code = (parsed.query.code || '').toUpperCase();
    const pid = parsed.query.playerId;
    const room = rooms.get(code);
    if (!room || !room.getPlayer(pid)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('room/player not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    const client = { res: res, code: code, playerId: pid };
    sseClients.push(client);
    const p = room.getPlayer(pid);
    if (p) p.connected = true;
    // 立即下发当前状态
    res.write('data: ' + JSON.stringify({ type: 'state', state: room.serialize(pid) }) + '\n\n');
    req.on('close', function () {
      const i = sseClients.indexOf(client);
      if (i >= 0) sseClients.splice(i, 1);
      const pl = room.getPlayer(pid);
      if (pl) pl.connected = false;
      // 全员离线则清理房间，避免目录残留
      if (room.players.length > 0 && room.players.every(function (p) { return !p.connected; })) rooms.delete(code);
      else pushRoom(room);
    });
    return;
  }

  // ---- 静态文件 ----
  let urlPath = decodeURIComponent(pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('\n🂡 德州扑克已启动（局域网服务器模式）');
  console.log('   本机访问   : http://localhost:' + PORT);
  const ips = lanIPs();
  if (ips.length) {
    console.log('   同 WiFi 手机: ' + ips.map(function (ip) { return 'http://' + ip + ':' + PORT; }).join('   或   '));
    console.log('   ↑ 把上面"同 WiFi 手机"地址发给朋友，他们在手机浏览器打开即可加入。');
  } else {
    console.log('   （未检测到可用局域网网卡，请确认已连接 WiFi/有线网络）');
  }
  console.log('   说明：本机即发牌服务器，无需联网；关闭此窗口即结束游戏。');
  console.log('   房间目录：加入者打开本地址即可看到房间名、点击加入，无需输房间码。\n');
});
