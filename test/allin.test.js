/*
 * 回归测试：玩家 A 全下后，玩家 B（筹码更少）必须仍能行动（跟注全下/弃牌）。
 */
const E = require('../engine.js');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.log('  ✗ ' + name); }
}

const room = new E.Room({ code: 'TEST', startingChips: 1000, smallBlind: 10, bigBlind: 20 });
const a = room.addPlayer('a', 'A');  // host / seat 0
const b = room.addPlayer('b', 'B');  // client / seat 1

room.startHand();

ok('阶段=preflop', room.stage === 'preflop');
ok('A 当 SB（庄家），筹码 990', a.chips === 990 && a.bet === 10 && a.totalBet === 10);
ok('B 当 BB，筹码 980', b.chips === 980 && b.bet === 20 && b.totalBet === 20);
ok('当前下注 = 20', room.currentBet === 20);
ok('轮到 A', room.turnSeat === a.seat);

// A 全力 raise 到 1000（全下）
const r = room.doAction(a.id, 'raise', 1000);
ok('A 全下指令返回 ok', r && r.ok);
ok('A 筹码清零', a.chips === 0);
ok('A.bet = 1000', a.bet === 1000);
ok('A.totalBet = 1000', a.totalBet === 1000);
ok('A.allIn = true', a.allIn === true);
ok('currentBet 升至 1000', room.currentBet === 1000);
ok('底池 = 1020（1000+20）', room.pot === 1020);

// 关键：B 必须轮到行动，且仍能操作
ok('B 未弃', b.folded === false);
ok('B 未全下', b.allIn === false);
ok('B.acted = false（被 raise 重置）', b.acted === false);
ok('** turnSeat 已切到 B **', room.turnSeat === b.seat);
ok('** 阶段仍为 preflop（未跳到摊牌）**', room.stage === 'preflop');
ok('公共牌仍为空', room.community.length === 0);

// B 应该能弃牌
const f = room.doAction(b.id, 'fold', 0);
ok('B 可弃牌', f && f.ok);
ok('A 凭弃牌赢得底池 1020', a.chips === 1020);
ok('阶段进入 showdown（无人可摊）', room.stage === 'showdown');

// —— 再跑一遍 B 跟注全下的分支 ——
const room2 = new E.Room({ code: 'TEST2', startingChips: 1000, smallBlind: 10, bigBlind: 20 });
const a2 = room2.addPlayer('a', 'A');
const b2 = room2.addPlayer('b', 'B');
room2.startHand();
room2.doAction(a2.id, 'raise', 1000);
ok('2: turnSeat → B', room2.turnSeat === b2.seat);
ok('2: 阶段仍 preflop', room2.stage === 'preflop');
const c = room2.doAction(b2.id, 'call', 0);
ok('2: B 可跟注', c && c.ok);
ok('2: B 进入 allIn 标志', b2.allIn === true);
ok('2: B.totalBet = 1000', b2.totalBet === 1000);
ok('2: 阶段摊牌（双方全下）', room2.stage === 'showdown');
ok('2: 公共牌 5 张', room2.community.length === 5);
const sum2 = a2.chips + b2.chips;
ok('2: 筹码守恒 = 2000', sum2 === 2000);

// —— 三人局：A、B、C；A 全下后 B 必须能行动 ——
const room3 = new E.Room({ code: 'TEST3', startingChips: 1000, smallBlind: 10, bigBlind: 20 });
const a3 = room3.addPlayer('a', 'A');
const b3 = room3.addPlayer('b', 'B');
const c3 = room3.addPlayer('c', 'C');
room3.startHand();
// 3人局：A是庄家，依次发牌；SB=B，BB=C，UTG=A先行动
// 让 A 全下
const r3 = room3.doAction(a3.id, 'raise', 1000);
ok('3: A 全下成功', r3 && r3.ok);
ok('3: A.allIn=true', a3.allIn === true);
// B 是 SB（已下盲注 10），需要决定是否跟注 A 的全下
ok('3: B 未弃，未全下', !b3.folded && !b3.allIn);
ok('3: turnSeat → B（SB，跟注全下或弃牌）', room3.turnSeat === b3.seat);
ok('3: 阶段仍 preflop', room3.stage === 'preflop');

console.log(`\nAll-in 响应测试：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);