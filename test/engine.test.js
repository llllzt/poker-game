/*
 * 引擎单元测试 + 随机对局模拟
 * 运行：node test/engine.test.js
 */
var E = require('../engine.js');
var assert = require('assert');

var passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL: ' + name); }
}
function eq(name, a, b) { ok(name + ' (得到 ' + JSON.stringify(a) + ')', a === b); }

// ---------- 1. 牌型大小 ----------
function hand(str) {
  // 例如 "As Ks Qs Js Ts" -> 同花顺；花色用字母 s/h/d/c 表示
  return str.split(' ').map(function (t) {
    var r = t.slice(0, -1), sLetter = t.slice(-1);
    var s = { s: 0, h: 1, d: 2, c: 3 }[sLetter];
    var rv = { A: 14, K: 13, Q: 12, J: 11, T: 10 }[r] || parseInt(r, 10);
    return { r: rv, s: s };
  });
}
function ev(str) { return E.evaluate5(hand(str)); }

ok('同花顺 > 四条', E.compare(ev('As Ks Qs Js Ts'), ev('9s 9h 9d 9c 2s')) > 0);
ok('四条 > 葫芦', E.compare(ev('9s 9h 9d 9c 2s'), ev('Kd Kh Ks 3d 3h')) > 0);
ok('葫芦 > 同花', E.compare(ev('Kd Kh Ks 3d 3h'), ev('Ah 9h 5h 3h 2h')) > 0);
ok('同花 > 顺子', E.compare(ev('Ah 9h 5h 3h 2h'), ev('Ks Qd Jc Th 9s')) > 0);
ok('顺子(含轮子 A2345) < 同花', E.compare(ev('As 2d 3h 4c 5s'), ev('Ah Kh Qh Jh 9h')) < 0);
ok('顺子 高牌比较', E.compare(ev('As Kd Qc Jh Ts'), ev('Ks Qd Jc Th 8s')) > 0);
ok('一对 踢脚比较', E.compare(ev('As Ah Kd Qc 9s'), ev('Ad Ac Ks Qh 8s')) > 0);
ok('两对 顶对比较', E.compare(ev('As Ah Kd Kc 9s'), ev('Qs Qh Jd Jc As')) > 0);
ok('完全相同 平局', E.compare(ev('As Ah Kd Qc 9s'), ev('Ad Ac Kh Qs 9h')) === 0);
ok('葫芦 三条大小', E.compare(ev('As Ah Ad Kc 9s'), ev('Ks Kh Kd Qc 9h')) > 0);

// 7 张最佳
ok('7张选出同花顺', E.best7(hand('As Ks Qs Js Ts 2h 3d')).cat === E.CAT.STRAIGHT_FLUSH);
ok('7张选出四条', E.best7(hand('9s 9h 9d 9c 2s 3h 4d')).cat === E.CAT.QUADS);
ok('7张选出葫芦', E.best7(hand('Ks Kh Kd 3s 3h 9c 2d')).cat === E.CAT.FULL_HOUSE);

// ---------- 2. 边池计算 ----------
(function () {
  var room = new E.Room({ code: 'T' });
  // 三个玩家不同投入
  var a = room.addPlayer('a', 'A'), b = room.addPlayer('b', 'B'), c = room.addPlayer('c', 'C');
  a.totalBet = 100; b.totalBet = 100; c.totalBet = 50;
  // 全入层：c 全下50；b 加到100（再投50）；a 加到100（已100）
  var pots = room.calcPots();
  // 主池 = 50*3 = 150 (eligible a,b,c)；边池 = 50*2 = 100 (eligible a,b)
  eq('边池数量', pots.length, 2);
  eq('主池金额', pots[0].amount, 150);
  eq('边池金额', pots[1].amount, 100);
  ok('主池含三人', pots[0].eligible.length === 3);
  ok('边池含两人', pots[1].eligible.length === 2);
})();

// ---------- 3. 随机对局模拟 + 筹码守恒 ----------
function simulate(seed) {
  // 简单可复现随机
  var s = seed;
  function rnd() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }

  var room = new E.Room({ code: 'SIM', startingChips: 1000, smallBlind: 10, bigBlind: 20 });
  var ids = ['p0', 'p1', 'p2', 'p3', 'p4'];
  ids.forEach(function (id, i) { room.addPlayer(id, 'P' + i); });

  var totalChips = ids.length * 1000;
  var hands = 0, guard = 0;
  while (hands < 200 && guard++ < 5000) {
    if (room.stage === 'waiting') {
      if (room.getParticipants().length < 2) break;
      if (!room.startHand()) break;
    }
    // 随机行动直到本手结束
    var step = 0;
    while (room.stage !== 'showdown' && room.stage !== 'waiting' && step++ < 200) {
      var actor = room.getPlayerBySeat(room.turnSeat);
      if (!actor) { room.endBettingRound ? room.endBettingRound() : null; break; }
      var r = rnd();
      var toCall = room.currentBet - actor.totalBet;
      var type;
      if (r < 0.25) type = 'fold';
      else if (r < 0.55 || toCall === 0) type = 'check';
      else if (r < 0.85) type = 'call';
      else type = 'raise';
      var amount = 0;
      if (type === 'raise') {
        var maxT = actor.chips + actor.totalBet;
        var minT = Math.min(room.currentBet + room.minRaise, maxT);
        if (minT >= maxT) amount = maxT; // 全下
        else amount = minT + Math.floor(rnd() * (maxT - minT));
      }
      var res = room.doAction(actor.id, type, amount);
      if (res && res.error) {
        // 出错则改用过牌/跟注兜底
        var fb = (toCall === 0) ? room.doAction(actor.id, 'check', 0) : room.doAction(actor.id, 'call', 0);
        if (fb && fb.error) { room.doAction(actor.id, 'fold', 0); }
      }
      // 筹码守恒（进行中）：持币 + 底池 == 初始总量；showdown 时底池已分配、不计入
      if (room.stage !== 'showdown') {
        var sum = room.players.reduce(function (acc, p) { return acc + p.chips; }, 0) + room.pot;
        if (sum !== totalChips) return '筹码不守恒 @hand' + hands + ' stage=' + room.stage + ' sum=' + sum;
      }
    }
    // 一手结束后，底池应已清空并分配
    if (room.stage === 'showdown') {
      var sum2 = room.players.reduce(function (acc, p) { return acc + p.chips; }, 0);
      if (sum2 !== totalChips) return '摊牌后筹码不守恒 sum=' + sum2;
      hands++;
      // 移除破产玩家（模拟离场），留下 ≥2 人继续
      var alive = room.players.filter(function (p) { return p.chips > 0; });
      if (alive.length < 2) { room.resetChips(); totalChips = ids.length * 1000; }
    }
  }
  return 'OK hands=' + hands;
}

['seed1', 'seed2', 'seed3', 'seed4', 'seed5'].forEach(function (sd, i) {
  var r = simulate(1000 + i * 7);
  ok('模拟 ' + sd + ' : ' + r, r.indexOf('OK') === 0);
  if (r.indexOf('OK') !== 0) console.error('    -> ' + r);
});

console.log('\n通过: ' + passed + '  失败: ' + failed);
process.exit(failed ? 1 : 0);
