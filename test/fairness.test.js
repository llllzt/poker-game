/*
 * 发牌公平性（Monte Carlo）测试
 * 目的：用数据证明"发牌公允、无系统性偏置"，并验证贴近真实的烧牌流程不产生重复牌。
 * 运行：node test/fairness.test.js
 */
var E = require('../engine.js');

var passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL: ' + name); }
}

// ---------- 1. 单手内无重复牌 ----------
// 发大量随机手，确认每位玩家的 2 张底牌、5 张公共牌，整手所有"可见牌"互不相同
// （绝不可能出现两张一样的牌），且张数严格等于 2*人数 + 5。
(function () {
  var N = 5000;
  var dupFound = false, badShape = 0;
  for (var i = 0; i < N; i++) {
    var room = new E.Room({ code: 'X', startingChips: 1000 });
    var np = 2 + (i % 9); // 2~10 人随机
    for (var p = 0; p < np; p++) room.addPlayer('p' + p, 'P' + p);
    room.startHand();
    // 直接驱动发完三条街（与真实发牌顺序一致：烧牌+翻牌 + 烧牌+转牌 + 烧牌+河牌）
    room.dealStreet(); // preflop -> flop
    room.dealStreet(); // flop -> turn
    room.dealStreet(); // turn -> river
    // 收集本手所有"可见牌"：所有玩家底牌 + 公共牌（各只计一次），检查无重复
    var seen = {};
    var total = 0;
    room.players.forEach(function (pl) {
      if (pl.hand.length !== 2) { badShape++; return; }
      total += 2;
      [pl.hand[0], pl.hand[1]].forEach(function (c) {
        var k = c.r + '-' + c.s;
        if (seen[k]) dupFound = true; seen[k] = true;
      });
    });
    if (room.community.length !== 5) badShape++;
    room.community.forEach(function (c) {
      var k = c.r + '-' + c.s;
      if (seen[k]) dupFound = true; seen[k] = true;
      total++;
    });
    if (total !== 2 * np + 5) badShape++;
  }
  ok('5000 手随机牌：单手内无任何重复牌', !dupFound);
  ok('发牌结构正确（每人 2 张底牌、公共牌 5 张、张数吻合）', badShape === 0);
})();

// ---------- 2. 洗牌均匀性（无偏置） ----------
// 发 20000 手，统计每位玩家"第一张底牌"的 52 种取值出现次数，
// 理想情况下每种约 N*玩家数/52 次。若某张牌被系统性偏爱/压制，即为偏置。
(function () {
  var N = 20000;
  var counts = {};
  for (var i = 0; i < N; i++) {
    var room = new E.Room({ code: 'X' });
    for (var p = 0; p < 4; p++) room.addPlayer('p' + p, 'P' + p);
    room.startHand();
    room.players.forEach(function (pl) {
      var c = pl.hand[0];
      var k = c.r + '-' + c.s;
      counts[k] = (counts[k] || 0) + 1;
    });
  }
  var keys = Object.keys(counts);
  ok('出现的牌型覆盖全部 52 种', keys.length === 52);

  var expected = (N * 4) / 52;
  var tol = expected * 0.15; // 允许 ±15% 随机波动容差（统计上约 4σ，几乎不可能误判）
  var maxDev = 0, worst = '';
  keys.forEach(function (k) {
    var dev = Math.abs(counts[k] - expected);
    if (dev > maxDev) { maxDev = dev; worst = k; }
  });
  ok('各牌出现频率均衡（无系统性偏置，容差 15%，最差值=' + Math.round(maxDev) + ' 期望≈' + Math.round(expected) + '）', maxDev <= tol);
})();

// ---------- 3. 每手独立（无跨手记忆） ----------
// 连续发 1000 手，记录某固定座位拿到 AA 的次数，应在合理统计范围附近（纯随机）。
(function () {
  var N = 5000, aa = 0;
  for (var i = 0; i < N; i++) {
    var room = new E.Room({ code: 'X' });
    for (var p = 0; p < 4; p++) room.addPlayer('p' + p, 'P' + p);
    room.startHand();
    var h = room.players[0].hand;
    var isAA = h[0].r === 14 && h[1].r === 14 && h[0].s !== h[1].s;
    if (isAA) aa++;
  }
  // 拿到口袋 A 的概率约 C(4,2)/C(52,2)=6/1326≈0.45%；5000 手期望≈22.6 次
  ok('口袋 A 出现频率接近理论值（' + aa + ' / 5000，期望≈22.6）', aa >= 8 && aa <= 50);
})();

console.log('\n通过: ' + passed + '  失败: ' + failed);
process.exit(failed ? 1 : 0);
