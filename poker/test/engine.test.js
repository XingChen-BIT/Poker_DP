'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluate5, evaluate7, evaluate7WithCards, compare, describe } = require('../engine/evaluate');
const { Table } = require('../engine/table');

// 便捷构造牌：C('As') -> { rank:14, suit:'s' }
function C(s) {
  const rankMap = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
  return { rank: rankMap[s[0]], suit: s[1].toLowerCase() };
}
function Cs(arr) { return arr.map(C); }

test('evaluate5：皇家同花顺 / 同花顺', () => {
  assert.deepStrictEqual(evaluate5(Cs(['As', 'Ks', 'Qs', 'Js', 'Ts'])), { category: 8, ranks: [14] });
  assert.strictEqual(describe(evaluate5(Cs(['As', 'Ks', 'Qs', 'Js', 'Ts']))), '皇家同花顺');
  assert.deepStrictEqual(evaluate5(Cs(['9s', '8s', '7s', '6s', '5s'])), { category: 8, ranks: [9] });
  // 轮子同花顺
  assert.deepStrictEqual(evaluate5(Cs(['As', '2s', '3s', '4s', '5s'])), { category: 8, ranks: [5] });
});

test('evaluate5：四条 / 葫芦', () => {
  assert.deepStrictEqual(evaluate5(Cs(['9s', '9h', '9d', '9c', 'Ks'])), { category: 7, ranks: [9, 13] });
  assert.deepStrictEqual(evaluate5(Cs(['9s', '9h', '9d', 'Ks', 'Kc'])), { category: 6, ranks: [9, 13] });
});

test('evaluate5：同花 / 顺子', () => {
  assert.deepStrictEqual(evaluate5(Cs(['As', 'Js', '9s', '5s', '2s'])), { category: 5, ranks: [14, 11, 9, 5, 2] });
  assert.deepStrictEqual(evaluate5(Cs(['9s', '8h', '7d', '6c', '5s'])), { category: 4, ranks: [9] });
  assert.deepStrictEqual(evaluate5(Cs(['As', '2h', '3d', '4c', '5s'])), { category: 4, ranks: [5] });
});

test('evaluate5：三条 / 两对 / 一对 / 高牌', () => {
  assert.deepStrictEqual(evaluate5(Cs(['9s', '9h', '9d', 'Ks', '2c'])), { category: 3, ranks: [9, 13, 2] });
  assert.deepStrictEqual(evaluate5(Cs(['9s', '9h', 'Kd', 'Kc', '2s'])), { category: 2, ranks: [13, 9, 2] });
  assert.deepStrictEqual(evaluate5(Cs(['9s', '9h', 'Kd', 'Jc', '2s'])), { category: 1, ranks: [9, 13, 11, 2] });
  assert.deepStrictEqual(evaluate5(Cs(['As', 'Qh', '9d', '5c', '2s'])), { category: 0, ranks: [14, 12, 9, 5, 2] });
});

test('evaluate7：从 7 张中选出最优 5 张', () => {
  // 桌面四张黑桃 A K Q J，底牌 10s -> 皇家同花顺
  const royal = evaluate7(Cs(['As', 'Ks', 'Qs', 'Js', '2d', 'Ts', '3c']));
  assert.strictEqual(royal.category, 8);
  assert.strictEqual(royal.ranks[0], 14);

  // 桌面 A K Q J 黑桃 + 底牌 9s -> 同花（无顺子）
  const flush = evaluate7(Cs(['As', 'Ks', 'Qs', 'Js', '2d', '9s', '3c']));
  assert.strictEqual(flush.category, 5);

  // 6 张黑桃选 5 张最大
  const flush2 = evaluate7(Cs(['As', 'Ks', '9s', '5s', '2s', '3d', '3c']));
  assert.strictEqual(flush2.category, 5);
  assert.deepStrictEqual(flush2.ranks, [14, 13, 9, 5, 2]);
});

test('evaluate7WithCards：返回组成最大牌型的 5 张牌', () => {
  const cards = Cs(['As', 'Ks', 'Qs', 'Js', '2d', 'Ts', '3c']);
  const royal = evaluate7WithCards(cards);
  assert.strictEqual(royal.category, 8);
  assert.strictEqual(royal.cards.length, 5);
  assert.deepStrictEqual(royal.cards, Cs(['As', 'Ks', 'Qs', 'Js', 'Ts']));
});

test('compare：踢脚牌决定胜负', () => {
  const pairAcesKickerQ = evaluate5(Cs(['As', 'Ah', 'Qd', '9c', '2s']));
  const pairAcesKickerJ = evaluate5(Cs(['As', 'Ad', 'Jd', '9c', '2s']));
  assert.ok(compare(pairAcesKickerQ, pairAcesKickerJ) > 0);
  assert.ok(compare(evaluate5(Cs(['As', 'Ah', 'Qd', '9c', '2s'])), evaluate5(Cs(['Ks', 'Kh', 'Qd', '9c', '2s']))) > 0);
});

// ---------------- 边池与筹码结算 ----------------

function makeTable() {
  const t = new Table({ code: 'TEST', hostId: 'h', settings: { initialChips: 1000, smallBlind: 5, bigBlind: 10 } });
  t.addPlayer('a', 'A');
  t.addPlayer('b', 'B');
  t.addPlayer('c', 'C');
  return t;
}

test('边池：三人不同下注额按层分配', () => {
  const t = makeTable();
  t.status = 'playing';
  t.street = 'showdown';
  t.dealerSeat = 0;
  t.board = Cs(['2s', '3d', '8h', '9c', '7d']);

  const [A, B, C] = t.players;
  A.hole = Cs(['As', 'Ad']); A.totalCommitted = 100; A.folded = false; // 对A，赢主池
  B.hole = Cs(['Kd', 'Kh']); B.totalCommitted = 200; B.folded = false; // 对K，赢边池1
  C.hole = Cs(['Qc', 'Qd']); C.totalCommitted = 300; C.folded = false; // 对Q，赢边池2

  t.computePotsAndDistribute();

  assert.strictEqual(A.chips - 1000, 300); // 主池 100*3
  assert.strictEqual(B.chips - 1000, 200); // 边池 (B,C) 100*2
  assert.strictEqual(C.chips - 1000, 100); // 边池 (C) 100
  assert.strictEqual(t.winners.length, 3);
  assert.strictEqual(t.winners.reduce((s, w) => s + w.amount, 0), 600);
});

test('边池：弃牌玩家不进边池，仅贡献筹码', () => {
  const t = makeTable();
  t.status = 'playing';
  t.street = 'showdown';
  t.dealerSeat = 0;
  t.board = Cs(['2s', '3d', '8h', '9c', '7d']);

  const [A, B, C] = t.players;
  A.hole = Cs(['As', 'Ad']); A.totalCommitted = 100; A.folded = true;  // 弃牌
  B.hole = Cs(['Kd', 'Kh']); B.totalCommitted = 300; B.folded = false;
  C.hole = Cs(['Qc', 'Qd']); C.totalCommitted = 300; C.folded = false;

  t.computePotsAndDistribute();

  // 总池 700（A 100 + B 300 + C 300）。A 弃牌不能赢；
  // 主池 300（A/B/C 各100）与边池 400（B/C 各200）都由 B 的对K 胜过 C 的对Q 拿下
  assert.strictEqual(B.chips - 1000, 700);
  assert.strictEqual(C.chips - 1000, 0);
});

test('平分底池与奇数筹码', () => {
  const t = makeTable();
  t.status = 'playing';
  t.street = 'showdown';
  t.dealerSeat = 0;
  t.board = Cs(['2s', '3d', '8h', '9c', '7d']);

  // 三人手牌等价（都只打桌面 A K 高）
  t.players[0].hole = Cs(['As', 'Kd']); t.players[0].totalCommitted = 100; t.players[0].folded = false;
  t.players[1].hole = Cs(['Ad', 'Ks']); t.players[1].totalCommitted = 100; t.players[1].folded = false;
  t.players[2].hole = Cs(['Ac', 'Kh']); t.players[2].totalCommitted = 100; t.players[2].folded = false;

  t.computePotsAndDistribute();

  const won = t.players.map((p) => p.chips - 1000);
  assert.strictEqual(won.reduce((s, x) => s + x, 0), 300);
  // 300 分给 3 人，每人 100，无奇数筹码
  won.forEach((x) => assert.strictEqual(x, 100));
});

test('奇数筹码分配到庄家左手第一位', () => {
  const t = makeTable();
  t.status = 'playing';
  t.street = 'showdown';
  t.dealerSeat = 0;
  t.board = Cs(['2s', '3d', '8h', '9c', '7d']);

  // 两人平分 101 筹码（各 100 + 1 余数）
  const [A, B] = [t.players[0], t.players[1]];
  A.hole = Cs(['As', 'Kd']); A.totalCommitted = 50; A.folded = false;
  B.hole = Cs(['Ad', 'Ks']); B.totalCommitted = 51; B.folded = false;
  t.players[2].folded = true;

  t.computePotsAndDistribute();
  const totalWon = A.won + B.won;
  assert.strictEqual(totalWon, 101);
  // 余数 1 枚给离庄家（seat0）最近的赢家 = seat1
  assert.strictEqual(B.won, 51);
  assert.strictEqual(A.won, 50);
});

// ---------------- 完整流程 ----------------

test('单挑开局：盲注、行动顺序、弃牌赢池', () => {
  const t = new Table({ code: 'T', hostId: 'h', settings: { initialChips: 1000, smallBlind: 5, bigBlind: 10 }, rng: () => 0.5 });
  t.addPlayer('a', 'A');
  t.addPlayer('b', 'B');
  assert.ok(t.startHand());

  assert.strictEqual(t.status, 'playing');
  assert.strictEqual(t.handNumber, 1);
  assert.strictEqual(t.board.length, 0);
  t.players.forEach((p) => assert.strictEqual(p.hole.length, 2));

  const { sb, bb } = t.computeBlindSeats();
  assert.strictEqual(t.players[sb].chips, 995);
  assert.strictEqual(t.players[bb].chips, 990);
  assert.strictEqual(t.currentBet, 10);
  // 单挑：小盲（庄家）翻牌前先行动
  assert.strictEqual(t.currentActorSeat, sb);

  t.applyAction(sb, 'fold');
  assert.strictEqual(t.status, 'handComplete');
  assert.strictEqual(t.players[bb].chips, 1005); // 990 + 15
  assert.strictEqual(t.winners[0].amount, 15);
});

test('盲注座位：3 人 SB/BB 顺序', () => {
  const t = makeTable();
  t.dealerSeat = 0;
  const { sb, bb } = t.computeBlindSeats();
  assert.strictEqual(sb, 1);
  assert.strictEqual(bb, 2);
  // 单挑
  t.removePlayer('c');
  t.dealerSeat = 0;
  const h2 = t.computeBlindSeats();
  assert.strictEqual(h2.sb, 0);
  assert.strictEqual(h2.bb, 1);
});

test('公开状态隐藏他人底牌，仅当前行动者本人可见操作', () => {
  const t = new Table({ code: 'T', hostId: 'h', settings: { initialChips: 1000, smallBlind: 5, bigBlind: 10 }, rng: () => 0.5 });
  t.addPlayer('a', 'A');
  t.addPlayer('b', 'B');
  t.startHand();
  const actor = t.players[t.currentActorSeat];
  const viewActor = t.toPublicState(actor.id);
  const actorSeat = viewActor.mySeat;
  viewActor.players.forEach((p) => {
    if (p.seat === actorSeat) assert.ok(Array.isArray(p.hole) && p.hole.length === 2);
    else assert.strictEqual(p.hole, null);
  });
  assert.ok(viewActor.myActions, '轮到行动者应有可用操作');
});

test('行动倒计时默认为 40 秒，并公开服务端校时信息', () => {
  const t = new Table({ code: 'T', hostId: 'a', settings: { initialChips: 1000, smallBlind: 5, bigBlind: 10 } });
  t.addPlayer('a', 'A');
  t.addPlayer('b', 'B');
  const before = Date.now();
  t.startHand();
  const after = Date.now();
  assert.strictEqual(t.turnTimeoutMs, 40000);
  assert.ok(t.turnDeadline >= before + 40000 && t.turnDeadline <= after + 40000);
  const view = t.toPublicState('a');
  assert.strictEqual(view.turnTimeoutMs, 40000);
  assert.ok(Number.isFinite(view.serverNow));
});

test('结算确认会记录玩家座位并公开比牌参与者', () => {
  const t = makeTable();
  t.status = 'playing';
  t.street = 'river';
  t.board = Cs(['As', 'Ks', 'Qs', 'Js', '2d']);
  t.players[0].hole = Cs(['Ts', '3c']);
  t.players[1].hole = Cs(['Ah', 'Ad']);
  t.players[2].hole = Cs(['9c', '9d']);
  t.players.forEach((p) => { p.totalCommitted = 100; p.folded = false; });
  t.showdown();

  assert.ok(t.markReadyForNext('a'));
  assert.ok(t.markReadyForNext('b'));
  assert.deepStrictEqual(t.nextHandReadySeats, [0, 1]);
  const view = t.toPublicState('a');
  assert.deepStrictEqual(view.showdownSeats, [0, 1, 2]);
  assert.deepStrictEqual(view.nextHandReadySeats, [0, 1]);
});

test('亮牌结算公开参与比牌者的两张手牌与最大五张牌', () => {
  const t = makeTable();
  t.status = 'playing';
  t.street = 'river';
  t.board = Cs(['As', 'Ks', 'Qs', 'Js', '2d']);
  t.players[0].hole = Cs(['Ts', '3c']);
  t.players[1].hole = Cs(['Ah', 'Ad']);
  t.players[2].hole = Cs(['9c', '9d']);
  t.players.forEach((p) => {
    p.totalCommitted = 100;
    p.folded = false;
  });

  t.showdown();
  const view = t.toPublicState('a');
  for (const p of view.players) {
    const reveal = view.reveals[p.seat];
    assert.strictEqual(reveal.hole.length, 2);
    assert.strictEqual(reveal.bestFive.length, 5);
    assert.ok(reveal.desc);
  }
});
