'use strict';

// 牌桌核心逻辑：与网络无关，纯状态机，方便单元测试。
// 服务器（server.js）负责把玩家动作转交给本模块，并把结果广播出去。

const { newShuffledDeck, makeCard, rankLabel } = require('./cards');
const { evaluate7, evaluate7WithCards, compare, describe } = require('./evaluate');

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river', 'showdown'];

class Table {
  constructor({ code, hostId, settings, rng, turnTimeoutMs }) {
    this.code = code;
    this.hostId = hostId;
    this.rng = rng || Math.random;
    this.turnTimeoutMs = turnTimeoutMs || 40000;
    this.settings = {
      initialChips: Number(settings.initialChips) || 1000,
      smallBlind: Number(settings.smallBlind) || 5,
      bigBlind: Number(settings.bigBlind) || 10,
    };
    if (this.settings.initialChips <= 0) this.settings.initialChips = 1000;
    if (this.settings.smallBlind <= 0) this.settings.smallBlind = 5;
    if (this.settings.bigBlind <= this.settings.smallBlind) this.settings.bigBlind = this.settings.smallBlind * 2;

    this.players = []; // { id, nickname, seat, chips, ... }
    this.status = 'lobby'; // lobby | playing | handComplete | gameOver
    this.dealerSeat = 0;
    this.handNumber = 0;
    this.board = [];
    this.deck = [];
    this.street = null;
    this.currentBet = 0;
    this.minRaise = 0;
    this.currentActorSeat = -1;
    this.winners = []; // [{ seat, nickname, desc, amount }]
    this.reveals = {}; // seat -> { desc, hole, bestFive }（实际参与比牌者的亮牌结果）
    this.revealMode = false; // 是否进入真正比牌（弃牌赢家不亮牌）
    this.log = []; // 文字播报
    this.streetActions = []; // 本轮（当前下注轮次）下注记录条
    this.version = 0;
    this.winnerOfGame = null;
    this.finalRanking = null; // 终止牌局后的最终排名
    this.turnDeadline = null; // 当前行动者的操作倒计时截止时间（毫秒时间戳）
    this.nextHandAt = null; // 本局结束后自动进入下一局的时刻（毫秒时间戳）
    this.nextHandMs = 0; // 上述倒计时总时长
    this.settlementDismissAt = null; // 本小局结算弹窗最晚关闭时刻
    this.settlementDismissMs = 0; // 结算弹窗倒计时总时长
    this.nextHandReadySeats = []; // 已点击“进入下一局”的座位
    this.settlementParticipantSeats = []; // 本手实际拿到牌、需要确认结算的玩家座位
    this.endedByFold = false; // 本局是否因弃牌结束（用于结算提示）
  }

  // ---------------- 工具 ----------------

  count() {
    return this.players.length;
  }

  // 下一个未被淘汰（chips>0）且已入座的座位，从 seat 之后顺时针找
  nextOccupiedSeat(seat) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (seat + i) % n;
      if (!this.players[s].busted && !this.players[s].sittingOut && !this.players[s].left) return s;
    }
    return -1;
  }

  // 下一个需要行动的座位（pending），从 seat 之后找
  nextPendingSeat(seat) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (seat + i) % n;
      if (this.players[s].pending && !this.players[s].sittingOut && !this.players[s].left) return s;
    }
    return -1;
  }

  activeCount() {
    return this.players.filter((p) => !p.busted && !p.sittingOut && !p.left).length;
  }

  inHandCount() {
    return this.players.filter((p) => !p.folded && !p.busted && !p.sittingOut && !p.left).length;
  }

  totalPot() {
    return this.players.reduce((s, p) => s + p.totalCommitted, 0);
  }

  // 补充筹码金额 = 初始筹码 × 50%
  rebuyAmount() {
    return Math.round(this.settings.initialChips * 0.5);
  }

  // 设置当前行动者并刷新其操作倒计时截止时间
  setActor(seat) {
    this.currentActorSeat = seat;
    this.turnDeadline = seat >= 0 ? Date.now() + this.turnTimeoutMs : null;
  }

  // ---------------- 房间管理 ----------------

  addPlayer(id, nickname) {
    if (this.players.some((p) => p.id === id)) return this.players.find((p) => p.id === id);
    const nicknameClean = String(nickname || '玩家').slice(0, 12);
    // 仅在牌局进行中（发牌后、下注过程中）加入的玩家先旁观，等本局结束后自动进入下一局
    const sittingOut = this.status === 'playing';
    const makePlayer = (seat) => ({
      id,
      nickname: nicknameClean,
      seat,
      chips: this.settings.initialChips,
      connected: true,
      disconnectedAt: null,
      busted: false,
      sittingOut,
      left: false,
      withdrawn: this.settings.initialChips, // 从系统中提出的筹码总额（初始 + 历次补充）
      // 每手牌状态
      hole: [],
      folded: false,
      allIn: false,
      betThisRound: 0,
      totalCommitted: 0,
      actedThisRound: false,
      pending: false,
      lastAction: null,
      won: 0,
    });

    // 优先坐入有人离开后释放的空位
    const emptyIdx = this.players.findIndex((p) => p.left);
    if (emptyIdx !== -1) {
      this.players[emptyIdx] = makePlayer(emptyIdx);
      this.version++;
      return this.players[emptyIdx];
    }

    if (this.players.length >= MAX_PLAYERS) throw new Error('房间已满（最多 10 人）');
    const p = makePlayer(this.players.length);
    this.players.push(p);
    this.version++;
    return p;
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return;
    if (this.status !== 'lobby') {
      // 游戏进行中不真正移除，只标记掉线（供断线自动托管使用）
      this.players[idx].connected = false;
      this.version++;
      return;
    }
    this.players.splice(idx, 1);
    this.players.forEach((p, i) => (p.seat = i));
    this.version++;
  }

  // 玩家主动离开牌桌：立即释放座位（游戏进行中手中还有底牌则等同弃牌，已投入底池不退还）
  leaveTable(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const p = this.players[idx];

    if (this.status === 'lobby') {
      this.players.splice(idx, 1);
      this.players.forEach((pl, i) => (pl.seat = i));
      this.version++;
      return;
    }

    const wasInHand =
      this.status === 'playing' &&
      !p.folded && !p.busted && !p.sittingOut && !p.left &&
      p.hole.length > 0;

    if (wasInHand) {
      p.folded = true;
      p.lastAction = 'fold';
      p.pending = false;
      this.log.push({ text: `${p.nickname} 离开牌桌（弃牌）`, type: 'fold' });
      this.streetActions.push({ seat: p.seat, nickname: p.nickname, action: 'fold', amount: 0, text: `${p.nickname}: 离开（弃牌）` });
    }

    // 释放座位：清空剩余筹码、标记已离开，后续新玩家可坐入该空位
    p.left = true;
    p.connected = false;
    p.sittingOut = true;
    p.busted = true;
    p.pending = false;
    p.chips = 0;
    p.hole = [];

    if (wasInHand && this.status === 'playing') {
      if (this.inHandCount() === 1) {
        const winner = this.players.find((q) => !q.folded && !q.busted && !q.left);
        if (winner) this.finishByFold(winner);
      } else if (this.currentActorSeat === idx) {
        this.advanceAfterAction();
      }
    }
    this.version++;
  }

  setConnected(id, connected) {
    const p = this.players.find((p) => p.id === id);
    if (p) {
      p.connected = connected;
      p.disconnectedAt = connected ? null : Date.now();
      this.version++;
    }
  }

  // 补充筹码：仅限本局结束、等待下一局期间（handComplete），且已破产未离开的玩家
  rebuy(id) {
    const p = this.players.find((p) => p.id === id);
    if (!p || p.left) return false;
    if (this.status !== 'handComplete') return false;
    if (!p.busted && p.chips > 0) return false;
    const amt = this.rebuyAmount();
    p.chips += amt;
    p.withdrawn += amt;
    p.busted = false;
    p.sittingOut = false;
    this.log.push({ text: `${p.nickname} 补充筹码 +${amt}`, type: 'rebuy' });
    this.version++;
    return true;
  }

  // 计算所有在场玩家的净收益排名（净收益 = 当前筹码 - 从系统提出的筹码）
  computeFinalRanking() {
    this.finalRanking = this.players
      .filter((p) => !p.left)
      .map((p) => ({
        seat: p.seat,
        nickname: p.nickname,
        chips: p.chips,
        withdrawn: p.withdrawn,
        net: p.chips - p.withdrawn,
      }))
      .sort((a, b) => b.net - a.net);
    return this.finalRanking;
  }

  // 房主终止牌局：生成最终排名并进入结算
  terminate() {
    if (this.status === 'lobby') return false;
    this.computeFinalRanking();
    this.status = 'gameOver';
    this.turnDeadline = null;
    this.nextHandAt = null;
    this.settlementDismissAt = null;
    this.nextHandReadySeats = [];
    this.settlementParticipantSeats = [];
    this.winnerOfGame = this.finalRanking[0]
      ? { seat: this.finalRanking[0].seat, nickname: this.finalRanking[0].nickname }
      : null;
    this.version++;
    return true;
  }

  // 牌局结束后检查是否只剩一名在场玩家（此时直接终局）
  checkGameOver() {
    if (this.status !== 'handComplete') return;
    const present = this.players.filter((p) => !p.left);
    if (present.length <= 1) {
      this.computeFinalRanking();
      this.status = 'gameOver';
      this.turnDeadline = null;
      this.nextHandAt = null;
      this.settlementDismissAt = null;
      this.nextHandReadySeats = [];
      this.settlementParticipantSeats = [];
      this.winnerOfGame = present[0] ? { seat: present[0].seat, nickname: present[0].nickname } : null;
      this.version++;
    }
  }

  // ---------------- 开局 / 每手牌 ----------------

  startHand() {
    // 让上一局中途加入（旁观）的玩家自动入座，参与本局发牌（已离开的空位不参与）
    for (const p of this.players) {
      if (!p.left) p.sittingOut = false;
    }

    const alive = this.players.filter((p) => !p.busted && !p.left);
    if (alive.length < MIN_PLAYERS) {
      this.computeFinalRanking();
      this.status = 'gameOver';
      this.turnDeadline = null;
      this.winnerOfGame = alive[0] ? { seat: alive[0].seat, nickname: alive[0].nickname } : null;
      this.version++;
      return false;
    }

    this.handNumber++;
    this.board = [];
    this.winners = [];
    this.reveals = {};
    this.revealMode = false;
    this.log = [];
    this.streetActions = [];
    this.street = 'preflop';
    this.status = 'playing';
    this.nextHandAt = null;
    this.nextHandMs = 0;
    this.settlementDismissAt = null;
    this.settlementDismissMs = 0;
    this.nextHandReadySeats = [];
    this.settlementParticipantSeats = [];
    this.endedByFold = false;
    this.finalRanking = null;

    // 轮换庄家：第一手随机，之后顺时针移动到下一位未淘汰玩家
    if (this.handNumber === 1) {
      const aliveSeats = alive.map((p) => p.seat);
      this.dealerSeat = aliveSeats[Math.floor(this.rng() * aliveSeats.length)];
    } else {
      this.dealerSeat = this.nextOccupiedSeat(this.dealerSeat);
    }

    // 重置每手牌状态
    for (const p of this.players) {
      p.hole = [];
      p.folded = false;
      p.allIn = false;
      p.betThisRound = 0;
      p.totalCommitted = 0;
      p.actedThisRound = false;
      p.pending = false;
      p.lastAction = null;
      p.won = 0;
    }

    // 洗牌发牌
    this.deck = newShuffledDeck(this.rng);
    for (const p of alive) {
      p.hole.push(this.draw(), this.draw());
    }

    // 盲注
    const headsUp = alive.length === 2;
    let sbSeat, bbSeat, firstActor;
    if (headsUp) {
      sbSeat = this.dealerSeat; // 单挑：庄家下小盲
      bbSeat = this.nextOccupiedSeat(this.dealerSeat);
      firstActor = sbSeat; // 单挑：小盲（庄家）翻牌前先行动
    } else {
      sbSeat = this.nextOccupiedSeat(this.dealerSeat);
      bbSeat = this.nextOccupiedSeat(sbSeat);
      firstActor = this.nextOccupiedSeat(bbSeat); // 大盲下家（UTG）
    }

    const sb = this.players[sbSeat];
    const bb = this.players[bbSeat];
    const sbAmt = Math.min(this.settings.smallBlind, sb.chips);
    const bbAmt = Math.min(this.settings.bigBlind, bb.chips);
    this.commit(sbSeat, sbAmt, 'blind');
    this.commit(bbSeat, bbAmt, 'blind');
    this.log.push({
      text: `${sb.nickname} 下小盲注 ${sbAmt}，${bb.nickname} 下大盲注 ${bbAmt}`,
      type: 'blind',
    });
    this.streetActions.push({ seat: sbSeat, nickname: sb.nickname, action: 'smallblind', amount: sbAmt, text: `${sb.nickname}: 小盲 ${sbAmt}` });
    this.streetActions.push({ seat: bbSeat, nickname: bb.nickname, action: 'bigblind', amount: bbAmt, text: `${bb.nickname}: 大盲 ${bbAmt}` });

    this.currentBet = this.settings.bigBlind;
    this.minRaise = this.settings.bigBlind;
    for (const p of this.players) {
      p.actedThisRound = false;
      p.pending = !p.folded && !p.allIn && !p.busted && !p.sittingOut && !p.left;
    }
    this.setActor(this.nextPendingSeat((firstActor - 1 + this.players.length) % this.players.length));
    this.version++;
    this.maybeAutoRunOut();
    return true;
  }

  draw() {
    const card = this.deck.pop();
    if (card === undefined) throw new Error('牌堆已空');
    return makeCard(card);
  }

  commit(seat, amount, why) {
    const p = this.players[seat];
    if (amount <= 0) return;
    amount = Math.min(amount, p.chips);
    p.chips -= amount;
    p.betThisRound += amount;
    p.totalCommitted += amount;
    if (p.chips <= 0) p.allIn = true;
  }

  // 若开局后所有人都已 all-in，直接发完公共牌进比牌
  maybeAutoRunOut() {
    if (this.status !== 'playing') return;
    const canAct = this.players.filter((p) => !p.folded && !p.allIn && !p.busted && !p.sittingOut && !p.left);
    if (canAct.length === 0 && this.currentActorSeat === -1) {
      this.runOutBoard();
      this.showdown();
    }
  }

  // ---------------- 行动 ----------------

  availableActions(seat) {
    if (this.status !== 'playing' || this.currentActorSeat !== seat) return null;
    const p = this.players[seat];
    if (!p || p.folded || p.allIn || p.busted || p.sittingOut || p.left) return null;

    const toCall = Math.max(0, this.currentBet - p.betThisRound);
    const acts = {
      seat,
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount: Math.min(toCall, p.chips),
      canAllin: p.chips > 0,
      canRaise: false,
      minRaiseTo: 0,
      maxRaiseTo: p.betThisRound + p.chips,
      toCall,
      chips: p.chips,
    };
    if (p.chips > toCall) {
      const minRaiseTo = this.currentBet + this.minRaise;
      if (acts.maxRaiseTo >= minRaiseTo) {
        acts.canRaise = true;
        acts.minRaiseTo = minRaiseTo;
      }
    }
    return acts;
  }

  applyAction(seat, action, amount) {
    if (this.status !== 'playing') throw new Error('当前不在对局中');
    if (this.currentActorSeat !== seat) throw new Error('还没有轮到你行动');
    const p = this.players[seat];
    const acts = this.availableActions(seat);
    if (!acts) throw new Error('当前玩家无法行动');

    const toCall = acts.toCall;
    amount = Math.round(Number(amount) || 0);

    switch (action) {
      case 'fold': {
        p.folded = true;
        p.lastAction = 'fold';
        p.pending = false;
        this.log.push({ text: `${p.nickname} 弃牌`, type: 'fold' });
        this.streetActions.push({ seat, nickname: p.nickname, action: 'fold', amount: 0, text: `${p.nickname}: 弃牌` });
        break;
      }
      case 'check': {
        if (!acts.canCheck) throw new Error('当前不能过牌');
        p.lastAction = 'check';
        p.pending = false;
        this.log.push({ text: `${p.nickname} 过牌`, type: 'check' });
        this.streetActions.push({ seat, nickname: p.nickname, action: 'check', amount: 0, text: `${p.nickname}: 过牌` });
        break;
      }
      case 'call': {
        if (!acts.canCall) throw new Error('当前不能跟注');
        const amt = Math.min(toCall, p.chips);
        this.commit(seat, amt);
        p.lastAction = amt >= toCall ? 'call' : 'allin';
        p.pending = false;
        this.log.push({ text: `${p.nickname} 跟注 ${amt}`, type: 'call' });
        this.streetActions.push({ seat, nickname: p.nickname, action: 'call', amount: amt, text: `${p.nickname}: 跟注 ${amt}` });
        break;
      }
      case 'raise': {
        if (!acts.canRaise) throw new Error('当前不能加注');
        const raiseTo = Math.min(Math.max(amount, acts.minRaiseTo), acts.maxRaiseTo);
        const addAmount = raiseTo - p.betThisRound;
        if (addAmount <= toCall) throw new Error('加注目标必须大于当前下注');
        this.commit(seat, addAmount);
        p.lastAction = 'raise';
        const inc = p.betThisRound - this.currentBet;
        this.currentBet = p.betThisRound;
        this.minRaise = inc;
        for (const q of this.players) {
          if (q !== p && !q.folded && !q.allIn && !q.busted && !q.sittingOut && !q.left) q.pending = true;
        }
        p.pending = false;
        this.log.push({ text: `${p.nickname} 加注到 ${p.betThisRound}`, type: 'raise' });
        this.streetActions.push({ seat, nickname: p.nickname, action: 'raise', amount: p.betThisRound, text: `${p.nickname}: 加注 ${p.betThisRound}` });
        break;
      }
      case 'allin': {
        if (!acts.canAllin) throw new Error('当前不能全下');
        const amt = p.chips;
        this.commit(seat, amt);
        p.lastAction = 'allin';
        if (p.betThisRound > this.currentBet) {
          const inc = p.betThisRound - this.currentBet;
          this.currentBet = p.betThisRound;
          if (inc >= this.minRaise) this.minRaise = inc;
          for (const q of this.players) {
            if (q !== p && !q.folded && !q.allIn && !q.busted && !q.sittingOut && !q.left) q.pending = true;
          }
        }
        p.pending = false;
        this.log.push({ text: `${p.nickname} 全下 ${amt}`, type: 'allin' });
        this.streetActions.push({ seat, nickname: p.nickname, action: 'allin', amount: amt, text: `${p.nickname}: 全下 ${amt}` });
        break;
      }
      default:
        throw new Error('未知行动');
    }

    this.version++;

    // 弃牌后只剩一人 → 直接赢
    if (this.inHandCount() === 1) {
      const winner = this.players.find((q) => !q.folded && !q.busted && !q.sittingOut && !q.left);
      if (winner) this.finishByFold(winner);
      return;
    }

    this.advanceAfterAction();
  }

  advanceAfterAction() {
    if (this.status !== 'playing') return;
    const canAct = this.players.filter((p) => !p.folded && !p.allIn && !p.busted && !p.sittingOut && !p.left);
    if (canAct.length === 0) {
      this.runOutBoard();
      this.showdown();
      return;
    }
    const next = this.nextPendingSeat(this.currentActorSeat);
    if (next === -1) {
      this.endBettingRound();
    } else {
      this.setActor(next);
      this.version++;
    }
  }

  finishByFold(winner) {
    const total = this.totalPot();
    winner.chips += total;
    winner.won = total;
    this.winners = [{ seat: winner.seat, nickname: winner.nickname, desc: '其余玩家弃牌', amount: total }];
    this.log.push({ text: `${winner.nickname} 赢得底池 ${total}`, type: 'win' });
    this.street = 'showdown';
    this.endedByFold = true;
    this.turnDeadline = null;
    this.finishHand();
  }

  endBettingRound() {
    if (this.street === 'river') {
      this.showdown();
      return;
    }
    if (this.street === 'preflop') {
      this.board.push(this.draw(), this.draw(), this.draw());
      this.street = 'flop';
      this.log.push({ text: '翻牌', type: 'street' });
    } else if (this.street === 'flop') {
      this.board.push(this.draw());
      this.street = 'turn';
      this.log.push({ text: '转牌', type: 'street' });
    } else if (this.street === 'turn') {
      this.board.push(this.draw());
      this.street = 'river';
      this.log.push({ text: '河牌', type: 'street' });
    }

    // 进入新一轮下注：清空本轮下注记录条，仅显示当前轮次的下注情况
    this.streetActions = [];

    // 新一轮下注：重置每轮下注额，公共牌后由庄家左手第一位活跃玩家先行动
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    for (const p of this.players) {
      p.betThisRound = 0;
      p.actedThisRound = false;
      p.pending = !p.folded && !p.allIn && !p.busted && !p.sittingOut && !p.left;
    }
    const first = this.nextOccupiedSeat(this.dealerSeat);
    this.setActor(this.nextPendingSeat((first - 1 + this.players.length) % this.players.length));
    this.version++;
    this.maybeAutoRunOut();
  }

  runOutBoard() {
    const need = { preflop: 5, flop: 2, turn: 1, river: 0 }[this.street] || 0;
    for (let i = 0; i < need; i++) this.board.push(this.draw());
  }

  showdown() {
    this.street = 'showdown';
    this.revealMode = true;
    this.endedByFold = false;
    this.turnDeadline = null;
    this.runOutBoard();

    // 亮出所有未弃牌玩家的牌并记录牌型
    for (const p of this.players) {
      if (!p.folded && !p.busted && p.hole.length === 2) {
        const hand = evaluate7WithCards([...this.board, ...p.hole]);
        this.reveals[p.seat] = {
          desc: describe(hand),
          category: hand.category,
          hole: p.hole.slice(),
          bestFive: hand.cards.slice(),
        };
      }
    }

    this.computePotsAndDistribute();
    this.finishHand();
  }

  computePotsAndDistribute() {
    const contributors = this.players.filter((p) => p.totalCommitted > 0);
    if (contributors.length === 0) return;

    const levels = [...new Set(contributors.map((p) => p.totalCommitted))].sort((a, b) => a - b);
    let prev = 0;
    const pots = [];
    for (const level of levels) {
      let amount = 0;
      const eligible = [];
      for (const p of contributors) {
        const add = Math.max(0, Math.min(p.totalCommitted, level) - prev);
        amount += add;
        if (p.totalCommitted >= level && !p.folded) eligible.push(p.seat);
      }
      pots.push({ amount, eligible });
      prev = level;
    }

    const distFromDealer = (seat) => (seat - this.dealerSeat + this.players.length) % this.players.length;
    const wonBySeat = {};
    const winDescBySeat = {};

    for (const pot of pots) {
      if (pot.eligible.length === 0 || pot.amount === 0) continue;
      let best = null;
      let potWinners = [];
      for (const seat of pot.eligible) {
        const hand = evaluate7([...this.board, ...this.players[seat].hole]);
        if (!best || compare(hand, best) > 0) {
          best = hand;
          potWinners = [seat];
        } else if (compare(hand, best) === 0) {
          potWinners.push(seat);
        }
      }
      const share = Math.floor(pot.amount / potWinners.length);
      let remainder = pot.amount - share * potWinners.length;
      const ordered = potWinners.slice().sort((a, b) => distFromDealer(a) - distFromDealer(b));
      for (const seat of potWinners) {
        wonBySeat[seat] = (wonBySeat[seat] || 0) + share;
        winDescBySeat[seat] = describe(best);
      }
      // 余数筹码按位置（庄家左手起）逐个分配
      for (let i = 0; i < remainder; i++) {
        const seat = ordered[i % ordered.length];
        wonBySeat[seat] = (wonBySeat[seat] || 0) + 1;
      }
    }

    this.winners = Object.keys(wonBySeat).map((seat) => {
      const s = Number(seat);
      const p = this.players[s];
      p.chips += wonBySeat[s];
      p.won = wonBySeat[s];
      return {
        seat: s,
        nickname: p.nickname,
        desc: winDescBySeat[s] || this.reveals[s]?.desc || '',
        amount: wonBySeat[s],
      };
    });
    this.winners.sort((a, b) => b.amount - a.amount);
    for (const w of this.winners) {
      this.log.push({ text: `${w.nickname} 以「${w.desc}」赢得 ${w.amount}`, type: 'win' });
    }
  }

  finishHand() {
    this.status = 'handComplete';
    this.turnDeadline = null;
    this.settlementParticipantSeats = this.players
      .filter((p) => !p.left && p.hole.length === 2)
      .map((p) => p.seat);
    for (const p of this.players) {
      if (!p.busted && p.chips <= 0) p.busted = true;
    }
    // 破产玩家可补充筹码复活，因此仅当在场玩家只剩一人时才终局
    const present = this.players.filter((p) => !p.left);
    if (present.length <= 1) {
      this.computeFinalRanking();
      this.status = 'gameOver';
      this.nextHandAt = null;
      this.winnerOfGame = present[0] ? { seat: present[0].seat, nickname: present[0].nickname } : null;
    }
    this.version++;
  }

  nextHand() {
    if (this.status === 'gameOver') throw new Error('游戏已结束');
    if (this.status !== 'handComplete') throw new Error('当前手牌尚未结束');
    // 庄家轮换在 startHand() 内部完成（handNumber>1 时顺时针移动）
    this.startHand();
  }

  // 记录本手参与玩家的结算确认。
  markReadyForNext(id) {
    if (this.status !== 'handComplete') return false;
    const p = this.players.find((player) => player.id === id && !player.left);
    if (!p || !this.settlementParticipantSeats.includes(p.seat)) return false;
    if (!this.nextHandReadySeats.includes(p.seat)) {
      this.nextHandReadySeats.push(p.seat);
      this.version++;
    }
    return true;
  }

  allReadyForNext() {
    if (this.status !== 'handComplete') return false;
    const required = this.settlementParticipantSeats.filter((seat) => {
      const p = this.players[seat];
      return p && !p.left && p.connected;
    });
    return required.length > 0 && required.every((seat) => this.nextHandReadySeats.includes(seat));
  }

  resetToLobby() {
    // 回到大厅前，先移除已主动离开（释放座位）的玩家并重排座位
    this.players = this.players.filter((p) => !p.left);
    this.players.forEach((p, i) => (p.seat = i));

    this.status = 'lobby';
    this.handNumber = 0;
    this.board = [];
    this.winners = [];
    this.reveals = {};
    this.revealMode = false;
    this.log = [];
    this.streetActions = [];
    this.street = null;
    this.currentBet = 0;
    this.minRaise = 0;
    this.currentActorSeat = -1;
    this.winnerOfGame = null;
    this.finalRanking = null;
    this.turnDeadline = null;
    this.nextHandAt = null;
    this.nextHandMs = 0;
    this.settlementDismissAt = null;
    this.settlementDismissMs = 0;
    this.nextHandReadySeats = [];
    this.settlementParticipantSeats = [];
    this.endedByFold = false;
    for (const p of this.players) {
      p.chips = this.settings.initialChips;
      p.withdrawn = this.settings.initialChips;
      p.busted = false;
      p.sittingOut = false;
      p.hole = [];
      p.folded = false;
      p.allIn = false;
      p.betThisRound = 0;
      p.totalCommitted = 0;
      p.actedThisRound = false;
      p.pending = false;
      p.lastAction = null;
      p.won = 0;
    }
    this.version++;
  }

  // 供服务器在玩家超时未行动时自动执行（能过牌就过牌，否则弃牌）
  autoAction(seat) {
    if (this.status !== 'playing' || this.currentActorSeat !== seat) return false;
    const acts = this.availableActions(seat);
    if (!acts) return false;
    if (acts.canCheck) this.applyAction(seat, 'check');
    else this.applyAction(seat, 'fold');
    return true;
  }

  // ---------------- 视图 ----------------

  toPublicState(viewerId) {
    const mySeat = this.players.findIndex((p) => p.id === viewerId);
    const myActions =
      mySeat !== -1 && this.currentActorSeat === mySeat
        ? this.availableActions(mySeat)
        : null;

    return {
      code: this.code,
      hostId: this.hostId,
      status: this.status,
      street: this.street,
      handNumber: this.handNumber,
      settings: { ...this.settings },
      dealerSeat: this.dealerSeat,
      smallBlindSeat: this.computeBlindSeats().sb,
      bigBlindSeat: this.computeBlindSeats().bb,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      currentActorSeat: this.currentActorSeat,
      pot: this.totalPot(),
      board: this.board,
      winners: this.winners,
      reveals: this.reveals,
      winnerOfGame: this.winnerOfGame,
      finalRanking: this.finalRanking,
      log: this.log.slice(-30),
      streetActions: this.streetActions,
      turnDeadline: this.turnDeadline,
      turnTimeoutMs: this.turnTimeoutMs,
      nextHandAt: this.nextHandAt,
      nextHandMs: this.nextHandMs,
      settlementDismissAt: this.settlementDismissAt,
      settlementDismissMs: this.settlementDismissMs,
      nextHandReadySeats: this.nextHandReadySeats.slice(),
      nextHandRequiredSeats: this.settlementParticipantSeats.filter((seat) => {
        const p = this.players[seat];
        return p && !p.left && p.connected;
      }),
      showdownSeats: Object.keys(this.reveals).map(Number).sort((a, b) => a - b),
      endedByFold: this.endedByFold,
      rebuyAmount: this.rebuyAmount(),
      mySeat,
      myActions,
      serverNow: Date.now(),
      version: this.version,
      players: this.players.map((p) => {
        const isViewer = p.id === viewerId;
        const showHole = isViewer || (this.revealMode && !p.folded && !p.busted);
        return {
          seat: p.seat,
          id: p.id,
          nickname: p.nickname,
          chips: p.chips,
          connected: p.connected,
          busted: p.busted,
          sittingOut: p.sittingOut,
          left: p.left,
          withdrawn: p.withdrawn,
          folded: p.folded,
          allIn: p.allIn,
          lastAction: p.lastAction,
          holeCount: p.hole.length,
          hole: showHole ? p.hole : null,
          betThisRound: p.betThisRound,
          totalCommitted: p.totalCommitted,
          won: p.won,
        };
      }),
    };
  }

  computeBlindSeats() {
    if (this.players.length < 2) return { sb: -1, bb: -1 };
    const alive = this.players.filter((p) => !p.busted && !p.sittingOut && !p.left);
    if (alive.length < 2) return { sb: -1, bb: -1 };
    const headsUp = alive.length === 2;
    const sb = headsUp ? this.dealerSeat : this.nextOccupiedSeat(this.dealerSeat);
    const bb = this.nextOccupiedSeat(sb);
    return { sb, bb };
  }
}

module.exports = { Table, MAX_PLAYERS, MIN_PLAYERS };
