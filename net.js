/*
 * 统一网络层
 *  - 优先探测"局域网游戏服务器"（同源 /api/health 命中）→ 服务器模式（SSE 推送 + HTTP 操作）。
 *  - 探测失败（如来自 CloudStudio 等纯静态托管）→ 回退 P2P 模式（PeerJS，房主浏览器为权威节点）。
 * 对外暴露统一 API：connect(opts) -> { mode, sendAction, startGame, nextHand, resetChips, leave, destroy }
 *   opts: { role:'host'|'client', code, name, playerId, onState, onError, onStatus, onWelcome }
 *
 * P2P 房主容错（v2）：
 *  - 房主每次广播前把完整牌局快照(serializeFull)写入 localStorage；
 *  - 房主刷新/误关浏览器后重进：用同一房间码 + 同一 playerId 建房，自动从快照恢复牌局；
 *  - 客户端断线后每 2s 自动重连（host id 固定为 texas_<code>）；
 *  - 房主 15s 未回来，客户端尝试以固定 id 接管房间（PeerJS id 先到先得，天然解决抢注冲突），
 *    接管者用本地快照重建引擎继续发牌，其余客户端自动连上新房主；
 *  - 原房主回来发现 id 被占用 → 自动降级为普通玩家，坐回原座位。
 */
(function (global) {
  'use strict';
  var PokerEngine = global.PokerEngine;
  var Peer = global.Peer;

  function genId() { return 'p_' + Math.random().toString(36).slice(2, 10); }
  function peerIdFor(code) { return 'texas_' + code; }
  function backupKey(code) { return 'th_snap_' + code; }

  function loadBackup(code) {
    try {
      var b = localStorage.getItem(backupKey(code));
      if (b) {
        var s = JSON.parse(b);
        if (s && s.v === 1 && s.code === code) return s;
      }
    } catch (e) { }
    return null;
  }
  function storeBackupRaw(code, full) {
    try { if (full) localStorage.setItem(backupKey(code), JSON.stringify(full)); } catch (e) { }
  }
  function clearBackup(code) {
    try { localStorage.removeItem(backupKey(code)); } catch (e) { }
  }

  // ---------------- P2P 模式（PeerJS，房主权威 + 容错） ----------------
  function startP2P(opts, api) {
    var code = (opts.code || '').toUpperCase();
    var name = opts.name || '玩家';
    var playerId = opts.playerId || genId();
    api.mode = 'p2p';
    api.playerId = playerId;

    // ---------- 主机角色（含刷新恢复 / 客户端接管两入口） ----------
    function startAsHost(peer) {
      var room = null, conns = {};
      var snap = loadBackup(code);
      if (snap) {
        try {
          room = PokerEngine.Room.fromSnapshot(snap);
          var m = room.getPlayer(playerId);
          if (m) { m.connected = true; if (name) m.name = name; }
          else room.addPlayer(playerId, name, true);
          if (api.onStatus) api.onStatus('已恢复上一局，房主身份延续');
        } catch (e) { room = null; }
      }
      if (!room) {
        room = new PokerEngine.Room({ code: code, startingChips: 1000, smallBlind: 10, bigBlind: 20 });
        room.addPlayer(playerId, name);
      }
      room.hostId = playerId; // 现在的房主一定是自己

      function broadcast() {
        storeBackupRaw(code, room.serializeFull());
        var full = room.serializeFull();
        Object.keys(conns).forEach(function (pid) {
          var c = conns[pid];
          if (c && c.open) c.send({ type: 'state', state: room.serialize(pid), full: full });
        });
        if (api.onState) api.onState(room.serialize(playerId));
      }

      function handle(conn, msg) {
        if (!msg || !msg.type) return;
        if (msg.type === 'join') {
          var pid = msg.playerId && room.getPlayer(msg.playerId) ? msg.playerId : genId();
          var p = room.addPlayer(pid, msg.name || '玩家', true);
          conns[pid] = conn; conn._pid = pid;
          conn.send({ type: 'welcome', playerId: pid, state: room.serialize(pid), full: room.serializeFull() });
          broadcast();
        } else if (msg.type === 'reconnect') {
          var ex = room.getPlayer(msg.playerId);
          if (ex) {
            ex.connected = true; if (msg.name) ex.name = msg.name;
            conns[msg.playerId] = conn; conn._pid = msg.playerId;
            conn.send({ type: 'welcome', playerId: msg.playerId, state: room.serialize(msg.playerId), full: room.serializeFull() });
            broadcast();
          } else { handle(conn, { type: 'join', name: msg.name, playerId: msg.playerId }); }
        } else if (msg.type === 'action') {
          var res = room.doAction(msg.playerId, msg.action, msg.amount);
          if (res && res.error && conn.open) conn.send({ type: 'error', msg: res.error });
          broadcast();
        } else if (msg.type === 'rename') {
          room.renamePlayer(msg.playerId, msg.name);
          broadcast();
        } else if (msg.type === 'sitout') {
          var sp = room.getPlayer(msg.playerId);
          if (sp) { sp.sitOut = !!msg.sitOut; broadcast(); }
        } else if (msg.type === 'leave') {
          room.removePlayer(msg.playerId); delete conns[msg.playerId]; broadcast();
        }
      }

      // 超时托管 / 挂机自动弃牌：每秒检查当前行动者
      var turnTimer = setInterval(function () {
        if (!room || room.stage === 'waiting' || room.stage === 'showdown') return;
        var p = room.getPlayerBySeat(room.turnSeat);
        if (!p || p.folded || p.allIn || !p.connected) return;
        var acted = false;
        if (p.sitOut) {
          // 挂机：轮到即自动弃牌，不卡局
          room.doAction(p.id, 'fold');
          room.message = p.name + ' 挂机自动弃牌';
          acted = true;
        } else if (Date.now() - room.turnStartedAt > room.turnTime * 1000) {
          // 超时：免费过牌 / 能跟则跟 / 否则弃牌，并进入托管
          var toCall = Math.max(0, room.currentBet - p.bet);
          var action = toCall <= 0 ? 'check' : (p.chips >= toCall ? 'call' : 'fold');
          room.doAction(p.id, action, undefined);
          p.sitOut = true; // 之后每轮自动弃牌，直到玩家点「回桌」
          var label = action === 'check' ? '过牌' : (action === 'call' ? '跟注' : '弃牌');
          room.message = p.name + ' 超时自动' + label + '（已挂机）';
          acted = true;
        }
        if (acted) broadcast();
      }, 1000);

      peer.on('open', function () {
        if (api.onStatus) api.onStatus('房主已就绪 · 等待加入');
        broadcast();
      });
      peer.on('connection', function (conn) {
        conn.on('data', function (msg) { handle(conn, msg); });
        conn.on('close', function () {
          var pid = conn._pid;
          if (pid) { var p = room.getPlayer(pid); if (p) p.connected = false; delete conns[pid]; broadcast(); }
        });
        conn.on('error', function () { });
      });
      peer.on('error', function (err) {
        if (err && err.type === 'unavailable-id') {
          // 房间已被他人接管（或自己刚恢复但 id 被别人先抢）→ 降级为普通玩家加入
          if (api.onStatus) api.onStatus('房间已被接管，以玩家身份加入');
          startAsClient();
        } else if (api.onError) {
          api.onError('房主连接异常：' + (err && err.type || '未知'));
        }
      });

      api.playerId = playerId;
      api.startGame = function () { if (!room.startHand()) { if (api.onError) api.onError('人数不足，至少需要 2 人'); } else broadcast(); };
      api.nextHand = function () { if (!room.startHand()) { if (api.onError) api.onError('人数不足，无法开始下一手（可重置筹码）'); } else broadcast(); };
      api.resetChips = function () { room.resetChips(); broadcast(); };
      api.sendAction = function (t, a) { var r = room.doAction(playerId, t, a); if (r && r.error && api.onError) api.onError(r.error); broadcast(); };
      api.rename = function (nm) { if (room.renamePlayer(playerId, nm)) broadcast(); };
      api.sitOut = function (b) { var mp = room.getPlayer(playerId); if (mp) { mp.sitOut = !!b; broadcast(); } };
      api.leave = function () { };
      api.destroy = function () { clearBackup(code); clearInterval(turnTimer); try { peer.destroy(); } catch (e) { } };
    }

    // ---------- 客户端角色（断线重连 + 超时接管） ----------
    function startAsClient() {
      var peer2 = null, conn = null, retryTimer = null, upgradeTimer = null;
      var firstJoin = true;

      function clearTimers() {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (upgradeTimer) { clearTimeout(upgradeTimer); upgradeTimer = null; }
      }

      function scheduleReconnect(msg) {
        if (api.onStatus) api.onStatus(msg || '与房主断开，自动重连…');
        clearTimers();
        retryTimer = setTimeout(connectOnce, 2000);
        // 15s 仍未连上 → 尝试接管房间
        upgradeTimer = setTimeout(tryUpgrade, 15000);
      }

      function onData(msg) {
        if (!msg || !msg.type) return;
        if (msg.type === 'state') {
          storeBackupRaw(code, msg.full);
          if (api.onState) api.onState(msg.state);
        } else if (msg.type === 'welcome') {
          api.playerId = msg.playerId; if (api.onWelcome) api.onWelcome(msg.playerId);
          storeBackupRaw(code, msg.full);
          if (api.onState) api.onState(msg.state);
        } else if (msg.type === 'error') { if (api.onError) api.onError(msg.msg); }
      }

      function connectOnce() {
        if (peer2 && !peer2.destroyed) { try { peer2.destroy(); } catch (e) { } }
        peer2 = new Peer();
        peer2.on('open', function () {
          conn = peer2.connect(peerIdFor(code), { reliable: true });
          conn.on('open', function () {
            if (api.onStatus) api.onStatus('已连接房主');
            if (firstJoin) { firstJoin = false; conn.send({ type: 'join', name: name, playerId: playerId }); }
            else conn.send({ type: 'reconnect', name: name, playerId: playerId });
          });
          conn.on('data', onData);
          conn.on('close', function () { scheduleReconnect(); });
          conn.on('error', function () { scheduleReconnect(); });
        });
        peer2.on('error', function () { scheduleReconnect('无法连接房间，重试中…'); });
      }

      function tryUpgrade() {
        if (conn && conn.open) return;
        if (api.onStatus) api.onStatus('房主长时间离线，尝试接管房间…');
        var p2 = new Peer(peerIdFor(code), { debug: 0 });
        var settled = false;
        p2.on('open', function () {
          if (settled) return; settled = true;
          try { if (peer2 && !peer2.destroyed) peer2.destroy(); } catch (e) { }
          clearTimers();
          if (api.onStatus) api.onStatus('由你接管房间，继续游戏');
          startAsHost(p2); // 抢到固定 id → 直接用这个 peer 当主机
        });
        p2.on('error', function () {
          if (settled) return; settled = true;
          try { p2.destroy(); } catch (e) { }
          scheduleReconnect('房主已恢复连接…');
        });
      }

      api.playerId = playerId;
      api.sendAction = function (t, a) { if (conn && conn.open) conn.send({ type: 'action', playerId: api.playerId, action: t, amount: a }); };
      api.rename = function (nm) { if (conn && conn.open) conn.send({ type: 'rename', playerId: api.playerId, name: nm }); };
      api.sitOut = function (b) { if (conn && conn.open) conn.send({ type: 'sitout', playerId: api.playerId, sitOut: !!b }); };
      api.startGame = function () { };
      api.nextHand = function () { };
      api.resetChips = function () { };
      api.leave = function () { if (conn && conn.open) conn.send({ type: 'leave', playerId: api.playerId }); };
      api.destroy = function () { clearTimers(); try { if (peer2) peer2.destroy(); } catch (e) { } };
      connectOnce();
    }

    if (opts.role === 'host') startAsHost(new Peer(peerIdFor(code), { debug: 0 }));
    else startAsClient();
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
    api.sitOut = function (b) { post('/api/sitout', { code: api.code, playerId: api.playerId, sitOut: !!b }); };
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
