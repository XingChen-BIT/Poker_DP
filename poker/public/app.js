'use strict';

/* ===== 客户端逻辑 ===== */
const $ = (id) => document.getElementById(id);

const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_RED = { s: false, h: true, d: true, c: false };
const RANK_LABEL = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
const STREET_CN = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '亮牌' };

const socket = io();
let state = null;
let session = readSession();
let raiseAmount = 0;
let lastBoardLen = 0;
let lastHoleCount = 0;
let audioCtx = null;
let serverClockOffsetMs = 0;
let entryRequestPending = false;

function readSession() {
  try { return JSON.parse(localStorage.getItem('poker_session') || 'null'); }
  catch { return null; }
}
function saveSession(s) { localStorage.setItem('poker_session', JSON.stringify(s)); }
function clearSession() { localStorage.removeItem('poker_session'); }

/* ===== 声音（轻量提示音） ===== */
function beep(freq = 880, dur = 0.09, type = 'sine', gain = 0.04) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* 忽略音频错误 */ }
}
function playTurn() { beep(1046, 0.12, 'triangle'); }
function playWin() { beep(659, 0.12); setTimeout(() => beep(880, 0.16), 120); }

/* ===== 连接 ===== */
socket.on('connect', () => {
  if (session) {
    socket.emit('room:rejoin', session, (res) => {
      if (!res.ok) { clearSession(); session = null; showEntry(); }
    });
  } else {
    showEntry();
  }
});
socket.on('disconnect', () => { if (state) toast('连接断开，正在重连…'); });
socket.on('room:kicked', (data) => {
  clearSession();
  session = null;
  state = null;
  $('manage-modal').classList.add('hidden');
  showEntry();
  toast(data?.message || '你已被房主移出牌桌');
});

socket.on('state', (s) => {
  const prev = state;
  // 所有倒计时均以服务端时间为准，避免手机系统时间偏差或重复广播造成跳秒。
  if (Number.isFinite(s.serverNow)) serverClockOffsetMs = s.serverNow - Date.now();
  state = s;
  if (s.mySeat !== -1) {
    const prevActor = prev?.currentActorSeat;
    const isMyTurnNow = s.myActions && (prevActor !== s.currentActorSeat || !prev?.myActions);
    if (isMyTurnNow) playTurn();
  }
  startCountdownLoop();
  render();
});

/* ===== 入口 ===== */
function showEntry() {
  state = null;
  // 离开房间或被踢出时清理所有遮罩，避免旧弹窗覆盖入口页。
  ['modal', 'manage-modal', 'info-modal', 'confirm-modal'].forEach((id) => $(id)?.classList.add('hidden'));
  $('topbar').classList.add('hidden');
  $('screen-entry').classList.remove('hidden');
  $('screen-lobby').classList.add('hidden');
  $('screen-game').classList.add('hidden');
  if (!$('inp-nickname').value) $('inp-nickname').value = localStorage.getItem('poker_nickname') || '';
  setEntryPending(false);
}

function setEntryPending(pending) {
  entryRequestPending = pending;
  $('btn-create').disabled = pending;
  $('btn-join').disabled = pending;
}

function showScreen(name) {
  $('screen-entry').classList.add('hidden');
  $('screen-lobby').classList.add('hidden');
  $('screen-game').classList.add('hidden');
  $('topbar').classList.remove('hidden');
  $(name).classList.remove('hidden');
}

/* ===== 入口事件 ===== */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $('pane-create').classList.toggle('hidden', tab.dataset.tab !== 'create');
    $('pane-join').classList.toggle('hidden', tab.dataset.tab !== 'join');
  });
});

$('btn-create').addEventListener('click', () => {
  if (entryRequestPending) return;
  setEntryPending(true);
  const nickname = $('inp-nickname').value.trim() || '房主';
  localStorage.setItem('poker_nickname', nickname);
  socket.emit('room:create', {
    nickname,
    initialChips: $('inp-chips').value,
    smallBlind: $('inp-sb').value,
    bigBlind: $('inp-bb').value,
  }, (res) => {
    if (!res?.ok) { setEntryPending(false); return toast(res?.error || '创建失败，请重试'); }
    session = { code: res.code, playerId: res.playerId };
    saveSession(session);
  });
});

$('btn-join').addEventListener('click', () => {
  if (entryRequestPending) return;
  const nickname = $('inp-nickname').value.trim() || '玩家';
  const code = $('inp-code').value.trim().toUpperCase();
  if (code.length < 4) return toast('请输入房间码');
  setEntryPending(true);
  localStorage.setItem('poker_nickname', nickname);
  socket.emit('room:join', { nickname, code }, (res) => {
    if (!res?.ok) { setEntryPending(false); return toast(res?.error || '加入失败，请重试'); }
    session = { code: res.code, playerId: res.playerId };
    saveSession(session);
  });
});

/* ===== 大厅 ===== */
function renderLobby() {
  showScreen('screen-lobby');
  // 从游戏结束页回到原房间时，游戏结算弹窗必须同步关闭。
  $('modal').classList.add('hidden');
  $('lobby-code').textContent = state.code;
  $('lobby-count').textContent = state.players.length;
  $('topbar-code').textContent = `房间码 ${state.code}`;
  $('btn-terminate').classList.add('hidden');

  const me = state.players[state.mySeat];
  const isHost = me && me.id === state.hostId;
  $('btn-manage').classList.toggle('hidden', !isHost);
  if (!$('manage-modal').classList.contains('hidden')) renderManageMembers();

  $('lobby-players').innerHTML = state.players.map((p) => {
    const host = p.id === state.hostId;
    const you = p.seat === state.mySeat;
    return `<li class="player-item">
      <div class="player-avatar ${host ? 'host' : ''}">${escapeHtml(p.nickname[0] || '?')}</div>
      <div class="player-name">${escapeHtml(p.nickname)}${you ? '（你）' : ''}</div>
      ${host ? '<span class="badge-host">房主</span>' : ''}
      <div class="player-chip">${p.chips}</div>
    </li>`;
  }).join('');

  // 房主设置
  $('set-chips').value = state.settings.initialChips;
  $('set-sb').value = state.settings.smallBlind;
  $('set-bb').value = state.settings.bigBlind;
  $('set-chips').disabled = !isHost;
  $('set-sb').disabled = !isHost;
  $('set-bb').disabled = !isHost;
  $('settings-hint').classList.toggle('hidden', isHost);

  $('btn-start').classList.toggle('hidden', !isHost);
  $('btn-start').disabled = state.players.length < 2;
}

function bindLobbyEvents() {
  ['set-chips', 'set-sb', 'set-bb'].forEach((id) => {
    const el = $(id);
    if (el._bound) return;
    el._bound = true;
    el.addEventListener('change', () => {
      socket.emit('settings:update', {
        initialChips: $('set-chips').value,
        smallBlind: $('set-sb').value,
        bigBlind: $('set-bb').value,
      });
    });
  });
}

$('btn-start').addEventListener('click', () => socket.emit('room:start', {}, (res) => {
  if (res && !res.ok) toast(res.error);
}));

$('btn-copy').addEventListener('click', () => {
  const link = `${location.origin}${location.pathname}?join=${state.code}`;
  copyText(link);
  toast('邀请链接已复制，发给好友即可加入');
});

/* ===== 牌桌 ===== */
function render() {
  if (!state) return showEntry();
  if (state.mySeat === -1) return showEntry();
  if (state.status === 'lobby') return renderLobby();
  renderGame();
}

function renderGame() {
  showScreen('screen-game');
  bindLobbyEvents();

  // 顶栏
  $('topbar-status').textContent =
    state.status === 'playing'
      ? `第 ${state.handNumber} 手 · ${STREET_CN[state.street] || ''}`
      : state.status === 'gameOver' ? '游戏结束' : '本局结束';
  $('topbar-code').textContent = `房间码 ${state.code}`;

  const me = state.players[state.mySeat];
  const isHost = me && me.id === state.hostId;
  $('btn-terminate').classList.toggle('hidden', !isHost || state.status === 'lobby' || state.status === 'gameOver');
  $('btn-manage').classList.toggle('hidden', !isHost);
  if (!$('manage-modal').classList.contains('hidden')) renderManageMembers();

  renderSeats();
  renderBoard();
  renderDock();
  renderStreetActions();
  renderStats();
  renderModal();
  renderTicker();
}

function seatPositions(n) {
  const positions = [];
  for (let i = 0; i < n; i++) {
    const angle = Math.PI / 2 + (2 * Math.PI * i) / n;
    positions.push({ x: 50 + 44 * Math.cos(angle), y: 50 + 35 * Math.sin(angle) });
  }
  return positions;
}

function cardHTML(card, opts = {}) {
  if (!card) return '<div class="card slot-empty"></div>';
  const red = SUIT_RED[card.suit];
  const cls = ['card'];
  if (opts.small) cls.push('small');
  if (opts.deal) cls.push('deal');
  if (red) cls.push('red');
  return `<div class="${cls.join(' ')}">
    <span class="rank">${RANK_LABEL[card.rank]}</span>
    <span class="suit">${SUIT_SYMBOL[card.suit]}</span>
    <span class="rank bottom">${RANK_LABEL[card.rank]}</span>
  </div>`;
}

function backCardHTML(opts = {}) {
  const cls = ['card', 'back'];
  if (opts.small) cls.push('small');
  return `<div class="${cls.join(' ')}"></div>`;
}

function renderSeats() {
  // 离桌玩家仍保留在服务端本手牌记录中，但不占用可见 UI 位置。
  const visiblePlayers = state.players.filter((p) => !p.left);
  const n = visiblePlayers.length;
  if (!n) { $('seats').innerHTML = ''; return; }
  const positions = seatPositions(n);
  const myVisibleIndex = Math.max(0, visiblePlayers.findIndex((p) => p.seat === state.mySeat));
  $('seats').innerHTML = visiblePlayers.map((p, index) => {
    const slot = (index - myVisibleIndex + n) % n;
    const pos = positions[slot];
    const isMe = p.seat === state.mySeat;

    const turn = p.seat === state.currentActorSeat && state.status === 'playing';
    const folded = p.folded && state.street !== null;

    const tags = [];
    if (p.seat === state.dealerSeat && state.street !== null) tags.push('<span class="tag tag-dealer">D</span>');
    if (p.seat === state.smallBlindSeat && state.street !== null) tags.push('<span class="tag tag-sb">SB</span>');
    if (p.seat === state.bigBlindSeat && state.street !== null) tags.push('<span class="tag tag-bb">BB</span>');
    if (turn) tags.push('<span class="tag tag-action">行动中</span>');
    if (p.sittingOut) tags.push('<span class="tag tag-wait">旁观</span>');
    if (!p.connected) tags.push('<span class="tag tag-offline">离线</span>');

    const cards = seatCardsHTML(p);
    const bet = p.betThisRound > 0 ? `<div class="bet">下注 ${p.betThisRound}</div>` : '';
    const reveal = state.reveals && state.reveals[p.seat];
    const handTag = reveal ? `<div class="seat-hand">${escapeHtml(reveal.desc)}</div>` : '';
    const stateCls = p.sittingOut ? 'waiting' : folded ? 'folded' : p.busted ? 'folded' : '';
    const classes = ['seat', stateCls, turn ? 'turn' : '', isMe ? 'me' : ''].filter(Boolean).join(' ');

    return `<div class="${classes}" style="left:${pos.x}%;top:${pos.y}%">
      <div class="seat-body">
        <div class="seat-tags">${tags.join('')}</div>
        <div class="avatar">${escapeHtml(p.nickname[0] || '?')}</div>
        <div class="name">${escapeHtml(p.nickname)}${isMe ? '（你）' : ''}</div>
        <div class="chips">${p.chips}${p.allIn ? ' · 全下' : ''}</div>
      </div>
      <div class="seat-cards">${cards}</div>
      ${bet}
      ${handTag}
    </div>`;
  }).join('');
}

function seatCardsHTML(p) {
  if (p.hole && p.hole.length) {
    return p.hole.map((c) => cardHTML(c, { small: true })).join('');
  }
  if (p.holeCount === 2) {
    return backCardHTML({ small: true }) + backCardHTML({ small: true });
  }
  return '<div class="card small slot-empty"></div><div class="card small slot-empty"></div>';
}

function renderBoard() {
  const board = state.board || [];
  const animateFrom = lastBoardLen;
  const cards = [];
  for (let i = 0; i < 5; i++) {
    const c = board[i];
    if (c) cards.push(cardHTML(c, { deal: i >= animateFrom }));
    else cards.push('<div class="card slot-empty"></div>');
  }
  $('community').innerHTML = cards.join('');
  lastBoardLen = board.length;

  const potEl = $('pot');
  potEl.textContent = `底池 ${state.pot}`;
  potEl.classList.remove('flash');
  void potEl.offsetWidth; // 触发重绘以重播动画
  potEl.classList.add('flash');
}

function renderDock() {
  const me = state.players[state.mySeat];
  const inHand = state.street !== null && !me.busted;

  // 我的底牌
  let myCardsHTML = '';
  if (inHand && me.hole && me.hole.length) {
    const animate = lastHoleCount === 0;
    myCardsHTML = me.hole.map((c) => cardHTML(c, { deal: animate })).join('');
    lastHoleCount = me.hole.length;
  } else if (inHand && me.holeCount === 2) {
    myCardsHTML = backCardHTML() + backCardHTML();
  } else {
    myCardsHTML = '<div class="card slot-empty"></div><div class="card slot-empty"></div>';
  }
  if (me.folded) myCardsHTML = `<div class="card" style="opacity:.35">—</div>`.repeat(2);
  $('my-cards').innerHTML = myCardsHTML;

  const actionArea = $('action-area');
  if (state.myActions) {
    renderActions(state.myActions);
  } else {
    $('raise-panel').classList.add('hidden');
    const actor = state.players[state.currentActorSeat];
    let label = '';
    if (me.sittingOut) {
      label = '旁观中，本局结束后自动进入下一局';
    } else if (state.status === 'playing') {
      label = `等待 ${actor ? escapeHtml(actor.nickname) : '…'} 行动…`;
      if (actor && !actor.connected) label += '（已掉线，将自动操作）';
    } else if (state.status === 'handComplete') {
      label = '本局结束';
    }
    $('turn-label').textContent = label;
    $('action-buttons').innerHTML = '';
  }
}

function renderActions(acts) {
  const actor = state.players[state.currentActorSeat];
  $('turn-label').textContent = '轮到你行动';
  const btns = [];

  btns.push(`<button class="btn btn-fold" data-act="fold">Fold</button>`);
  if (acts.canCheck) btns.push(`<button class="btn btn-check" data-act="check">Check</button>`);
  if (acts.canCall) {
    const label = acts.callAmount < acts.toCall ? `All-in Call ${acts.callAmount}` : `Call ${acts.callAmount}`;
    btns.push(`<button class="btn btn-call" data-act="call">${label}</button>`);
  }
  if (acts.canAllin) btns.push(`<button class="btn btn-allin" data-act="allin">All-in ${acts.chips}</button>`);

  $('action-buttons').innerHTML = btns.join('');

  // 加注面板
  if (acts.canRaise) {
    if (raiseAmount < acts.minRaiseTo || raiseAmount > acts.maxRaiseTo) raiseAmount = acts.minRaiseTo;
    const me = state.players[state.mySeat];
    const hasOpponentRaise = state.lastRaiseSeat >= 0 &&
      state.lastRaiseSeat !== state.mySeat && state.lastRaiseTo > 0;
    const opponentRaiseDisabled = hasOpponentRaise ? '' : 'disabled';
    $('raise-panel').classList.remove('hidden');
    $('raise-panel').innerHTML = `
      <div class="raise-amount">
        <span class="raise-stat"><small>Pot</small><b>${state.pot}</b></span>
        <span class="raise-to">Raise to <b id="raise-val">${raiseAmount}</b></span>
        <span class="raise-stat raise-stat-right"><small>Invested</small><b>${me.totalCommitted}</b></span>
      </div>
      <div class="raise-quick">
        <button class="btn btn-ghost" data-quick="min">Min Raise</button>
        <button class="btn btn-ghost" data-quick="half">Half Pot</button>
        <button class="btn btn-ghost" data-quick="pot">Pot</button>
        <button class="btn btn-ghost" data-quick="raise2" ${opponentRaiseDisabled} title="对手上次加注到总额的2倍">2× Last Raise</button>
        <button class="btn btn-ghost" data-quick="raise3" ${opponentRaiseDisabled} title="对手上次加注到总额的3倍">3× Last Raise</button>
      </div>
      <div class="raise-input-row">
        <label for="raise-input">Amount</label>
        <input type="number" id="raise-input" inputmode="numeric" step="1" placeholder="输入金额"
               min="${acts.minRaiseTo}" max="${acts.maxRaiseTo}" value="${raiseAmount}" />
        <span class="raise-range-hint">大盲 ${state.settings.bigBlind} ~ ${acts.maxRaiseTo}</span>
      </div>
      <input type="range" id="raise-slider" min="${acts.minRaiseTo}" max="${acts.maxRaiseTo}" step="1" value="${raiseAmount}" />
      <div class="raise-actions">
        <button class="btn btn-raise" id="raise-confirm">Raise</button>
      </div>`;

    const slider = $('raise-slider');
    const input = $('raise-input');
    const valEl = $('raise-val');

    // 统一更新入口：把金额钳制到 [最小加注, 最大加注]，并同步 显示值/滑块/输入框
    const setRaise = (v, opts = {}) => {
      const n = Math.round(Number(v));
      raiseAmount = Number.isFinite(n)
        ? clamp(n, acts.minRaiseTo, acts.maxRaiseTo)
        : acts.minRaiseTo;
      valEl.textContent = raiseAmount;
      slider.value = raiseAmount;
      if (opts.updateInput !== false) input.value = raiseAmount;
      input.classList.remove('invalid');
    };

    const minValid = Math.max(state.settings.bigBlind, acts.minRaiseTo);
    const confirmRaise = () => {
      const raw = input.value.trim();
      const n = Math.round(Number(raw));
      if (raw === '' || !Number.isFinite(n) || n < minValid || n > acts.maxRaiseTo) {
        input.classList.add('invalid');
        toast('金额无效，请重新输入');
        return;
      }
      setRaise(n);
      socket.emit('action', { action: 'raise', amount: raiseAmount });
    };

    slider.addEventListener('input', () => setRaise(slider.value));

    input.addEventListener('input', () => {
      if (input.value === '') return; // 允许完全清空，占位提示「输入金额」
      const n = Number(input.value);
      if (Number.isFinite(n)) {
        // 仅更新显示值与滑块，不覆盖正在输入的文本
        const clamped = clamp(Math.round(n), acts.minRaiseTo, acts.maxRaiseTo);
        raiseAmount = clamped;
        valEl.textContent = clamped;
        slider.value = clamped;
        input.classList.remove('invalid');
      }
    });
    input.addEventListener('change', () => {
      if (input.value === '') return;
      setRaise(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmRaise();
      }
    });

    $('raise-panel').querySelectorAll('[data-quick]').forEach((b) => {
      b.addEventListener('click', () => {
        const pot = state.pot;
        const vals = {
          min: acts.minRaiseTo,
          half: clamp(Math.round(pot / 2), acts.minRaiseTo, acts.maxRaiseTo),
          pot: clamp(pot, acts.minRaiseTo, acts.maxRaiseTo),
          raise2: clamp(Math.round(state.lastRaiseTo * 2), acts.minRaiseTo, acts.maxRaiseTo),
          raise3: clamp(Math.round(state.lastRaiseTo * 3), acts.minRaiseTo, acts.maxRaiseTo),
        };
        setRaise(vals[b.dataset.quick]);
      });
    });
    $('raise-confirm').addEventListener('click', confirmRaise);
  } else {
    $('raise-panel').classList.add('hidden');
  }
}

function renderTicker() {
  const items = (state.log || []).slice(-2).map((l) => l.text);
  $('ticker').textContent = items.join('　·　');
}

function renderStreetActions() {
  const el = $('street-actions');
  const items = state.streetActions || [];
  if (!items.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  const label = `<span class="sa-label">本轮下注</span>`;
  const body = items
    .map((a) => `<span class="sa-item sa-${escapeHtml(a.action)}">${escapeHtml(a.text)}</span>`)
    .join('<span class="sa-sep">|</span>');
  el.innerHTML = label + body;
}

function formatK(n) {
  const k = n / 1000;
  const s = Number.isInteger(k) ? String(k) : k.toFixed(1);
  return `${s}k`;
}

// 筹码统计：每位玩家从系统提出的筹码总额（负数表示借出）
function renderStats() {
  const el = $('stats-panel');
  const rows = state.players
    .filter((p) => !p.left)
    .map((p) => `
      <div class="stats-row">
        <span class="stats-name">${escapeHtml(p.nickname)}</span>
        <span class="stats-val">-${formatK(p.withdrawn)}</span>
      </div>`).join('');
  el.innerHTML = `<div class="stats-head">筹码统计</div>${rows}`;
}

/* ===== 倒计时 ===== */
let countdownTimer = null;
function serverTimeNow() { return Date.now() + serverClockOffsetMs; }

function settlementDismissed() {
  if (!state || state.status !== 'handComplete') return true;
  if (state.settlementDismissAt && serverTimeNow() >= state.settlementDismissAt) return true;
  const required = state.nextHandRequiredSeats || state.showdownSeats || [];
  const ready = new Set(state.nextHandReadySeats || []);
  return required.length > 0 && required.every((seat) => ready.has(seat));
}

function startCountdownLoop() {
  if (countdownTimer) return;
  countdownTimer = setInterval(tickCountdown, 100);
}

function tickSettlementModal() {
  const settlementClock = $('modal')?.querySelector('.settlement-countdown');
  if (!settlementClock || !state?.settlementDismissAt) return;
  const modalRemain = Math.min(
    state.settlementDismissMs || Infinity,
    Math.max(0, state.settlementDismissAt - serverTimeNow()),
  );
  settlementClock.textContent = `${Math.ceil(modalRemain / 1000)}s`;
  if (settlementDismissed()) renderModal();
}

function tickCountdown() {
  if (!state || state.mySeat === -1) return;
  const el = $('countdown');
  if (!el) return;
  let deadline = null, total = 0, label = '';
  if (state.status === 'playing' && state.turnDeadline) {
    deadline = state.turnDeadline;
    total = state.turnTimeoutMs || 40000;
    const actor = state.players[state.currentActorSeat];
    label = state.myActions ? '轮到你行动' : `${actor ? actor.nickname : '玩家'} 行动中`;
  } else if (state.status === 'handComplete' && state.nextHandAt && state.nextHandMs) {
    deadline = state.nextHandAt;
    total = state.nextHandMs;
    label = state.endedByFold ? '本局结束，即将开始下一局' : '结算中，即将开始下一局';
  }
  if (!deadline) {
    el.classList.add('hidden');
    tickSettlementModal();
    return;
  }
  const remain = Math.min(total, Math.max(0, deadline - serverTimeNow()));
  const secs = Math.ceil(remain / 1000);
  const pct = total > 0 ? Math.max(0, Math.min(100, (remain / total) * 100)) : 0;
  el.classList.remove('hidden');
  el.classList.toggle('urgent', remain <= 10000);
  el.querySelector('.countdown-label').textContent = label;
  el.querySelector('.countdown-fill').style.width = pct + '%';
  el.querySelector('.countdown-secs').textContent = secs + 's';

  tickSettlementModal();
}

function renderModal() {
  const modal = $('modal');
  const banner = $('result-banner');
  const me = state.players[state.mySeat];
  const isHost = me && me.id === state.hostId;

  // 本小局结果在所有其他弹窗之前展示。
  if (state.status === 'handComplete') {
    const winnerSummary = state.winners.length
      ? state.winners.map((w) => `${escapeHtml(w.nickname)} 赢得 ${w.amount}`).join('，')
      : '本小局已结束';
    banner.classList.remove('hidden');
    banner.innerHTML = `<div class="banner-title">本小局结算</div><div class="banner-body">${winnerSummary}</div>`;

    if (!settlementDismissed()) {
      const readySeats = new Set(state.nextHandReadySeats || []);
      const winnerBySeat = new Map((state.winners || []).map((w) => [w.seat, w]));
      const showdownPlayers = (state.showdownSeats || [])
        .map((seat) => state.players[seat])
        .filter(Boolean)
        .sort((a, b) => a.seat - b.seat);

      let resultsHTML = '';
      if (showdownPlayers.length) {
        resultsHTML = showdownPlayers.map((p) => {
          const reveal = state.reveals[p.seat];
          const winner = winnerBySeat.get(p.seat);
          return `<div class="showdown-player${winner ? ' showdown-winner' : ''}">
            <div class="showdown-player-head">
              <span class="showdown-name">${escapeHtml(p.nickname)}</span>
              <span class="showdown-desc">${escapeHtml(reveal.desc)}${winner ? ` · 赢得 ${winner.amount}` : ''}</span>
            </div>
            <div class="showdown-card-row">
              <span class="showdown-label">玩家牌面</span>
              <div class="showdown-cards hole-cards">${reveal.hole.map((c) => cardHTML(c, { small: true })).join('')}</div>
            </div>
            <div class="showdown-card-row">
              <span class="showdown-label">最大牌型</span>
              <div class="showdown-cards">${reveal.bestFive.map((c) => cardHTML(c, { small: true })).join('')}</div>
            </div>
          </div>`;
        }).join('');
      } else if (state.winners.length) {
        const w = state.winners[0];
        resultsHTML = `<div class="winner-row"><span class="w-name">${escapeHtml(w.nickname)}</span><span class="w-desc">${escapeHtml(w.desc || '')}</span><span class="w-amount">+${w.amount}</span></div>`;
      }

      const meReady = readySeats.has(state.mySeat);
      const required = state.nextHandRequiredSeats || state.showdownSeats || [];
      const readyRequired = required.filter((seat) => readySeats.has(seat)).length;
      const readyHint = required.length
        ? `${readyRequired}/${required.length} 位本局玩家已确认`
        : '结算弹窗将在倒计时结束后关闭';
      const modalSecs = Math.ceil(Math.min(
        state.settlementDismissMs || Infinity,
        Math.max(0, state.settlementDismissAt - serverTimeNow()),
      ) / 1000);
      const canConfirm = required.includes(state.mySeat);
      const boardCards = [];
      for (let i = 0; i < 5; i++) {
        boardCards.push(state.board[i] ? cardHTML(state.board[i], { small: true }) : '<div class="card small slot-empty"></div>');
      }

      modal.classList.remove('hidden');
      modal.innerHTML = `<div class="modal-box settlement-modal">
        <div class="modal-title">本小局结算</div>
        <div class="settlement-board">
          <div class="settlement-board-title">本轮公共牌</div>
          <div class="settlement-board-cards">${boardCards.join('')}</div>
        </div>
        <div class="showdown-results">${resultsHTML}</div>
        <div class="settlement-ready-hint">${readyHint} · <span class="settlement-countdown">${modalSecs}s</span></div>
        <div class="modal-actions">
          <button class="btn btn-primary" id="btn-ready-next" ${meReady || !canConfirm ? 'disabled' : ''}>
            ${!canConfirm ? '等待本局玩家确认' : meReady ? '已确认，等待其他玩家' : '进入下一局'}
          </button>
        </div>
      </div>`;
      $('btn-ready-next')?.addEventListener('click', () => {
        socket.emit('room:ready-next', {}, (res) => { if (res && !res.ok) toast(res.error); });
      });
      return;
    }
  }

  // 结算弹窗关闭后，破产玩家可选择补充筹码 / 退出牌局。
  const needRebuy = me && !me.left && me.busted && me.chips <= 0 &&
    state.status === 'handComplete';
  if (needRebuy) {
    banner.classList.add('hidden');
    modal.classList.remove('hidden');
    modal.innerHTML = `<div class="modal-box">
      <div class="modal-title">筹码不足</div>
      <div class="modal-body">你的筹码已用完，可选择补充筹码继续游戏，或退出牌局。</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="btn-rebuy-exit">退出牌局</button>
        <button class="btn btn-primary" id="btn-rebuy">补充筹码 +${state.rebuyAmount}</button>
      </div>
    </div>`;
    $('btn-rebuy')?.addEventListener('click', () => {
      socket.emit('room:rebuy', {}, (res) => { if (res && !res.ok) toast(res.error); });
    });
    $('btn-rebuy-exit')?.addEventListener('click', () => leaveRoom());
    return;
  }

  // 本局结算弹窗已由在线玩家全员确认或 15 秒倒计时关闭，随后直接进入下一局。
  if (state.status === 'handComplete') {
    modal.classList.add('hidden');
    return;
  }

  if (state.status !== 'gameOver') { modal.classList.add('hidden'); banner.classList.add('hidden'); return; }

  // 游戏结束：最终排名结算界面
  banner.classList.add('hidden');
  let winnersHTML = '';
  if (state.finalRanking && state.finalRanking.length) {
    winnersHTML = `<div class="ranking-head">最终排名</div>` + state.finalRanking.map((r, i) => `
      <div class="winner-row">
        <span class="w-name">第${i + 1}名 · ${escapeHtml(r.nickname)}</span>
        <span class="w-desc">净收益 ${r.net >= 0 ? '+' : ''}${formatK(r.net)}</span>
      </div>`).join('');
  } else if (state.winnerOfGame) {
    winnersHTML = `<div class="winner-row"><span class="w-name">🏆 ${escapeHtml(state.winnerOfGame.nickname)}</span><span class="w-desc">赢得整场游戏</span></div>`;
  }

  let actions = isHost
    ? `<button class="btn btn-primary" id="btn-reset">留在原房间（再来一局）</button>`
    : `<button class="btn btn-primary" id="btn-stay-room">留在原房间（等待房主）</button>`;
  actions += `<button class="btn btn-ghost" id="btn-leave-room">退出房间，返回大厅</button>`;

  modal.classList.remove('hidden');
  modal.innerHTML = `<div class="modal-box">
    <div class="modal-title">游戏结束</div>
    <div class="modal-winners">${winnersHTML}</div>
    <div class="modal-actions">${actions}</div>
  </div>`;

  $('btn-reset')?.addEventListener('click', () => {
    // 先收起弹窗，再请求重置；成功广播后所有玩家都会回到原房间大厅。
    modal.classList.add('hidden');
    socket.emit('room:reset', {}, (res) => { if (res && !res.ok) toast(res.error); });
  });
  $('btn-stay-room')?.addEventListener('click', () => modal.classList.add('hidden'));
  $('btn-leave-room')?.addEventListener('click', () => {
    modal.classList.add('hidden');
    leaveRoom();
  });
  playWin();
}

/* ===== 全局事件（委托） ===== */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const act = btn.dataset.act;
    if (act === 'raise') return; // 由加注面板处理
    if (act === 'fold') {
      showConfirm('确定要弃牌吗？', () => {
        socket.emit('action', { action: 'fold' });
        $('raise-panel').classList.add('hidden');
      });
      return;
    }
    socket.emit('action', { action: act });
    $('raise-panel').classList.add('hidden');
  }
});

function confirmLeave() {
  let msg = '确定离开牌桌？你的座位将被释放。';
  if (state && state.status === 'playing') {
    msg = '确定离开牌桌？若本局未结束，你的手牌将自动弃牌，已投入底池的筹码不退还。';
  }
  showConfirm(msg, () => leaveRoom());
}
$('btn-leave').addEventListener('click', confirmLeave);

function renderManageMembers() {
  if (!state) return;
  const members = state.players.filter((p) => !p.left);
  $('manage-members').innerHTML = members.map((p) => {
    const isHost = p.id === state.hostId;
    const pending = p.pendingAdminChips > 0 ? `<span class="manage-pending">待到账 +${p.pendingAdminChips}</span>` : '';
    return `<div class="manage-member">
      <div class="manage-member-info">
        <strong>${escapeHtml(p.nickname)}${p.seat === state.mySeat ? '（你）' : ''}</strong>
        <span>现有筹码 ${formatK(p.chips)} ${pending}</span>
      </div>
      <button class="btn btn-ghost manage-add" data-manage-add="${escapeHtml(p.id)}" title="增加 500 筹码">＋ 500</button>
      ${isHost ? '<span class="badge-host">房主</span>' : `<button class="btn btn-danger manage-kick" data-manage-kick="${escapeHtml(p.id)}">踢出</button>`}
    </div>`;
  }).join('');
}

$('btn-manage').addEventListener('click', () => {
  renderManageMembers();
  $('manage-modal').classList.remove('hidden');
});
$('btn-manage-close').addEventListener('click', () => $('manage-modal').classList.add('hidden'));
$('manage-modal').addEventListener('click', (e) => {
  if (e.target === $('manage-modal')) $('manage-modal').classList.add('hidden');
  const addButton = e.target.closest('[data-manage-add]');
  if (addButton && !addButton.disabled) {
    addButton.disabled = true;
    socket.emit('room:grant-chips', { playerId: addButton.dataset.manageAdd }, (res) => {
      if (!res?.ok) { addButton.disabled = false; return toast(res?.error || '增加筹码失败'); }
      toast(res.queued ? '已登记 +500，本手结束后到账' : '已增加 500 筹码');
    });
    return;
  }
  const kickButton = e.target.closest('[data-manage-kick]');
  if (kickButton) {
    const player = state?.players.find((p) => p.id === kickButton.dataset.manageKick);
    showConfirm(`确定将 ${player?.nickname || '该成员'} 踢出牌桌吗？`, () => {
      kickButton.disabled = true;
      socket.emit('room:kick', { playerId: kickButton.dataset.manageKick }, (res) => {
        if (!res?.ok) { kickButton.disabled = false; toast(res?.error || '踢出失败'); }
      });
    });
  }
});

$('btn-terminate').addEventListener('click', () => {
  showConfirm('确定终止牌局，并对所有玩家进行最终排名结算吗？', () => {
    socket.emit('room:terminate', {}, (res) => { if (res && !res.ok) toast(res.error); });
  });
});

$('topbar-code').addEventListener('click', () => {
  if (!state) return;
  const link = `${location.origin}${location.pathname}?join=${state.code}`;
  copyText(link);
  toast(`房间码 ${state.code} 邀请链接已复制`);
});

$('btn-info').addEventListener('click', () => $('info-modal').classList.remove('hidden'));
$('btn-info-close').addEventListener('click', () => $('info-modal').classList.add('hidden'));
$('info-modal').addEventListener('click', (e) => {
  if (e.target === $('info-modal')) $('info-modal').classList.add('hidden');
});

$('dock-toggle').addEventListener('click', () => {
  const dock = $('dock');
  const collapsed = dock.classList.toggle('dock-collapsed');
  $('dock-toggle').textContent = collapsed ? '展开' : '收起';
});

// 通用确认弹窗
function showConfirm(message, onOk) {
  const modal = $('confirm-modal');
  $('confirm-body').textContent = message;
  modal.classList.remove('hidden');
  const close = (fn) => {
    modal.classList.add('hidden');
    if (fn) fn();
  };
  $('confirm-ok').onclick = () => close(onOk);
  $('confirm-cancel').onclick = () => close(null);
  modal.onclick = (e) => { if (e.target === modal) close(null); };
}

function leaveRoom() {
  // 无论从哪个弹窗触发退出，都先移除遮罩，再清理房间身份。
  ['modal', 'manage-modal', 'info-modal', 'confirm-modal'].forEach((id) => $(id)?.classList.add('hidden'));
  socket.emit('room:leave', {}, () => {});
  clearSession();
  session = null;
  state = null;
  showEntry();
}

/* ===== 工具 ===== */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

/* ===== URL 带 ?join=CODE 时自动切到加入页 ===== */
(function initJoinParam() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('join') || '').toUpperCase();
  if (code) {
    $('inp-code').value = code;
    document.querySelector('.tab[data-tab="join"]').click();
  }
})();

showEntry();
