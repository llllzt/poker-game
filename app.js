/*
 * 前端交互：大厅 -> 创建/加入 -> 牌桌渲染与操作
 * 依赖：PokerEngine（engine.js）、PokerNet（net.js）、PeerJS（CDN）
 */
(function () {
  'use strict';
  var PE = window.PokerEngine, PN = window.PokerNet;

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var lobby = $('lobby'), game = $('game');
  var nameInput = $('nameInput'), codeInput = $('codeInput');
  var roomNameInput = $('roomNameInput'), roomNameField = $('roomNameField');
  var roomListSection = $('roomListSection'), roomList = $('roomList'), codeJoinSection = $('codeJoinSection');
  var lobbyHint = $('lobbyHint');
  var createBtn = $('createBtn'), joinBtn = $('joinBtn'), lobbyMsg = $('lobbyMsg');
  var roomCodeEl = $('roomCode'), copyBtn = $('copyBtn'), statusEl = $('status'), leaveBtn = $('leaveBtn');
  var waiting = $('waiting'), playerList = $('playerList'), startBtn = $('startBtn');
  var tableWrap = $('table'), seatsEl = $('seats'), communityEl = $('community'), potEl = $('pot');
  var actionBar = $('actionBar'), toCallEl = $('toCall'), myChipsEl = $('myChips');
  var raiseBox = $('raiseBox'), raiseInput = $('raiseInput'), raiseLabel = $('raiseLabel'), allinBtn = $('allinBtn');
  var foldBtn = $('foldBtn'), checkBtn = $('checkBtn'), callBtn = $('callBtn'), raiseBtn = $('raiseBtn');
  var hostBar = $('hostBar'), nextHandBtn = $('nextHandBtn'), resetBtn = $('resetBtn');
  var banner = $('banner');

  var net = null, myId = null, myRole = null, myName = null, myCode = null;
  var lastState = null;

  function showScreen(s) {
    lobby.classList.toggle('active', s === 'lobby');
    game.classList.toggle('active', s === 'game');
  }

  function sessionKey() { return 'th_session'; }
  function loadSession() { try { return JSON.parse(localStorage.getItem(sessionKey())); } catch (e) { return null; } }
  function saveSession(s) { try { localStorage.setItem(sessionKey(), JSON.stringify(s)); } catch (e) { } }
  function clearSession() { try { localStorage.removeItem(sessionKey()); } catch (e) { } }

  function genCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var c = '';
    for (var i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  function setStatus(t) { statusEl.textContent = t; }

  // ---------- 大厅操作 ----------
  createBtn.addEventListener('click', function () {
    var name = (nameInput.value || '').trim();
    if (!name) { lobbyMsg.textContent = '请先填写你的昵称'; return; }
    myName = name;
    myId = PN.genId();
    myRole = 'host';
    lobbyMsg.textContent = '';
    if (currentMode === 'server') {
      // 服务器模式：房间名交给服务器生成房间码，加入者看目录点击
      var rn = (roomNameInput.value || '').trim() || (myName + '的局');
      myCode = null;
      saveSession({ code: '', playerId: myId, role: 'host', name: myName, roomName: rn });
      startNet({ roomName: rn });
    } else {
      // P2P 回退：本地生成房间码
      myCode = genCode();
      saveSession({ code: myCode, playerId: myId, role: 'host', name: myName });
      startNet({});
    }
  });

  joinBtn.addEventListener('click', function () {
    var code = (codeInput.value || '').trim().toUpperCase();
    if (!code) { lobbyMsg.textContent = '请输入房间码'; return; }
    var name = (nameInput.value || '').trim();
    if (!name) { lobbyMsg.textContent = '请先填写你的昵称'; return; }
    myName = name;
    var sess = loadSession();
    myId = (sess && sess.code === code) ? sess.playerId : PN.genId();
    myCode = code;
    myRole = 'client';
    saveSession({ code: myCode, playerId: myId, role: 'client', name: myName });
    startNet({});
  });

  // 目录模式：点击房间卡片加入
  function joinRoom(code) {
    if (!code) return;
    var name = (nameInput.value || '').trim();
    if (!name) { lobbyMsg.textContent = '请先填写你的昵称'; return; }
    myName = name;
    myId = PN.genId();
    myCode = code;
    myRole = 'client';
    saveSession({ code: myCode, playerId: myId, role: 'client', name: myName });
    startNet({});
  }

  function startNet(extra) {
    extra = extra || {};
    stopRoomListPolling();
    showScreen('game');
    roomCodeEl.textContent = myCode || '----';
    net = PN.connect({
      role: myRole, code: myCode || '', name: myName, playerId: myId,
      roomName: extra.roomName || '', forceMode: currentMode,
      onState: onState, onError: onError, onStatus: onStatus,
      onWelcome: function (pid) { myId = pid; }
    });
  }

  // ---------- 模式探测：有局域网服务器则走目录，否则 P2P 输码 ----------
  var currentMode = null, roomListTimer = null;
  function detectMode(cb) {
    var t = setTimeout(function () { cb('p2p'); }, 2000);
    fetch(location.origin + '/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { clearTimeout(t); cb((j && j.mode === 'server') ? 'server' : 'p2p'); })
      .catch(function () { clearTimeout(t); cb('p2p'); });
  }
  function applyMode(mode) {
    currentMode = mode;
    if (mode === 'server') {
      roomListSection.classList.remove('hidden');
      codeJoinSection.classList.add('hidden');
      roomNameField.classList.remove('hidden');
      lobbyHint.textContent = '已连上本机服务器：创建房间后，朋友打开此页即可看到房间名并点击加入，无需输码。';
      startRoomListPolling();
    } else {
      roomListSection.classList.add('hidden');
      codeJoinSection.classList.remove('hidden');
      roomNameField.classList.add('hidden');
      lobbyHint.textContent = '（点对点模式）创建后把房间码发给朋友；若在同 WiFi 电脑运行本服务器，大家打开其地址即可免码加入。';
      stopRoomListPolling();
    }
  }
  function startRoomListPolling() {
    stopRoomListPolling();
    refreshRoomList();
    roomListTimer = setInterval(refreshRoomList, 2000);
  }
  function stopRoomListPolling() {
    if (roomListTimer) { clearInterval(roomListTimer); roomListTimer = null; }
  }
  function stageText(s) {
    return s === 'waiting' ? '等待中' : (s === 'showdown' ? '本手结束' : '游戏中');
  }
  function refreshRoomList() {
    if (currentMode !== 'server') return;
    PN.listRooms(function (list) {
      roomList.innerHTML = '';
      if (!list || !list.length) {
        var li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '暂无房间，上方「创建房间」开一局吧';
        roomList.appendChild(li);
        return;
      }
      list.forEach(function (rm) {
        var li = document.createElement('li');
        li.className = 'room-item';
        li.innerHTML = '<div class="ri-name">' + escapeHtml(rm.name) + '</div>' +
          '<div class="ri-meta">' + rm.count + ' 人 · ' + stageText(rm.stage) + '</div>';
        li.addEventListener('click', function () { joinRoom(rm.code); });
        roomList.appendChild(li);
      });
    });
  }

  function onStatus(s) {
    if (s === 'ready') setStatus('房主已就绪 · 等待加入');
    else if (s === 'connected') setStatus('已连接房主');
    else if (s === 'disconnected') setStatus('与房主断开');
    else setStatus(s);
  }
  function onError(m) {
    setStatus('⚠ ' + m);
    if (lobbyMsg && game.classList.contains('active') === false) lobbyMsg.textContent = m;
  }

  // ---------- 状态渲染 ----------
  function onState(state) {
    lastState = state;
    if (!state) return;
    if (state.code) roomCodeEl.textContent = state.code;
    if (state.stage === 'waiting') {
      waiting.classList.remove('hidden');
      tableWrap.classList.add('hidden');
      renderWaiting(state);
    } else {
      waiting.classList.add('hidden');
      tableWrap.classList.remove('hidden');
      renderTable(state);
    }
  }

  function renderWaiting(state) {
    playerList.innerHTML = '';
    state.players.forEach(function (p) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="avatar">' + escapeHtml(p.name.slice(0, 1)) + '</div>' +
        '<div class="pname">' + escapeHtml(p.name) + (p.id === state.hostId ? '（房主）' : '') + '</div>' +
        '<div class="pchips">' + p.chips + '</div>';
      playerList.appendChild(li);
    });
    var isHost = (myId && state.hostId === myId);
    startBtn.disabled = !(isHost && state.canStart);
    startBtn.textContent = isHost ? (state.canStart ? '开始游戏' : '开始游戏（至少 2 人）') : '等待房主开始…';
  }

  function renderTable(state) {
    // 公共牌
    communityEl.innerHTML = '';
    for (var i = 0; i < 5; i++) {
      var c = state.community[i];
      communityEl.appendChild(c ? cardEl(c, true) : cardEl(null, false, true));
    }
    potEl.textContent = '底池 ' + state.pot;

    // 实时排名：按筹码降序算名次（仅牌局内进行中/摊牌时显示）
    var ranked = state.players.slice().sort(function (a, b) { return b.chips - a.chips; });
    var rankMap = {};
    ranked.forEach(function (p, i) { rankMap[p.id] = i + 1; });

    // 座位
    var me = findMe(state);
    var placed = layout(state.players, me ? me.id : null);
    seatsEl.innerHTML = '';
    placed.forEach(function (p) {
      seatsEl.appendChild(renderSeat(p, me, rankMap[p.id]));
    });

    // 操作条 / 房主条 / 横幅
    if (state.hostId === myId && state.stage === 'showdown') {
      hostBar.classList.remove('hidden');
    } else {
      hostBar.classList.add('hidden');
    }
    if (state.stage === 'showdown') {
      showBanner(state);
      actionBar.classList.add('hidden');
    } else {
      banner.classList.add('hidden');
      updateActionBar(state, me);
    }
  }

  function findMe(state) {
    for (var i = 0; i < state.players.length; i++) if (state.players[i].id === myId) return state.players[i];
    return null;
  }

  function layout(players, myId) {
    var n = players.length;
    var positions = [];
    var step = (2 * Math.PI) / n;
    var start = Math.PI / 2; // 底部
    for (var i = 0; i < n; i++) positions.push(start + i * step);
    var me = null, others = [];
    players.forEach(function (p) { if (p.id === myId) me = p; else others.push(p); });
    others.sort(function (a, b) { return a.seat - b.seat; });
    if (me) { me._x = 50 + 42 * Math.cos(positions[0]); me._y = 50 + 40 * Math.sin(positions[0]); }
    others.forEach(function (p, i) {
      var a = positions[i + 1];
      p._x = 50 + 42 * Math.cos(a); p._y = 50 + 40 * Math.sin(a);
    });
    return players;
  }

  function renderSeat(p, me, rank) {
    var el = document.createElement('div');
    el.className = 'seat' + (p.isTurn ? ' turn' : '') + (p.isDealer ? ' dealer' : '') + (p.folded ? ' folded' : '') + (p.id === myId ? ' mine' : '');
    el.style.left = p._x + '%';
    el.style.top = p._y + '%';

    var row = document.createElement('div');
    row.className = 'card-row';
    if (p.handHidden) {
      row.appendChild(cardEl(null, false, false));
      row.appendChild(cardEl(null, false, false));
    } else {
      (p.hand && p.hand.length ? p.hand : [null, null]).forEach(function (c) {
        row.appendChild(c ? cardEl(c, true) : cardEl(null, false, true));
      });
    }
    el.appendChild(row);

    var info = document.createElement('div');
    info.className = 'pinfo';
    var badges = '';
    if (p.allIn) badges += '<span class="badge allin">ALLIN</span>';
    if (!p.connected) badges += '<span class="badge off">离线</span>';
    var rankBadge = (rank != null) ? '<span class="rank">' + rank + '</span>' : '';
    info.innerHTML =
      '<div class="pname">' + rankBadge + escapeHtml(p.name) + badges + '</div>' +
      '<div class="pchips">' + p.chips + ' 筹</div>' +
      (p.bet > 0 ? '<div class="paction">下注 ' + p.bet + '</div>' : '<div class="paction">' + actionText(p) + '</div>');
    el.appendChild(info);
    // 点击自己的座位卡可改名
    if (p.id === myId) {
      el.addEventListener('click', function () { openRename(); });
    }
    return el;
  }

  function actionText(p) {
    if (p.folded) return '弃牌';
    if (p.lastAction === 'check') return '过牌';
    if (p.lastAction === 'call') return '跟注';
    if (p.lastAction === 'raise') return '加注';
    if (p.lastAction === 'allin') return '全下';
    if (p.lastAction === 'fold') return '弃牌';
    return '';
  }

  function cardEl(card, faceUp, placeholder) {
    var d = document.createElement('div');
    if (placeholder) { d.className = 'card placeholder'; return d; }
    if (!faceUp) { d.className = 'card back'; return d; }
    var red = PE.isRed(card.s);
    d.className = 'card' + (red ? ' red' : '');
    d.textContent = PE.rankLabel(card.r) + PE.SUITS[card.s];
    return d;
  }

  function updateActionBar(state, me) {
    if (!me || state.stage === 'showdown' || state.stage === 'waiting') {
      actionBar.classList.add('hidden'); return;
    }
    var isMyTurn = me.isTurn && !me.folded && !me.allIn;
    if (!isMyTurn) { actionBar.classList.add('hidden'); return; }
    actionBar.classList.remove('hidden');
    raiseBox.classList.add('hidden'); // 收起加注面板，避免误触

    var toCall = state.currentBet - me.bet;
    toCallEl.textContent = toCall > 0 ? ('需跟注 ' + toCall) : '无需跟注';
    myChipsEl.textContent = '我的筹码 ' + me.chips;

    if (toCall === 0) {
      checkBtn.classList.remove('hidden'); callBtn.classList.add('hidden');
      checkBtn.textContent = '过牌';
    } else {
      checkBtn.classList.add('hidden'); callBtn.classList.remove('hidden');
      callBtn.textContent = '跟注 ' + Math.min(toCall, me.chips);
    }

    // 加注范围
    var minRaiseTo = state.currentBet + state.minRaise;
    var maxRaiseTo = me.bet + me.chips; // 全下目标
    if (maxRaiseTo >= minRaiseTo) {
      raiseBtn.disabled = false;
      raiseInput.min = minRaiseTo; raiseInput.max = maxRaiseTo; raiseInput.value = minRaiseTo;
      raiseLabel.textContent = '加注到 ' + minRaiseTo;
    } else {
      // 只能全下
      raiseBtn.disabled = (me.chips === 0);
    }
  }

  function showBanner(state) {
    var r = state.lastResults;
    if (!r) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    var html = '';
    if (r.type === 'fold') {
      html += '<h3>本手结束</h3>';
      html += '<div class="winners">' + escapeHtml(nameOf(state, r.winners[0])) + ' 赢得底池 ' + r.pots[0].amount + '（其余弃牌）</div>';
    } else {
      html += '<h3>摊牌结果</h3>';
      r.pots.forEach(function (pot) {
        var names = pot.winners.map(function (id) { return escapeHtml(nameOf(state, id)); }).join('、');
        html += '<div class="winners">' + names + ' 以「' + pot.handName + '」赢得 ' + pot.amount + '</div>';
      });
      html += '<div class="reveal">';
      (r.hands || []).forEach(function (h) {
        html += '<div><div class="who">' + escapeHtml(h.name) + ' · ' + h.handName + '</div><div style="display:flex;gap:3px;justify-content:center">';
        h.cards.forEach(function (c) { html += cardHTML(c); });
        html += '</div></div>';
      });
      html += '</div>';
    }
    banner.innerHTML = html;
    if (state.hostId === myId) banner.innerHTML += '<p class="hint" style="margin-top:10px">点击「下一手」继续</p>';
  }

  function cardHTML(c) {
    var red = PE.isRed(c.s);
    return '<div class="card small' + (red ? ' red' : '') + '">' + PE.rankLabel(c.r) + PE.SUITS[c.s] + '</div>';
  }
  function nameOf(state, id) {
    for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i].name;
    return id;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 操作按钮 ----------
  foldBtn.addEventListener('click', function () { net && net.sendAction('fold'); });
  checkBtn.addEventListener('click', function () { net && net.sendAction('check'); });
  callBtn.addEventListener('click', function () { net && net.sendAction('call'); });
  raiseBtn.addEventListener('click', function () {
    if (raiseBox.classList.contains('hidden')) {
      raiseBox.classList.remove('hidden');
      raiseLabel.textContent = '加注到 ' + raiseInput.value;
    } else {
      net && net.sendAction('raise', parseInt(raiseInput.value, 10));
      raiseBox.classList.add('hidden');
    }
  });
  raiseInput.addEventListener('input', function () { raiseLabel.textContent = '加注到 ' + raiseInput.value; });
  allinBtn.addEventListener('click', function () {
    var me = findMe(lastState);
    if (me) net && net.sendAction('raise', me.bet + me.chips);
    raiseBox.classList.add('hidden');
  });

  startBtn.addEventListener('click', function () { net && net.startGame(); });
  nextHandBtn.addEventListener('click', function () { net && net.nextHand(); });
  resetBtn.addEventListener('click', function () { net && net.resetChips(); });

  copyBtn.addEventListener('click', function () {
    var txt = myCode;
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { setStatus('房间码已复制：' + txt); });
    else setStatus('房间码：' + txt);
  });

  leaveBtn.addEventListener('click', function () {
    if (net) { if (myRole === 'client') net.leave(); net.destroy(); }
    clearSession(); net = null;
    showScreen('lobby');
  });

  // ---------- 玩法说明（点问号 ?） ----------
  var helpModal = $('helpModal'), helpClose = $('helpClose');
  var helpBtn = $('helpBtn'), helpBtnLobby = $('helpBtnLobby');
  function openHelp() { if (helpModal) helpModal.classList.remove('hidden'); }
  function closeHelp() { if (helpModal) helpModal.classList.add('hidden'); }
  if (helpBtn) helpBtn.addEventListener('click', openHelp);
  if (helpBtnLobby) helpBtnLobby.addEventListener('click', openHelp);
  if (helpClose) helpClose.addEventListener('click', closeHelp);
  if (helpModal) helpModal.addEventListener('click', function (e) { if (e.target === helpModal) closeHelp(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeHelp(); });

  // ---------- 牌局内改名（点自己座位卡） ----------
  var renameModal = $('renameModal'), renameInput = $('renameInput'), renameSave = $('renameSave'), renameCancel = $('renameCancel');
  function openRename() {
    if (!renameInput) return;
    renameInput.value = myName || '';
    renameModal.classList.remove('hidden');
    setTimeout(function () { renameInput.focus(); renameInput.select(); }, 30);
  }
  function closeRename() { if (renameModal) renameModal.classList.add('hidden'); }
  if (renameSave) renameSave.addEventListener('click', function () {
    var v = (renameInput.value || '').trim().slice(0, 10);
    if (!v) { renameInput.focus(); return; }
    myName = v;
    saveSession({ code: myCode || '', playerId: myId, role: myRole, name: myName });
    if (net && net.rename) net.rename(v);
    closeRename();
  });
  if (renameCancel) renameCancel.addEventListener('click', closeRename);
  if (renameModal) renameModal.addEventListener('click', function (e) { if (e.target === renameModal) closeRename(); });
  if (renameInput) renameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') renameSave.click(); });

  // 竖屏提示：用户选择继续竖屏后隐藏（横屏自动隐藏由 CSS 控制）
  var rotateHint = $('rotateHint'), rotateOk = $('rotateOk');
  if (rotateOk) rotateOk.addEventListener('click', function () { if (rotateHint) rotateHint.classList.add('hidden'); });

  // 启动：探测模式后显示大厅（默认先按输码界面，探测到服务器则切换为目录）
  showScreen('lobby');
  detectMode(function (mode) { applyMode(mode); });
})();
