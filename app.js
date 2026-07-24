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
    // 底池（文字 + 视觉化筹码堆）
    renderPot(state.pot);

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

    // 桌面筹码堆层：每个有 bet 的玩家，朝向桌子中心方向画一摞彩色筹码
    renderChipStakes(state);

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

  // 渲染底池：横向药丸 = 数字标签 + 横向筹码串（不互相遮挡）
  function renderPot(potAmount) {
    potEl.innerHTML = '';
    // 数字标签
    var txt = document.createElement('div');
    txt.className = 'pot-text';
    txt.textContent = '底池 ' + potAmount;
    potEl.appendChild(txt);
    // 中心筹码串（数量与 pot 量成正比，最少 2 最多 6）
    if (potAmount > 0) {
      var n = Math.max(2, Math.min(6, Math.ceil(potAmount / 30) + 1));
      var colors = ['c-red', 'c-blue', 'c-gold', 'c-green', 'c-purple'];
      var chipsWrap = document.createElement('div');
      chipsWrap.className = 'pot-chips';
      for (var i = 0; i < n; i++) {
        var chip = document.createElement('div');
        chip.className = 'chip ' + colors[i % colors.length];
        chipsWrap.appendChild(chip);
      }
      potEl.appendChild(chipsWrap);
    }
  }

  // 渲染每个玩家下注的筹码堆（位于玩家和桌子中心连线的中段，朝向中心）
  function renderChipStakes(state) {
    // 清掉旧独立浮层（兼容老代码）
    var old = tableWrap.querySelector('.chip-stakes');
    if (old) old.remove();
    tableWrap.querySelectorAll('.seat .seat-chips').forEach(function (n) { n.remove(); });
    state.players.forEach(function (p) {
      if (!p.bet || p.bet <= 0) return;
      var seatEl = tableWrap.querySelector('.seat[data-pid="' + p.id + '"]');
      if (!seatEl) return;
      var info = seatEl.querySelector('.pinfo');
      if (!info) return;
      var wrap = document.createElement('div');
      wrap.className = 'seat-chips';
      var amt = document.createElement('span');
      amt.className = 'seat-chips-amt';
      amt.textContent = '下注 ' + p.bet;
      wrap.appendChild(amt);
      var row = document.createElement('span');
      row.className = 'seat-chips-row';
      var n = Math.max(1, Math.min(4, Math.ceil(p.bet / 25)));
      var colors = ['c-red', 'c-blue', 'c-gold', 'c-green', 'c-purple'];
      for (var i = 0; i < n; i++) {
        var chip = document.createElement('span');
        chip.className = 'chip ' + colors[i % colors.length];
        row.appendChild(chip);
      }
      wrap.appendChild(row);
      info.appendChild(wrap);
    });
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
    el.className = 'seat' + (p.isTurn ? ' turn' : '') + (p.isDealer ? ' dealer' : '') + (p.isSB ? ' sb' : '') + (p.isBB ? ' bb' : '') + (p.folded ? ' folded' : '') + (p.id === myId ? ' mine' : '');
    el.dataset.pid = p.id;
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
    // 庄家 / 小盲 / 大盲 标签（一次只可能命中其中一个；庄家时同色 D 优先，SB/BB 紧跟其后）
    var roleTags = '';
    if (p.isDealer) roleTags += '<span class="role-tag dealer">D</span>';
    if (p.isSB)     roleTags += '<span class="role-tag sb">SB</span>';
    if (p.isBB)     roleTags += '<span class="role-tag bb">BB</span>';
    var rankBadge = (rank != null) ? '<span class="rank">' + rank + '</span>' : '';
    info.innerHTML =
      '<div class="pname">' + rankBadge + escapeHtml(p.name) + roleTags + badges + '</div>' +
      '<div class="pchips">' + p.chips + ' 筹</div>' +
      (p.bet > 0 ? '<div class="paction"></div>' : '<div class="paction">' + actionText(p) + '</div>');
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
    // 牌局进行中（非 showdown/waiting）必须始终显示操作条，
    // 任何玩家都能随时弃牌；非自己回合时按钮灰显 + 顶部信息区显示「等待 XX 行动」。
    if (!me || state.stage === 'showdown' || state.stage === 'waiting') {
      actionBar.classList.add('hidden'); return;
    }
    actionBar.classList.remove('hidden');
    raiseBox.classList.add('hidden'); // 收起加注面板，避免误触

    var isMyTurn = me.isTurn && !me.folded && !me.allIn && me.connected;
    var toCall = Math.max(0, state.currentBet - me.bet);
    var canFold = !me.folded && me.connected;
    var canCheck = isMyTurn && toCall === 0;
    var canCall = isMyTurn && toCall > 0 && me.chips > 0;
    var canRaise = isMyTurn && me.chips > 0 && (me.bet + me.chips) > state.currentBet;

    // 顶部信息
    if (isMyTurn) {
      toCallEl.textContent = toCall > 0 ? ('需跟注 ' + toCall) : '轮到你：可以过牌或加注';
    } else {
      // 找当前轮到谁
      var cur = null;
      for (var i = 0; i < state.players.length; i++) {
        if (state.players[i].isTurn) { cur = state.players[i]; break; }
      }
      var curName = cur ? cur.name : '...';
      if (me.folded) toCallEl.textContent = '你已弃牌 · 等待 ' + curName + ' 行动';
      else if (me.allIn) toCallEl.textContent = '你已全下 · 等待 ' + curName + ' 行动';
      else toCallEl.textContent = '等待 ' + curName + ' 行动…';
    }
    myChipsEl.textContent = '我的筹码 ' + me.chips + (me.bet > 0 ? ' · 本轮已下 ' + me.bet : '');

    // 按钮：自己回合时启用；其他玩家回合时全部 disabled（弃牌始终允许）
    foldBtn.disabled = !canFold;
    if (canFold && !isMyTurn) {
      foldBtn.textContent = '弃牌（随时可）';
    } else {
      foldBtn.textContent = '弃牌';
    }

    if (toCall === 0) {
      checkBtn.classList.remove('hidden'); callBtn.classList.add('hidden');
      checkBtn.textContent = '过牌';
      checkBtn.disabled = !canCheck;
    } else {
      checkBtn.classList.add('hidden'); callBtn.classList.remove('hidden');
      var callAmt = Math.min(toCall, me.chips);
      callBtn.textContent = '跟注 ' + callAmt;
      callBtn.disabled = !canCall;
    }

    raiseBtn.disabled = !canRaise;
    if (me.chips === 0 || (me.bet + me.chips) <= state.currentBet) {
      raiseBtn.textContent = '只能全下';
    }

    // 加注范围
    var minRaiseTo = state.currentBet + state.minRaise;
    var maxRaiseTo = me.bet + me.chips;
    if (maxRaiseTo >= minRaiseTo) {
      raiseInput.min = minRaiseTo; raiseInput.max = maxRaiseTo; raiseInput.value = minRaiseTo;
      raiseLabel.textContent = '加注到 ' + minRaiseTo;
    } else {
      // 只能全下
      raiseInput.value = maxRaiseTo;
      raiseLabel.textContent = '加注到 ' + maxRaiseTo + '（全下）';
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
      // 5 张公共牌：在 winners 行下方单独展示，让人一眼看出公牌与各人手牌如何组成最终牌型
      if (r.community && r.community.length) {
        html += '<div class="community-line"><div class="lbl">公牌</div><div class="cards">';
        r.community.forEach(function (c) { html += cardHTML(c); });
        html += '</div></div>';
      }
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
