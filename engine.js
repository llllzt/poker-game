/*
 * 德州扑克核心引擎（纯逻辑，无依赖）
 * 同时兼容浏览器（挂到 window.PokerEngine）与 Node（module.exports），便于单元测试。
 *
 * 设计要点：
 *  - 房主浏览器作为"权威节点"运行本引擎，客户端仅收发状态。
 *  - 支持记分娱乐局：每人初始等额筹码，盲注固定，可重开/重置。
 *  - 完整支持全下(All-in)与边池(Side Pot)、弃牌、过牌、跟注、加注。
 */
(function (global) {
  'use strict';

  // ---------- 基础常量 ----------
  var SUITS = ['♠', '♥', '♦', '♣']; // ♠ ♥ ♦ ♣
  var RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  var RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  // 牌型类别（数值越大越强）
  var CAT = {
    HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
    FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8
  };
  var CAT_NAME = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

  function rankLabel(r) { return RANK_LABEL[r] ? RANK_LABEL[r] : '' + r; }
  function cardLabel(c) { return rankLabel(c.r) + SUITS[c.s]; }
  function isRed(s) { return s === 1 || s === 2; } // ♥ ♦

  // ---------- 牌堆 ----------
  function createDeck() {
    var d = [];
    for (var s = 0; s < 4; s++) for (var i = 0; i < RANKS.length; i++) d.push({ r: RANKS[i], s: s });
    return d;
  }
  function shuffle(deck, rng) {
    rng = rng || Math.random;
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  // ---------- 牌型评估 ----------
  // 评估 5 张牌，返回 {cat, tb:[...]} 可比较结构
  function evaluate5(cards) {
    var ranks = cards.map(function (c) { return c.r; }).sort(function (a, b) { return b - a; });
    var suits = cards.map(function (c) { return c.s; });
    var isFlush = suits.every(function (x) { return x === suits[0]; });
    var uniq = [];
    ranks.forEach(function (r) { if (uniq.indexOf(r) < 0) uniq.push(r); });
    uniq.sort(function (a, b) { return b - a; });
    var isStraight = false, straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) { isStraight = true; straightHigh = uniq[0]; }
      // 轮子 A-2-3-4-5
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) { isStraight = true; straightHigh = 5; }
    }
    var counts = {};
    ranks.forEach(function (r) { counts[r] = (counts[r] || 0) + 1; });
    var groups = Object.keys(counts).map(function (k) { return { r: +k, c: counts[k] }; });
    groups.sort(function (a, b) { return (b.c - a.c) || (b.r - a.r); });

    if (isStraight && isFlush) return { cat: CAT.STRAIGHT_FLUSH, tb: [straightHigh] };
    if (groups[0].c === 4) return { cat: CAT.QUADS, tb: [groups[0].r, groups[1].r] };
    if (groups[0].c === 3 && groups[1].c === 2) return { cat: CAT.FULL_HOUSE, tb: [groups[0].r, groups[1].r] };
    if (isFlush) return { cat: CAT.FLUSH, tb: ranks.slice() };
    if (isStraight) return { cat: CAT.STRAIGHT, tb: [straightHigh] };
    if (groups[0].c === 3) return { cat: CAT.TRIPS, tb: [groups[0].r, groups[1].r, groups[2].r] };
    if (groups[0].c === 2 && groups[1].c === 2) return { cat: CAT.TWO_PAIR, tb: [groups[0].r, groups[1].r, groups[2].r] };
    if (groups[0].c === 2) return { cat: CAT.PAIR, tb: [groups[0].r, groups[1].r, groups[2].r, groups[3].r] };
    return { cat: CAT.HIGH, tb: ranks.slice() };
  }

  // 比较两手牌：-1 / 0 / 1
  function compare(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    var n = Math.max(a.tb.length, b.tb.length);
    for (var i = 0; i < n; i++) {
      var x = a.tb[i] || 0, y = b.tb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  // 从 5~7 张中挑出最佳 5 张
  function best7(cards) {
    var n = cards.length, best = null;
    for (var a = 0; a < n - 4; a++)
      for (var b = a + 1; b < n - 3; b++)
        for (var c = b + 1; c < n - 2; c++)
          for (var d = c + 1; d < n - 1; d++)
            for (var e = d + 1; e < n; e++) {
              var h = evaluate5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
              if (!best || compare(h, best) > 0) best = h;
            }
    return best;
  }
  function handName(h) { return CAT_NAME[h.cat]; }

  // ---------- 牌局（单桌） ----------
  function Room(opts) {
    opts = opts || {};
    this.startingChips = opts.startingChips || 1000;
    this.smallBlind = opts.smallBlind || 10;
    this.bigBlind = opts.bigBlind || 20;
    this.code = opts.code || '';
    this.name = opts.name || ''; // 房间名（目录展示用）
    this.players = [];          // {id,name,chips,seat,folded,allIn,hand,bet,totalBet,acted,connected,lastAction}
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;        // 本轮最高下注额
    this.minRaise = this.bigBlind;
    this.dealerSeat = -1;
    this.turnSeat = -1;
    this.stage = 'waiting';     // waiting|preflop|flop|turn|river|showdown
    this.hostId = null;
    this.handNumber = 0;
    this.message = '';
    this.lastResults = null;
  }

  Room.prototype.addPlayer = function (id, name, connected) {
    var existing = this.getPlayer(id);
    if (existing) {
      existing.name = name || existing.name;
      existing.connected = (connected !== false);
      return existing;
    }
    var p = {
      id: id, name: name || '玩家', chips: this.startingChips,
      seat: this.players.length, folded: false, allIn: false, hand: [],
      bet: 0, totalBet: 0, acted: false, connected: (connected !== false), lastAction: null
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = id;
    return p;
  };

  // 改名：校验非空与长度（≤10），成功返回 true
  Room.prototype.renamePlayer = function (id, name) {
    var p = this.getPlayer(id);
    if (!p) return false;
    name = (name || '').toString().trim().slice(0, 10);
    if (!name) return false;
    p.name = name;
    return true;
  };

  Room.prototype.getPlayer = function (id) {
    for (var i = 0; i < this.players.length; i++) if (this.players[i].id === id) return this.players[i];
    return null;
  };

  // 仅移除"等待中且未开始"的玩家；游戏中不移除，仅标记掉线
  Room.prototype.removePlayer = function (id) {
    var idx = -1;
    for (var i = 0; i < this.players.length; i++) if (this.players[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    if (this.stage !== 'waiting') { this.players[idx].connected = false; return; }
    this.players.splice(idx, 1);
    this.players.forEach(function (p, i) { p.seat = i; });
    if (this.hostId === id && this.players.length) this.hostId = this.players[0].id;
  };

  Room.prototype.getParticipants = function () {
    // 有筹码（可参与下一手）的玩家，按座位升序
    return this.players.filter(function (p) { return p.chips > 0; })
      .sort(function (a, b) { return a.seat - b.seat; });
  };

  Room.prototype.canAct = function (p) {
    return p && !p.folded && !p.allIn && p.chips > 0;
  };

  // 在"有筹码"的玩家中，返回 fromSeat 之后的下一个座位（环形）
  Room.prototype.nextParticipantSeat = function (fromSeat) {
    var seats = this.getParticipants().map(function (p) { return p.seat; }).sort(function (a, b) { return a - b; });
    if (!seats.length) return -1;
    for (var i = 0; i < seats.length; i++) if (seats[i] > fromSeat) return seats[i];
    return seats[0];
  };

  // 在"未弃牌"的玩家中，返回 fromSeat 之后下一个还能操作(未全下/有筹码)的座位
  Room.prototype.nextActorSeat = function (fromSeat) {
    var seats = this.players.filter(function (p) { return !p.folded; })
      .map(function (p) { return p.seat; }).sort(function (a, b) { return a - b; });
    if (!seats.length) return -1;
    var cand = seats.filter(function (s) { return s > fromSeat; });
    if (!cand.length) cand = seats;
    for (var i = 0; i < cand.length; i++) {
      var p = this.getPlayerBySeat(cand[i]);
      if (this.canAct(p)) return cand[i];
    }
    return -1;
  };

  Room.prototype.getPlayerBySeat = function (seat) {
    for (var i = 0; i < this.players.length; i++) if (this.players[i].seat === seat) return this.players[i];
    return null;
  };

  Room.prototype.postBlind = function (p, amt) {
    var pay = Math.min(amt, p.chips);
    p.chips -= pay; p.bet = pay; p.totalBet = pay; p.acted = false; this.pot += pay;
  };

  // 开始新一手
  Room.prototype.startHand = function () {
    var parts = this.getParticipants();
    if (parts.length < 2) { this.message = '人数不足，至少需要 2 人'; return false; }
    this.handNumber++;
    this.deck = shuffle(createDeck());
    this.community = []; this.pot = 0; this.currentBet = 0; this.minRaise = this.bigBlind;
    this.lastResults = null;
    this.message = '第 ' + this.handNumber + ' 手开始';
    var self = this;
    this.players.forEach(function (p) {
      p.hand = []; p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false; p.acted = false; p.lastAction = null;
    });
    // 庄家按钮轮转
    this.dealerSeat = this.nextParticipantSeat(this.dealerSeat);
    parts = this.getParticipants();
    parts.forEach(function (p) { p.hand = [self.deck.pop(), self.deck.pop()]; });
    this.stage = 'preflop';
    this.postBlinds(parts);
    this.setFirstToAct();
    return true;
  };

  Room.prototype.postBlinds = function (parts) {
    var n = parts.length;
    var sbSeat, bbSeat;
    if (n === 2) {
      sbSeat = this.dealerSeat;
      bbSeat = this.nextParticipantSeat(this.dealerSeat);
    } else {
      sbSeat = this.nextParticipantSeat(this.dealerSeat);
      bbSeat = this.nextParticipantSeat(sbSeat);
    }
    var sb = this.getPlayerBySeat(sbSeat), bb = this.getPlayerBySeat(bbSeat);
    this.postBlind(sb, this.smallBlind);
    this.postBlind(bb, this.bigBlind);
    this.currentBet = Math.max(sb.totalBet, bb.totalBet);
    this.minRaise = Math.max(this.currentBet, this.bigBlind);
  };

  Room.prototype.setFirstToAct = function () {
    var n = this.getParticipants().length, idx;
    if (n === 2) idx = this.dealerSeat; // 单挑：小盲(庄家)先行动
    else {
      var bbSeat = this.nextParticipantSeat(this.nextParticipantSeat(this.dealerSeat));
      idx = this.nextParticipantSeat(bbSeat);
    }
    this.turnSeat = idx;
    this.skipIfCannotAct();
  };

  Room.prototype.skipIfCannotAct = function () {
    var guard = 0;
    while (this.turnSeat >= 0 && !this.canAct(this.getPlayerBySeat(this.turnSeat)) && guard++ < 20) {
      var nxt = this.nextActorSeat(this.turnSeat);
      if (nxt < 0) break;
      this.turnSeat = nxt;
    }
  };

  // 玩家操作：type ∈ fold|check|call|raise
  // bet      = 本轮下注额（每街清零）
  // totalBet = 整手累计下注额（用于边池，不清零）
  // currentBet = 本轮最高 bet；raise 时 amount 为"目标本轮 bet"
  Room.prototype.doAction = function (playerId, type, amount) {
    var p = this.getPlayer(playerId);
    if (!p) return { error: '玩家不存在' };
    if (this.stage === 'waiting' || this.stage === 'showdown') return { error: '当前不可操作' };
    if (p.seat !== this.turnSeat) return { error: '还没轮到你' };
    if (!this.canAct(p)) return { error: '你已无法操作（全下或已弃牌）' };

    if (type === 'fold') {
      p.folded = true; p.acted = true; p.lastAction = 'fold';
      this.message = p.name + ' 弃牌';
      this.afterAction();
      return { ok: true };
    }
    if (type === 'check') {
      if (p.bet < this.currentBet) return { error: '不能过牌，需要跟注' };
      p.acted = true; p.lastAction = 'check';
      this.message = p.name + ' 过牌';
      this.afterAction();
      return { ok: true };
    }
    if (type === 'call') {
      var need = Math.min(this.currentBet - p.bet, p.chips);
      p.chips -= need; p.bet += need; p.totalBet += need; this.pot += need;
      p.acted = true;
      if (p.chips === 0) p.allIn = true;
      p.lastAction = p.allIn ? 'allin' : 'call';
      this.message = p.name + (p.allIn ? ' 跟注全下' : ' 跟注 ' + need);
      this.afterAction();
      return { ok: true };
    }
    if (type === 'raise') {
      var target = Math.max(0, Math.floor(amount));      // 目标"本轮 bet"
      var maxTarget = p.bet + p.chips;                    // 最多只能加到这么多
      if (target > maxTarget) return { error: '筹码不足' };
      var isAllInRaise = (target === maxTarget);
      if (!isAllInRaise && target < this.currentBet + this.minRaise)
        return { error: '加注至少到 ' + (this.currentBet + this.minRaise) };
      if (target <= this.currentBet) return { error: '加注必须高于当前下注' };
      var pay = target - p.bet;
      p.chips -= pay; p.bet = target; p.totalBet += pay; this.pot += pay;
      var raiseSize = target - this.currentBet;
      if (raiseSize > 0) this.minRaise = raiseSize;
      this.currentBet = target;
      p.acted = true;
      if (p.chips === 0) { p.allIn = true; p.lastAction = 'allin'; this.message = p.name + ' 全下 ' + target; }
      else { p.lastAction = 'raise'; this.message = p.name + ' 加注到 ' + target; }
      var self = this;
      this.players.forEach(function (o) { if (o !== p && !o.folded && !o.allIn) o.acted = false; });
      this.afterAction();
      return { ok: true };
    }
    return { error: '未知操作' };
  };

  Room.prototype.afterAction = function () {
    var inHand = this.players.filter(function (p) { return !p.folded; });
    if (inHand.length === 1) { this.awardUncontested(inHand[0]); return; }
    if (this.bettingRoundComplete()) { this.endBettingRound(); return; }
    this.advanceTurn();
  };

  Room.prototype.bettingRoundComplete = function () {
    var actors = this.players.filter(function (p) { return !p.folded && !p.allIn; });
    if (actors.length === 0) return true;
    return actors.every(function (p) { return p.acted && p.bet === this.currentBet; }, this);
  };

  Room.prototype.advanceTurn = function () {
    var idx = this.nextActorSeat(this.turnSeat);
    if (idx < 0) { this.endBettingRound(); return; }
    this.turnSeat = idx;
    var p = this.getPlayerBySeat(idx);
    if (p && !p.connected) {
      p.folded = true; p.acted = true; p.lastAction = 'fold';
      this.message = p.name + ' 掉线，自动弃牌';
      this.afterAction();
    }
  };

  Room.prototype.endBettingRound = function () {
    var self = this;
    this.players.forEach(function (p) { p.bet = 0; });
    var inHand = this.players.filter(function (p) { return !p.folded; });
    if (inHand.length === 1) { this.awardUncontested(inHand[0]); return; }
    var canAct = this.players.filter(function (p) { return !p.folded && !p.allIn; });
    if (canAct.length <= 1) { this.runOut(); return; }
    // 进入下一街（若已是河牌且仍 ≥2 人可行动，则直接摊牌）
    this.currentBet = 0; this.minRaise = this.bigBlind;
    this.players.forEach(function (p) { p.acted = false; });
    this.dealStreet();
    if (this.stage === 'river') { this.showdown(); return; }
    var idx = this.nextActorSeat(this.dealerSeat);
    this.turnSeat = idx;
    if (idx < 0) this.endBettingRound();
  };

  Room.prototype.dealStreet = function () {
    if (this.stage === 'preflop') { this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.stage = 'flop'; }
    else if (this.stage === 'flop') { this.community.push(this.deck.pop()); this.stage = 'turn'; }
    else if (this.stage === 'turn') { this.community.push(this.deck.pop()); this.stage = 'river'; }
  };

  // 无人可下注时，直接发完剩余公共牌并摊牌
  Room.prototype.runOut = function () {
    var guard = 0;
    while (this.stage !== 'river' && guard++ < 5) this.dealStreet();
    this.showdown();
  };

  Room.prototype.awardUncontested = function (winner) {
    winner.chips += this.pot;
    this.lastResults = {
      type: 'fold', winners: [winner.id], community: this.community.slice(),
      pots: [{ amount: this.pot, winners: [winner.id] }],
      hands: []
    };
    this.message = winner.name + ' 赢得底池 ' + this.pot + '（他人弃牌）';
    this.stage = 'showdown'; this.turnSeat = -1;
  };

  // 边池计算：返回 [{amount, eligible:[playerId...]}]
  Room.prototype.calcPots = function () {
    var contributors = this.players.filter(function (p) { return p.totalBet > 0; });
    if (!contributors.length) return [];
    var levels = {};
    contributors.forEach(function (p) { levels[p.totalBet] = true; });
    var lv = Object.keys(levels).map(Number).sort(function (a, b) { return a - b; });
    var pots = [], prev = 0;
    for (var i = 0; i < lv.length; i++) {
      var lvl = lv[i];
      var contrib = contributors.filter(function (p) { return p.totalBet >= lvl; });
      var amount = (lvl - prev) * contrib.length;
      if (amount > 0) {
        var eligible = contrib.filter(function (p) { return !p.folded; }).map(function (p) { return p.id; });
        pots.push({ amount: amount, eligible: eligible });
      }
      prev = lvl;
    }
    return pots;
  };

  Room.prototype.showdown = function () {
    this.stage = 'showdown'; this.turnSeat = -1;
    var self = this;
    var inHand = this.players.filter(function (p) { return !p.folded; });
    var evals = inHand.map(function (p) {
      return { p: p, h: best7(p.hand.concat(self.community)) };
    });
    var pots = this.calcPots();
    var results = [];
    pots.forEach(function (pot) {
      var elig = evals.filter(function (e) { return pot.eligible.indexOf(e.p.id) >= 0; });
      if (!elig.length) return;
      var best = elig[0];
      elig.forEach(function (e) { if (compare(e.h, best.h) > 0) best = e; });
      var winners = elig.filter(function (e) { return compare(e.h, best.h) === 0; }).map(function (e) { return e.p.id; });
      var share = Math.floor(pot.amount / winners.length);
      var rem = pot.amount - share * winners.length;
      winners.forEach(function (id, i) {
        var pl = self.getPlayer(id);
        if (pl) pl.chips += share + (i === 0 ? rem : 0);
      });
      results.push({ amount: pot.amount, winners: winners, handName: handName(best.h) });
    });
    this.lastResults = {
      type: 'showdown', community: this.community.slice(), pots: results,
      hands: evals.map(function (e) {
        return { id: e.p.id, name: e.p.name, cards: e.p.hand.slice(), handName: handName(e.h), cat: e.h.cat };
      })
    };
    if (results.length) {
      var wnames = results[0].winners.map(function (id) { var pl = self.getPlayer(id); return pl ? pl.name : id; });
      this.message = wnames.join('、') + ' 以「' + results[0].handName + '」赢得 ' + results[0].amount;
    }
  };

  // 房主重置所有筹码（记分娱乐局方便重开）
  Room.prototype.resetChips = function () {
    this.players.forEach(function (p) { p.chips = this.startingChips; }, this);
    this.stage = 'waiting'; this.community = []; this.pot = 0; this.lastResults = null;
    this.message = '已重置筹码';
  };

  // 序列化给指定玩家看（隐藏他人手牌，摊牌时全揭示）
  Room.prototype.serialize = function (forPlayerId) {
    var self = this;
    return {
      code: this.code,
      name: this.name,
      stage: this.stage,
      community: this.community.slice(),
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerSeat: this.dealerSeat,
      turnSeat: this.turnSeat,
      handNumber: this.handNumber,
      message: this.message,
      lastResults: this.lastResults,
      hostId: this.hostId,
      canStart: this.stage === 'waiting' && this.getParticipants().length >= 2,
      players: this.players.map(function (p) {
        var showHand = (forPlayerId && p.id === forPlayerId) || self.stage === 'showdown';
        return {
          id: p.id, name: p.name, seat: p.seat, chips: p.chips,
          folded: p.folded, allIn: p.allIn, bet: p.bet, totalBet: p.totalBet,
          acted: p.acted, connected: p.connected, lastAction: p.lastAction,
          isDealer: p.seat === self.dealerSeat,
          isTurn: p.seat === self.turnSeat,
          hand: showHand ? p.hand.slice() : [],
          handHidden: !showHand
        };
      })
    };
  };

  var API = {
    SUITS: SUITS, RANKS: RANKS, CAT: CAT, CAT_NAME: CAT_NAME,
    rankLabel: rankLabel, cardLabel: cardLabel, isRed: isRed,
    createDeck: createDeck, shuffle: shuffle,
    evaluate5: evaluate5, compare: compare, best7: best7, handName: handName,
    Room: Room
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.PokerEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);
