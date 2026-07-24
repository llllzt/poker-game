/*
 * 局域网服务器端到端测试（Node 22 内置 fetch / http）
 * 验证：/api/health、/api/create 建房、/api/rooms 目录、/api/join 加入(含404)、
 *       房主开始、完整一手牌、筹码守恒、SSE 推送、越权拒绝、空房间清理。
 * 运行：node test/server.test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 4123;
const BASE = 'http://127.0.0.1:' + PORT;

let failures = 0;
function ok(cond, label) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failures++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) { } resolve({ status: res.statusCode, json: j }); });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function openSSE(code, pid) {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/api/events?code=' + encodeURIComponent(code) + '&playerId=' + encodeURIComponent(pid), (res) => {
      const api = { state: null, close: () => req.destroy() };
      res.on('data', (chunk) => {
        chunk.toString().split('\n').forEach((l) => {
          if (l.startsWith('data: ')) {
            try { const m = JSON.parse(l.slice(6)); if (m.type === 'state') api.state = m.state; } catch (e) { }
          }
        });
      });
      setTimeout(() => resolve(api), 200);
    });
  });
}

function listRooms() {
  return new Promise((resolve) => {
    http.get(BASE + '/api/rooms', (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) { } resolve(j && j.rooms ? j.rooms : []); });
    }).on('error', () => resolve([]));
  });
}

(async () => {
  const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '' + PORT } });
  await sleep(600);

  try {
    // 1. health 探测
    const h = await httpReq('GET', '/api/health');
    ok(h.status === 200 && h.json && h.json.mode === 'server', 'health 返回服务器模式');

    // 2. 不存在的房间加入 -> 404
    const j404 = await httpReq('POST', '/api/join', { code: 'NOPE99', name: 'X' });
    ok(j404.status === 404, '加入不存在的房间返回 404');

    // 3. 创建房间（房主），服务器分配房间码与名称
    const cA = await httpReq('POST', '/api/create', { name: '周五夜局', hostName: 'A' });
    const CODE = cA.json.code;
    const pidA = cA.json.playerId;
    ok(!!CODE && CODE.length === 6, '创建房间返回 6 位房间码: ' + CODE);
    ok(cA.json.isHost === true, '创建者为房主');
    ok(cA.json.state && cA.json.state.name === '周五夜局', '房间名已保存');

    // 4. 房间目录应包含该房间
    let rooms = await listRooms();
    const found = rooms.find((r) => r.code === CODE);
    ok(!!found && found.name === '周五夜局' && found.count === 1, '目录列出房间(名称/人数正确)');

    // 5. 第二位加入者（点击目录房间）
    const rB = await httpReq('POST', '/api/join', { code: CODE, name: 'B' });
    const pidB = rB.json.playerId;
    ok(!!pidB && rB.json.isHost === false, '第二位加入者非房主');
    rooms = await listRooms();
    ok(rooms.find((r) => r.code === CODE).count === 2, '目录人数更新为 2');

    // 6. SSE 推送
    const sseA = await openSSE(CODE, pidA);
    ok(sseA.state && sseA.state.players.length === 2, 'SSE 收到含 2 名玩家的状态');

    // 6.5 改名：B 修改自己的昵称，SSE 应同步；空名应被拒
    const rn = await httpReq('POST', '/api/rename', { code: CODE, playerId: pidB, name: '小B' });
    ok(rn.status === 200 && rn.json.ok === true, 'B 改名成功');
    await sleep(150);
    const bNow = sseA.state.players.find((p) => p.id === pidB);
    ok(bNow && bNow.name === '小B', '改名后 SSE 状态同步（B 名为 小B）');
    const rnBad = await httpReq('POST', '/api/rename', { code: CODE, playerId: pidB, name: '   ' });
    ok(rnBad.status === 400, '空昵称改名被拒绝(400)');

    // 7. 房主开始
    const st = await httpReq('POST', '/api/control', { code: CODE, playerId: pidA, op: 'start' });
    ok(st.json && st.json.ok === true, '房主开始游戏成功');
    await sleep(150);
    ok(sseA.state.stage === 'preflop', '已进入 preflop');
    const meA = sseA.state.players.find((p) => p.id === pidA);
    ok(meA && meA.hand.length === 2, '房主发到 2 张底牌');
    ok(sseA.state.players.every((p) => p.totalBet > 0), '两人已下盲注');

    // 8. 自动打完一手（双方跟注/过牌至摊牌）
    let guard = 0;
    while (sseA.state.stage !== 'showdown' && guard++ < 80) {
      const stt = sseA.state;
      const actor = stt.players.find((p) => p.isTurn && !p.folded && !p.allIn);
      if (actor) {
        const toCall = stt.currentBet - actor.bet;
        await httpReq('POST', '/api/action', { code: CODE, playerId: actor.id, action: toCall > 0 ? 'call' : 'check', amount: 0 });
      }
      await sleep(40);
    }
    ok(sseA.state.stage === 'showdown', '一手牌进行到摊牌');
    const total = sseA.state.players.reduce((a, p) => a + p.chips, 0);
    ok(total === 2000, '筹码守恒（2 人 × 1000 = ' + total + '）');
    ok(!!sseA.state.lastResults, '产生结算结果（有人赢池）');

    // 9. 非房主操作应被拒绝
    const bad = await httpReq('POST', '/api/control', { code: CODE, playerId: pidB, op: 'start' });
    ok(bad.status === 403, '非房主的控制指令被拒绝(403)');

    // 10. 全部离开后房间应从目录清理
    await httpReq('POST', '/api/leave', { code: CODE, playerId: pidB });
    await sleep(120);
    await httpReq('POST', '/api/leave', { code: CODE, playerId: pidA });
    await sleep(200);
    rooms = await listRooms();
    ok(!rooms.find((r) => r.code === CODE), '全员离开后空房间从目录清除');

    sseA.close();
  } catch (e) {
    console.log('FAIL 测试异常: ' + (e && e.message));
    failures++;
  } finally {
    server.kill();
  }

  console.log(failures === 0 ? '\n✅ 全部通过' : '\n❌ 存在 ' + failures + ' 项失败');
  process.exit(failures === 0 ? 0 : 1);
})();
