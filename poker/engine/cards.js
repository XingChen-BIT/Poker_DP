'use strict';

// 一副 52 张牌，用整数 0..51 表示。
// suit = floor(i / 13)，rank = (i % 13) + 2（2..14，14 为 A）

const SUITS = ['s', 'h', 'd', 'c']; // 黑桃、红桃、方块、梅花

const SUIT_SYMBOL = {
  s: '♠', // ♠
  h: '♥', // ♥
  d: '♦', // ♦
  c: '♣', // ♣
};

const SUIT_NAME = {
  s: '黑桃',
  h: '红桃',
  d: '方块',
  c: '梅花',
};

// 红桃/方块为红色
const SUIT_IS_RED = { s: false, h: true, d: true, c: false };

const RANK_LABEL = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

function makeCard(i) {
  const suit = SUITS[Math.floor(i / 13)];
  const rank = (i % 13) + 2;
  return { rank, suit };
}

function cardKey(card) {
  return card.suit + card.rank;
}

function rankLabel(rank) {
  return RANK_LABEL[rank] || String(rank);
}

// 洗牌并返回新牌堆（整数数组 0..51 的随机排列）
function newShuffledDeck(rng = Math.random) {
  const deck = [];
  for (let i = 0; i < 52; i++) deck.push(i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

module.exports = {
  SUITS,
  SUIT_SYMBOL,
  SUIT_NAME,
  SUIT_IS_RED,
  RANK_LABEL,
  makeCard,
  cardKey,
  rankLabel,
  newShuffledDeck,
};
