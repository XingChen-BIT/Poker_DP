'use strict';

// 牌型判定：
// category 取值（越大越强）：
//   8 同花顺（含皇家同花顺）  7 四条  6 葫芦  5 同花  4 顺子
//   3 三条  2 两对  1 一对  0 高牌
//
// 每个判定结果形如 { category, ranks }，ranks 为按优先级排序的踢脚牌，
// 直接逐位比较 ranks 即可分出胜负。

const { rankLabel } = require('./cards');

const CATEGORY_NAMES = {
  8: '同花顺',
  7: '四条',
  6: '葫芦',
  5: '同花',
  4: '顺子',
  3: '三条',
  2: '两对',
  1: '一对',
  0: '高牌',
};

// 对 5 张牌进行判定
function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.suit === cards[0].suit);

  const unique = [...new Set(ranks)].sort((a, b) => b - a);

  let isStraight = false;
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) {
      isStraight = true;
      straightHigh = unique[0];
    } else if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
      // 轮子顺子 A-2-3-4-5
      isStraight = true;
      straightHigh = 5;
    }
  }

  // 统计每个点数的张数
  const counts = new Array(15).fill(0);
  for (const c of cards) counts[c.rank]++;

  let four = 0;
  let three = 0;
  const pairs = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) four = r;
    else if (counts[r] === 3) three = r;
    else if (counts[r] === 2) pairs.push(r);
  }
  pairs.sort((a, b) => b - a);

  const groupRanks = new Set([four, three, ...pairs].filter((x) => x));
  const kickers = ranks.filter((r) => !groupRanks.has(r)); // 已按降序

  if (isStraight && isFlush) return { category: 8, ranks: [straightHigh] };
  if (four) return { category: 7, ranks: [four, ...kickers] };
  if (three && pairs.length >= 1) return { category: 6, ranks: [three, pairs[0]] };
  if (isFlush) return { category: 5, ranks };
  if (isStraight) return { category: 4, ranks: [straightHigh] };
  if (three) return { category: 3, ranks: [three, ...kickers] };
  if (pairs.length === 2) return { category: 2, ranks: [pairs[0], pairs[1], ...kickers] };
  if (pairs.length === 1) return { category: 1, ranks: [pairs[0], ...kickers] };
  return { category: 0, ranks };
}

// 生成从数组里取 k 个的所有组合
function combinations(arr, k) {
  const result = [];
  const n = arr.length;
  const idx = [];
  for (let i = 0; i < k; i++) idx.push(i);
  while (true) {
    result.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return result;
}

// 对 7 张牌（2 底牌 + 5 公共牌）选出最优 5 张，并保留组成牌型的牌面
function evaluate7WithCards(cards) {
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const r = evaluate5(combo);
    if (!best || compare(r, best) > 0) best = { ...r, cards: combo };
  }
  if (best) {
    const isStraight = best.category === 8 || best.category === 4;
    const straightHigh = best.ranks[0];
    const rankOrder = !isStraight
      ? best.ranks
      : straightHigh === 5
        ? [5, 4, 3, 2, 14]
        : [straightHigh, straightHigh - 1, straightHigh - 2, straightHigh - 3, straightHigh - 4];
    best.cards = best.cards.slice().sort((a, b) => rankOrder.indexOf(a.rank) - rankOrder.indexOf(b.rank));
  }
  return best;
}

// 保持原有返回结构，仅返回牌型比较所需字段
function evaluate7(cards) {
  const best = evaluate7WithCards(cards);
  return best ? { category: best.category, ranks: best.ranks } : null;
}

// a > b 返回正数，a < b 返回负数，相等返回 0
function compare(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.ranks.length, b.ranks.length);
  for (let i = 0; i < len; i++) {
    const x = a.ranks[i] || 0;
    const y = b.ranks[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 返回中文牌型描述
function describe(hand) {
  if (!hand) return '';
  const R = rankLabel;
  switch (hand.category) {
    case 8:
      return hand.ranks[0] === 14 ? '皇家同花顺' : `同花顺（${R(hand.ranks[0])}高）`;
    case 7:
      return `四条（${R(hand.ranks[0])}）`;
    case 6:
      return `葫芦（${R(hand.ranks[0])}带${R(hand.ranks[1])}）`;
    case 5:
      return `同花（${R(hand.ranks[0])}高）`;
    case 4:
      return `顺子（${R(hand.ranks[0])}高）`;
    case 3:
      return `三条（${R(hand.ranks[0])}）`;
    case 2:
      return `两对（${R(hand.ranks[0])}和${R(hand.ranks[1])}）`;
    case 1:
      return `一对（${R(hand.ranks[0])}）`;
    default:
      return `高牌（${R(hand.ranks[0])}）`;
  }
}

module.exports = {
  CATEGORY_NAMES,
  evaluate5,
  evaluate7,
  evaluate7WithCards,
  compare,
  describe,
  combinations,
};
