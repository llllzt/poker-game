/*
 * 统一网络层
 *  - 优先探测"局域网游戏服务器"（同源 /api/health 命中）→ 服务器模式（SSE 推送 + HTTP 操作）。
 *  - 探测失败（如来自 CloudStudio 等纯静态托管）→ 回退 P2P 模式（PeerJS，房主浏览器为权威节点）。
 * 对外暴露统一 API：connect(opts) -> { mode, sendAction, startGame, nextHand, resetChips, leave, destroy }
 *   opts: { role:'host'|'client', code, name, playerId, onState, onError, onStatus, onWelcome }
 */
(function (global) {
  'use strict';
  var PokerEngine = global.PokerEngine;
  var Peer = global.Peer;

  function genId() { return 'p_' + Math.random().toString(36).slice(2, 10); }
  function peerIdFor(code) { return 'texas_' + code; }

  // ---------------- P2P 模式（PeerJS，房主权威） ----------------
  function startP2P(opts, api) {
    var code = (opts.code || '').toUpperCase();
    var name = opts.name || '玩家';
    var playerId = opts.playerId || genId();
    api.mode = 'p2p';

    if (opts.role === 'host') {
      var room = new PokerEngine.Room({ code: code, startingChips: 1000, smallBlind: 10, bigBlind: 20 });
      room.addPlayer(playerId, name);                 // 房主 id 与前端 myId 保持一致
      var conns = {};
      var peer = new Peer(peerIdFor(code), { debug: 0 });
      api.playerId = playerId;

      function broadcast() {
        Object.keys(conns).forEach(function (pid) {
          var c = conns[pid];
          if (c && c.open) c.send({ type: 'state', state: room.serialize(pid) });
        });
        if (api.onState) api.onState(room.serialize(playerId));
      }
      peer.on('open', function () { if (api.onStatus) api.onStatus('房主已就绪 · 等待加入'); broadcast(); });
      peer.on('connection', function (conn) {
        conn.on('data', function (msg) { handle(conn, msg); });
        conn.on('close', function () {
          var pid = conn._pid;
          if (pid) { var p = room.getPlayer(pid); if (p) p.connected = false; delete conns[pid]; broadcast(); }
        });
        conn.on('error', function () { });
      });
      peer.on('error', function (err) {
        if (err && err.type === 'unavailable-id') { if (api.onError) api.onError('房间码冲突，请返回重试'); }
        else { if (api.onError) api.onError('房主连接异常：' + (err && err.type || '未知')); }
      });

      function handle(conn, msg) {
        if (!msg || !msg.type) return;
        if (msg.type === 'join') {
          var pid = msg.playerId && room.getPlayer(msg.playerId) ? msg.playerId : genId();
          var p = room.addPlayer(pid, msg.name || '玩家', true);
          conns[pid] = conn; conn._pid = pid;
          conn.send({ type: 'welcome', playerId: pid, state: room.serialize(pid) });
          broadcast();
        } else if (msg.type === 'reconnect') {
          var ex = room.getPlayer(msg.playerId);
          if (ex) {
            ex.connected = true; if (msg.name) ex.name = msg.name;
            conns[msg.playerId] = conn; conn._pid = msg.playerId;
            conn.send({ type: 'welcome', playerId: msg.playerId, state: room.serialize(msg.playerId) });
            broadcast();
          } else { handle(conn, { type: 'join', name: msg.name, playerId: msg.playerId }); }
        } else if (msg.type === 'action') {
          var res = room.doAction(msg.playerId, msg.action, msg.amount);
          if (res && res.error && conn.open) conn.send({ type: 'error', msg: res.error });
          broadcast();
        } else if (msg.type === 'rename') {
          room.renamePlayer(msg.playerId, msg.name);
          broadcast();
        } else if (msg.type === 'leave') {
          room.removePlayer(msg.playerId); delete conns[msg.playerId]; broadcast();
        }
      }

      api.startGame = function () { if (!room.startHand()) { if (api.onError) api.onError('人数不足，至少需要 2 人'); } else broadcast(); };
      api.nextHand = function () { if (!room.startHand()) { if (api.onError) api.onError('人数不足，无法开始下一手（可重置筹码）'); } else broadcast(); };
      api.resetChips = function () { room.resetChips(); broadcast(); };
      api.sendAction = function (t, a) { var r = room.doAction(playerId, t, a); if (r && r.error && api.onError) api.onError(r.error); broadcast(); };
      api.rename = function (name) { if (room.renamePlayer(playerId, name)) broadcast(); };
      api.leave = function () { };
      api.destroy = function () { try { peer.destroy(); } catch (e) { } };
    } else {
      var peer2 = new Peer();
      var conn = null;
      peer2.on('open', function () {
        conn = peer2.connect(peerIdFor(code), { reliable: true });
        conn.on('open', function () {
          if (api.onStatus) api.onStatus('已连接房主');
          conn.send({ type: 'join', name: name, playerId: playerId });
        });
        conn.on('data', function (msg) {
          if (!msg || !msg.type) return;
          if (msg.type === 'state') { if (api.onState) api.onState(msg.state); }
          else if (msg.type === 'welcome') {
            api.playerId = msg.playerId; if (api.onWelcome) api.onWelcome(msg.playerId);
            if (api.onState) api.onState(msg.state);
          } else if (msg.type === 'error') { if (api.onError) api.onError(msg.msg); }
        });
        conn.on('close', function () { if (api.onStatus) api.onStatus('与房主断开，重连中…'); });
        conn.on('error', function () { if (api.onError) api.onError('与房主的连接中断'); });
      });
      peer2.on('error', function () { if (api.onError) api.onError('无法连接房间（房间码有误或房主离线）'); });
      api.sendAction = function (t, a) { if (conn && conn.open) conn.send({ type: 'action', playerId: api.playerId, action: t, amount: a }); };
      api.rename = function (name) { if (conn && conn.open) conn.send({ type: 'rename', playerId: api.playerId, name: name }); };
      api.startGame = function () { };
      api.nextHand = function () { };
      api.resetChips = function () { };
      api.leave = function () { if (conn && conn.open) conn.send({ type: 'leave', playerId: api.playerId }); };
      api.destroy = function () { try { peer2.destroy(); } catch (e) { } };
    }
  }

  // ---------------- 服务器模式（SSE + fetch，局域网权威） ----------------
  function startServer(opts, api) {
    var role = opts.role;
    var name = opts.name || '玩家';
    var playerId = opts.playerId || genId();
    api.mode = 'server';
    api.code = (opts.code || '').toUpperCase();
    var base = global.location.origin;

    function post(path, body) {
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) { if (j && j.error && api.onError) api.onError(j.error); })
        .catch(function () { if (api.onError) api.onError('与服务器通信失败'); });
    }

    function openSSE(code, pid) {
      var es = new EventSource(base + '/api/events?code=' + encodeURIComponent(code) + '&playerId=' + encodeURIComponent(pid));
      es.onmessage = function (ev) {
        try { var m = JSON.parse(ev.data); if (m.type === 'state' && api.onState) api.onState(m.state); } catch (e) { }
      };
      es.onerror = function () { if (api.onStatus) api.onStatus('连接中断，重连中…'); };
      api._es = es;
      if (api.onStatus) api.onStatus('已连接服务器（局域网）');
    }

    if (api.onStatus) api.onStatus('正在连接局域网服务器…');

    if (role === 'host') {
      // 房主：服务器分配房间码并建房
      var roomName = (opts.roomName || (name + '的局')).toString().trim().slice(0, 24) || '牌局';
      fetch(base + '/api/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName, hostName: name, playerId: playerId })
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.code) { if (api.onError) api.onError('创建房间失败，请重试'); return; }
          api.code = j.code;
          api.playerId = j.playerId || playerId;
          if (api.onWelcome) api.onWelcome(api.playerId);
          if (j.state && api.onState) api.onState(j.state);
          openSSE(j.code, api.playerId);
        })
        .catch(function () { if (api.onError) api.onError('与服务器通信失败'); });
    } else {
      // 加入者：房间码来自目录点击
      fetch(base + '/api/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: api.code, name: name, playerId: playerId })
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.playerId) { if (api.onError) api.onError('房间不存在或已解散'); return; }
          api.playerId = j.playerId;
          if (api.onWelcome) api.onWelcome(j.playerId);
          if (j.state && api.onState) api.onState(j.state);
          openSSE(api.code, j.playerId);
        })
        .catch(function () { if (api.onError) api.onError('与服务器通信失败'); });
    }

    api.sendAction = function (t, a) { post('/api/action', { code: api.code, playerId: api.playerId, action: t, amount: a }); };
    api.rename = function (name) { post('/api/rename', { code: api.code, playerId: api.playerId, name: name }); };
    api.startGame = function () { post('/api/control', { code: api.code, playerId: api.playerId, op: 'start' }); };
    api.nextHand = function () { post('/api/control', { code: api.code, playerId: api.playerId, op: 'next' }); };
    api.resetChips = function () { post('/api/control', { code: api.code, playerId: api.playerId, op: 'reset' }); };
    api.leave = function () { post('/api/leave', { code: api.code, playerId: api.playerId }); };
    api.destroy = function () { if (api._es) try { api._es.close(); } catch (e) { } };
  }

  // 拉取房间目录（仅服务器模式可用；非服务器返回 []）
  function listRooms(cb) {
    fetch(global.location.origin + '/api/rooms', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { cb((j && j.rooms) || []); })
      .catch(function () { cb([]); });
  }

  // ---------------- 统一入口：探测局域网服务器，失败回退 P2P ----------------
  function connect(opts) {
    var api = {
      role: opts.role, code: (opts.code || '').toUpperCase(), name: opts.name,
      onState: opts.onState, onError: opts.onError, onStatus: opts.onStatus, onWelcome: opts.onWelcome,
      mode: null
    };
    if (api.onStatus) api.onStatus('连接中…');

    // 若调用方已明确模式（大厅探测过），直接走对应实现，免去 2.5s 兜底延迟
    if (opts.forceMode === 'server') { startServer(opts, api); return api; }
    if (opts.forceMode === 'p2p') { startP2P(opts, api); return api; }

    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      if (api.onStatus) api.onStatus('未检测到局域网服务器，切换为点对点模式');
      startP2P(opts, api);
    }, 2500);

    fetch(global.location.origin + '/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (j && j.mode === 'server') startServer(opts, api);
        else startP2P(opts, api);
      })
      .catch(function () {
        if (done) return;
        done = true; clearTimeout(timer);
        startP2P(opts, api);
      });
    return api;
  }

  global.PokerNet = { connect: connect, listRooms: listRooms, genId: genId, peerIdFor: peerIdFor };
})(window);
