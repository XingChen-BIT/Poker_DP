'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table, MAX_PLAYERS } = require('./engine/table');

const PORT = process.env.PORT || 3000;
// ===== 时间配置（以后需要调整倒计时时，修改这里即可） =====
const TURN_TIMEOUT_MS = 40000; // 每位玩家行动限时（40 秒）
const NEXT_HAND_FOLD_MS = 15000; // 与结算弹窗同步，不再额外保留看牌阶段
const NEXT_HAND_SHOWDOWN_MS = 15000; // 与结算弹窗同步，不再额外保留看牌阶段
const SETTLEMENT_MODAL_MS = 15000; // 结算弹窗最长显示时间（15 秒）
const KICK_DISCONNECTED_MS = 3 * 60 * 1000; // 掉线超过 3 分钟自动踢出

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // 本地/公网都可能被访问，宽松配置
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map(); // code -> Table
const socketInfo = new Map(); // socket.id -> { code, playerId }
const playerSocket = new Map(); // `${code}:${playerId}` -> socket.id
const turnTimers = new Map(); // code -> timeout handle（行动倒计时）
const nextHandTimers = new Map(); // code -> timeout handle（结算后自动开局倒计时）
const settlementTimers = new Map(); // code -> timeout handle（结算弹窗 15 秒倒计时）

// 生成 6 位房间码（去掉易混淆字符）
function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function clampInt(v, min, max, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function getRoomOfSocket(socketId) {
  const info = socketInfo.get(socketId);
  if (!info) return null;
  const table = rooms.get(info.code);
  if (!table) return null;
  return { table, info };
}

function broadcast(table) {
  for (const p of table.players) {
    const sid = playerSocket.get(`${table.code}:${p.id}`);
    if (sid && io.sockets.sockets.get(sid)) {
      io.to(sid).emit('state', table.toPublicState(p.id));
    }
  }
}

function clearTimer(code) {
  const t = turnTimers.get(code);
  if (t) {
    clearTimeout(t);
    turnTimers.delete(code);
  }
}

function armTimer(code) {
  clearTimer(code);
  const table = rooms.get(code);
  if (!table) return;
  if (table.status !== 'playing' || table.currentActorSeat === -1) return;
  // 使用引擎记录的截止时间，避免中途广播（加入/离开）重置倒计时
  let delay = TURN_TIMEOUT_MS;
  if (table.turnDeadline) delay = Math.max(0, table.turnDeadline - Date.now());
  const t = setTimeout(() => {
    const tbl = rooms.get(code);
    if (!tbl || tbl.status !== 'playing' || tbl.currentActorSeat === -1) return;
    tbl.autoAction(tbl.currentActorSeat); // 能过牌就过牌，否则弃牌
    sync(code);
  }, delay);
  turnTimers.set(code, t);
}

function cancelNextHand(code) {
  const t = nextHandTimers.get(code);
  if (t) {
    clearTimeout(t);
    nextHandTimers.delete(code);
  }
  const settlementTimer = settlementTimers.get(code);
  if (settlementTimer) {
    clearTimeout(settlementTimer);
    settlementTimers.delete(code);
  }
  const table = rooms.get(code);
  if (table) {
    table.nextHandAt = null;
    table.nextHandMs = 0;
    table.settlementDismissAt = null;
    table.settlementDismissMs = 0;
    table.nextHandReadySeats = [];
  }
}

// 本局结束后的结算倒计时：未全员确认时，到点自动进入下一局。
function scheduleNextHand(code) {
  const table = rooms.get(code);
  if (!table || table.status !== 'handComplete') return;
  // 无论能否马上开下一手，都先启动 15 秒结算弹窗计时（破产玩家可能随后补充筹码）。
  if (!table.settlementDismissAt) {
    table.settlementDismissAt = Date.now() + SETTLEMENT_MODAL_MS;
    table.settlementDismissMs = SETTLEMENT_MODAL_MS;
    table.nextHandReadySeats = [];
    const settlementTimer = setTimeout(() => {
      settlementTimers.delete(code);
      const tbl = rooms.get(code);
      if (!tbl || tbl.status !== 'handComplete') return;
      tbl.settlementDismissAt = Date.now();
      broadcast(tbl);
    }, SETTLEMENT_MODAL_MS);
    settlementTimers.set(code, settlementTimer);
  }
  if (table.activeCount() < 2) return; // 等玩家补充筹码 / 新玩家加入
  if (table.nextHandAt) return; // 已在倒计时中，不受新玩家加入影响
  const delay = table.endedByFold ? NEXT_HAND_FOLD_MS : NEXT_HAND_SHOWDOWN_MS;
  const now = Date.now();
  table.nextHandAt = now + delay;
  table.nextHandMs = delay;
  const t = setTimeout(() => {
    nextHandTimers.delete(code);
    const tbl = rooms.get(code);
    if (!tbl || tbl.status !== 'handComplete') return;
    tbl.nextHandAt = null;
    try {
      tbl.nextHand();
    } catch (e) {
      return;
    }
    sync(code);
  }, delay);
  nextHandTimers.set(code, t);
}

// 本手所有仍在桌的参与者都确认后，立即取消剩余结算时间并发下一手。
function advanceIfEveryoneReady(code) {
  const table = rooms.get(code);
  if (!table || table.status !== 'handComplete' || !table.allReadyForNext()) return false;
  if (table.activeCount() < 2) return false;
  cancelNextHand(code);
  table.nextHand();
  return true;
}

function promoteHost(table, leavingPlayerId) {
  if (table.hostId !== leavingPlayerId) return;
  const candidates = table.players.filter((p) => p.id !== leavingPlayerId && !p.left);
  const next = candidates.find((p) => p.connected) || candidates[0];
  if (next) table.hostId = next.id;
}

function maybeDeleteRoom(code) {
  const table = rooms.get(code);
  if (!table) return;
  if (!table.players.some((p) => !p.left)) {
    clearTimer(code);
    cancelNextHand(code);
    rooms.delete(code);
  }
}

// 统一收尾：终局判定 → 全员确认快速开局 → 结算倒计时 → 广播 → 行动倒计时 → 房间回收
function sync(code) {
  const table = rooms.get(code);
  if (!table) return;
  table.checkGameOver();
  advanceIfEveryoneReady(code);
  scheduleNextHand(code);
  broadcast(table);
  armTimer(code);
  maybeDeleteRoom(code);
}

io.on('connection', (socket) => {
  socket.on('room:create', (data, cb) => {
    try {
      const nickname = String(data?.nickname || '').trim() || '房主';
      const settings = {
        initialChips: clampInt(data?.initialChips, 10, 100000, 1000),
        smallBlind: clampInt(data?.smallBlind, 1, 100000, 5),
        bigBlind: clampInt(data?.bigBlind, 2, 200000, 10),
      };
      if (settings.bigBlind < settings.smallBlind * 2) {
        settings.bigBlind = settings.smallBlind * 2;
      }
      const code = genCode();
      const playerId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
      const table = new Table({ code, hostId: playerId, settings, turnTimeoutMs: TURN_TIMEOUT_MS });
      table.addPlayer(playerId, nickname);
      rooms.set(code, table);
      socketInfo.set(socket.id, { code, playerId });
      playerSocket.set(`${code}:${playerId}`, socket.id);
      socket.join(code);
      broadcast(table);
      cb?.({ ok: true, code, playerId });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('room:join', (data, cb) => {
    try {
      const code = String(data?.code || '').trim().toUpperCase();
      const nickname = String(data?.nickname || '').trim() || '玩家';
      const table = rooms.get(code);
      if (!table) return cb?.({ ok: false, error: '房间不存在，请检查房间码' });
      const playerId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
      table.addPlayer(playerId, nickname);
      socketInfo.set(socket.id, { code, playerId });
      playerSocket.set(`${code}:${playerId}`, socket.id);
      socket.join(code);
      sync(code);
      cb?.({ ok: true, code, playerId });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // 断线/刷新后凭 playerId 重连
  socket.on('room:rejoin', (data, cb) => {
    try {
      const code = String(data?.code || '').trim().toUpperCase();
      const playerId = String(data?.playerId || '');
      const table = rooms.get(code);
      if (!table) return cb?.({ ok: false, error: '房间已不存在' });
      const player = table.players.find((p) => p.id === playerId);
      if (!player || player.left) return cb?.({ ok: false, error: '座位已释放，请重新加入' });
      socketInfo.set(socket.id, { code, playerId });
      playerSocket.set(`${code}:${playerId}`, socket.id);
      socket.join(code);
      table.setConnected(playerId, true);
      sync(code);
      cb?.({ ok: true, code, playerId });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('room:start', (data, cb) => {
    const r = getRoomOfSocket(socket.id);
    if (!r) return cb?.({ ok: false, error: '未加入房间' });
    const { table, info } = r;
    if (table.hostId !== info.playerId) return cb?.({ ok: false, error: '只有房主可以开始游戏' });
    if (table.activeCount() < 2) return cb?.({ ok: false, error: '至少需要 2 名玩家' });
    if (table.status !== 'lobby') return cb?.({ ok: false, error: '游戏已开始' });
    table.startHand();
    sync(table.code);
    cb?.({ ok: true });
  });

  const markReadyForNext = (data, cb) => {
    const r = getRoomOfSocket(socket.id);
    if (!r) return cb?.({ ok: false, error: '未加入房间' });
    const { table, info } = r;
    if (!table.markReadyForNext(info.playerId)) {
      return cb?.({ ok: false, error: '你不是本手参与玩家，或当前不能确认' });
    }
    const willAdvance = table.allReadyForNext() && table.activeCount() >= 2;
    sync(table.code);
    cb?.({ ok: true, advanced: willAdvance });
  };

  // room:next 保留为旧客户端兼容事件；新客户端使用语义更明确的 ready-next。
  socket.on('room:next', markReadyForNext);
  socket.on('room:ready-next', markReadyForNext);

  socket.on('room:reset', (data, cb) => {
    const r = getRoomOfSocket(socket.id);
    if (!r) return cb?.({ ok: false, error: '未加入房间' });
    const { table, info } = r;
    if (table.hostId !== info.playerId) return cb?.({ ok: false, error: '只有房主可以重置' });
    clearTimer(table.code);
    cancelNextHand(table.code);
    table.resetToLobby();
    broadcast(table);
    cb?.({ ok: true });
  });

  socket.on('room:terminate', (data, cb) => {
    const r = getRoomOfSocket(socket.id);
    if (!r) return cb?.({ ok: false, error: '未加入房间' });
    const { table, info } = r;
    if (table.hostId !== info.playerId) return cb?.({ ok: false, error: '只有房主可以终止牌局' });
    clearTimer(table.code);
    cancelNextHand(table.code);
    table.terminate();
    broadcast(table);
    cb?.({ ok: true });
  });

  socket.on('room:rebuy', (data, cb) => {
    const r = getRoomOfSocket(socket.id);
    if (!r) return cb?.({ ok: false, error: '未加入房间' });
    const { table, info } = r;
    const ok = table.rebuy(info.playerId);
    if (!ok) return cb?.({ ok: false, error: '当前无法补充筹码' });
    sync(table.code);
    cb?.({ ok: true });
  });

  socket.on('settings:update', (data, cb) => {
    const r = getRoomOfSocket(socket.id);
    if (!r) return cb?.({ ok: false, error: '未加入房间' });
    const { table, info } = r;
    if (table.hostId !== info.playerId) return cb?.({ ok: false, error: '只有房主可以修改设置' });
    if (table.status !== 'lobby') return cb?.({ ok: false, error: '游戏开始后不能修改设置' });
    const s = table.settings;
    if (data?.initialChips !== undefined) s.initialChips = clampInt(data.initialChips, 10, 100000, s.initialChips);
    if (data?.smallBlind !== undefined) s.smallBlind = clampInt(data.smallBlind, 1, 100000, s.smallBlind);
    if (data?.bigBlind !== undefined) s.bigBlind = clampInt(data.bigBlind, 2, 200000, s.bigBlind);
    if (s.bigBlind < s.smallBlind * 2) s.bigBlind = s.smallBlind * 2;
    // 开局前修改设置时，所有玩家筹码重置为新的初始筹码
    for (const p of table.players) {
      p.chips = s.initialChips;
      p.withdrawn = s.initialChips;
    }
    broadcast(table);
    cb?.({ ok: true });
  });

  socket.on('action', (data, cb) => {
    const r = getRoomOfSocket(socket.id);
    if (!r) return cb?.({ ok: false, error: '未加入房间' });
    const { table, info } = r;
    const player = table.players.find((p) => p.id === info.playerId);
    if (!player) return cb?.({ ok: false, error: '玩家不存在' });
    try {
      table.applyAction(player.seat, data?.action, data?.amount);
      sync(table.code);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('room:leave', (data, cb) => {
    const r = getRoomOfSocket(socket.id);
    if (!r) return cb?.({ ok: false, error: '未加入房间' });
    const { table, info } = r;
    promoteHost(table, info.playerId);
    table.leaveTable(info.playerId);
    playerSocket.delete(`${info.code}:${info.playerId}`);
    socketInfo.delete(socket.id);
    socket.leave(info.code);
    sync(table.code);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const info = socketInfo.get(socket.id);
    if (!info) return;
    socketInfo.delete(socket.id);
    const table = rooms.get(info.code);
    if (!table) return;
    // 仅当该玩家当前绑定的 socket 仍是本连接时才标记掉线，
    // 避免「刷新重连」时旧连接的 disconnect 误把刚重连的玩家标记为掉线
    const key = `${info.code}:${info.playerId}`;
    if (playerSocket.get(key) === socket.id) {
      playerSocket.delete(key);
      const player = table.players.find((p) => p.id === info.playerId);
      if (player) {
        table.setConnected(info.playerId, false);
        promoteHost(table, info.playerId);
        // 结算期间掉线者不再阻塞确认；重新走同步流程可立即检查是否已满足开下一手条件。
        sync(info.code);
      }
    }
    maybeDeleteRoom(info.code);
  });
});

// 定期扫描：掉线超过 5 分钟的玩家自动踢出牌局，释放座位
setInterval(() => {
  const now = Date.now();
  for (const [code, table] of rooms) {
    let changed = false;
    for (const p of table.players) {
      if (!p.left && !p.connected && p.disconnectedAt && now - p.disconnectedAt > KICK_DISCONNECTED_MS) {
        promoteHost(table, p.id);
        table.leaveTable(p.id);
        playerSocket.delete(`${code}:${p.id}`);
        changed = true;
      }
    }
    if (changed) sync(code);
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`德州扑克服务器已启动: http://localhost:${PORT}`);
});
