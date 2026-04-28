/**
 * bleedon-server.js
 * Bleedon Multiplayer WebSocket Server
 * Deploy on Render as a Web Service (Node.js)
 *
 * Local dev:  node bleedon-server.js
 * Port:       3001 (or process.env.PORT on Render)
 */

const { WebSocketServer, WebSocket } = require('ws');
const { randomBytes } = require('crypto');

const PORT = process.env.PORT || 3001;

// ═══════════════════════════════════════
// IN-MEMORY STORE
// ═══════════════════════════════════════
const rooms   = new Map(); // code → Room
const clients = new Map(); // ws  → Client

// ─── Types ───────────────────────────
// Client  { id, ws, name, roomCode }
// Room    { code, hostId, mode, maxPlayers, players[], state }
// Player  { id, name, ready }

// ═══════════════════════════════════════
// CODE GENERATOR
// ═══════════════════════════════════════
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  while (code.length < 6) {
    code += chars[randomBytes(1)[0] % chars.length];
  }
  return rooms.has(code) ? genCode() : code; // ensure unique
}

function genId() {
  return randomBytes(8).toString('hex');
}

// ═══════════════════════════════════════
// SERVER
// ═══════════════════════════════════════
const wss = new WebSocketServer({ port: PORT });
console.log(`[Bleedon] Server listening on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  const id = genId();
  clients.set(ws, { id, ws, name: null, roomCode: null });

  // Welcome
  send(ws, 'welcome', { id });
  console.log(`[+] Client connected: ${id}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error(`[!] WS error for ${id}:`, err.message);
  });
});

// ═══════════════════════════════════════
// MESSAGE ROUTER
// ═══════════════════════════════════════
function handleMessage(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;

  switch (msg.type) {

    // ── Create Room ──────────────────
    case 'create_room': {
      const { name, mode, maxPlayers } = msg;

      // Validate
      if (!name || typeof name !== 'string') return sendErr(ws, 'Invalid name');
      if (!['coop','pvp'].includes(mode)) return sendErr(ws, 'Invalid mode');
      if (![2,3,4].includes(Number(maxPlayers))) return sendErr(ws, 'Invalid player count');

      // Leave any existing room
      if (client.roomCode) leaveRoom(ws, client);

      const code = genCode();
      const player = { id: client.id, name: sanitize(name), ready: false };

      const room = {
        code,
        hostId: client.id,
        mode,
        maxPlayers: Number(maxPlayers),
        players: [player],
        state: 'lobby',   // lobby | ingame | ended
        createdAt: Date.now(),
      };

      rooms.set(code, room);
      client.name = player.name;
      client.roomCode = code;

      send(ws, 'room_created', { code, room: safeRoom(room) });
      console.log(`[R] Room created: ${code} mode=${mode} max=${maxPlayers} host=${client.id}`);
      break;
    }

    // ── Join Room ────────────────────
    case 'join_room': {
      const { code, name } = msg;
      if (!code || typeof code !== 'string') return sendErr(ws, 'Invalid code');

      const room = rooms.get(code.toUpperCase());
      if (!room) return sendErr(ws, 'Room not found — check the code');
      if (room.state !== 'lobby') return sendErr(ws, 'Game already started');
      if (room.players.length >= room.maxPlayers) return sendErr(ws, 'Room is full');

      // Leave existing
      if (client.roomCode) leaveRoom(ws, client);

      const player = { id: client.id, name: sanitize(name || 'Admin'), ready: false };
      room.players.push(player);
      client.name = player.name;
      client.roomCode = code.toUpperCase();

      send(ws, 'room_joined', { code: room.code, room: safeRoom(room) });

      // Notify others
      broadcast(room, 'player_joined', { id: client.id, name: player.name }, ws);
      broadcast(room, 'room_updated', { room: safeRoom(room) });
      console.log(`[R] ${player.name} joined room ${code}`);
      break;
    }

    // ── Player Ready ─────────────────
    case 'player_ready': {
      const room = getClientRoom(client);
      if (!room) return;

      const player = room.players.find(p => p.id === client.id);
      if (player) player.ready = msg.ready;

      // Broadcast updated room
      broadcast(room, 'room_updated', { room: safeRoom(room) });
      broadcast(room, 'player_ready', { id: client.id, name: client.name, ready: msg.ready });

      // Check if all ready
      const allReady = room.players.length >= 2 && room.players.every(p => p.ready);
      if (allReady) {
        broadcast(room, 'all_ready', {});
      }
      break;
    }

    // ── Start Game ───────────────────
    case 'start_game': {
      const room = getClientRoom(client);
      if (!room) return;
      if (room.hostId !== client.id) return sendErr(ws, 'Only the host can start');
      if (room.players.length < 2) return sendErr(ws, 'Need at least 2 players');

      const allReady = room.players.every(p => p.ready);
      if (!allReady) return sendErr(ws, 'Not all players are ready');

      room.state = 'ingame';
      broadcast(room, 'game_start', {
        mode: room.mode,
        players: room.players.map(p => ({ id: p.id, name: p.name })),
        code: room.code,
      });
      console.log(`[G] Game started: ${room.code} mode=${room.mode} players=${room.players.length}`);
      break;
    }

    // ── Rejoin Game (after redirect from lobby) ───
    case 'rejoin_game': {
      const { room: rCode, id: claimId, name } = msg;
      // Trust claimed ID — in production validate against session token
      client.id   = claimId || client.id;
      client.name = sanitize(name || client.name || 'Admin');

      const room = rooms.get(rCode);
      if (!room) {
        // Room may have been cleaned up — create ephemeral record
        send(ws, 'error', { message: 'Room not found. It may have expired.' });
        return;
      }

      // Re-add player if not already in list
      if (!room.players.find(p => p.id === client.id)) {
        room.players.push({ id: client.id, name: client.name, ready: true });
      }
      client.roomCode = rCode;

      // Tell everyone this player is back
      broadcast(room, 'player_joined', { id: client.id, name: client.name });
      send(ws, 'room_joined', { code: room.code, room: safeRoom(room) });
      console.log(`[R] ${client.name} rejoined game room ${rCode}`);
      break;
    }

    // ── Leave Room ───────────────────
    case 'leave_room': {
      leaveRoom(ws, client);
      break;
    }

    // ── Pong (keepalive) ─────────────
    case 'pong': {
      // received, no action needed
      break;
    }

    // ── In-Game Events (relay) ───────
    case 'game_event': {
      // Relay game events between players (attacks, state updates)
      const room = getClientRoom(client);
      if (!room || room.state !== 'ingame') return;
      // Broadcast to all OTHER players in room
      broadcast(room, 'game_event', {
        from: client.id,
        fromName: client.name,
        event: msg.event,
        data: msg.data,
      }, ws);
      break;
    }

    default:
      console.log(`[?] Unknown message type: ${msg.type}`);
  }
}

// ═══════════════════════════════════════
// DISCONNECT HANDLER
// ═══════════════════════════════════════
function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client) return;

  leaveRoom(ws, client);
  clients.delete(ws);
  console.log(`[-] Client disconnected: ${client.id}`);
}

// ═══════════════════════════════════════
// LEAVE ROOM LOGIC
// ═══════════════════════════════════════
function leaveRoom(ws, client) {
  if (!client.roomCode) return;

  const room = rooms.get(client.roomCode);
  if (!room) { client.roomCode = null; return; }

  // Remove player
  room.players = room.players.filter(p => p.id !== client.id);
  const wasHost = room.hostId === client.id;

  broadcast(room, 'player_left', { id: client.id, name: client.name });

  if (room.players.length === 0) {
    // Empty room — delete it
    rooms.delete(room.code);
    console.log(`[R] Room ${room.code} deleted (empty)`);
  } else {
    // If host left, assign new host
    if (wasHost) {
      room.hostId = room.players[0].id;
      broadcast(room, 'host_changed', { id: room.hostId });
    }
    broadcast(room, 'room_updated', { room: safeRoom(room) });
  }

  client.roomCode = null;
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function getClientRoom(client) {
  return client.roomCode ? rooms.get(client.roomCode) : null;
}

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function sendErr(ws, message) {
  send(ws, 'error', { message });
}

function broadcast(room, type, payload = {}, excludeWs = null) {
  room.players.forEach(player => {
    // Find ws for this player id
    for (const [ws, client] of clients.entries()) {
      if (client.id === player.id && ws !== excludeWs) {
        send(ws, type, payload);
        break;
      }
    }
  });
}

// Strip internal data before sending room to clients
function safeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    players: room.players,
    state: room.state,
  };
}

function sanitize(str) {
  return String(str).replace(/[<>&"']/g, '').trim().slice(0, 20);
}

// ═══════════════════════════════════════
// KEEPALIVE PING (every 30s)
// ═══════════════════════════════════════
setInterval(() => {
  for (const [ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      clients.delete(ws);
    }
  }
}, 30000);

// ═══════════════════════════════════════
// STALE ROOM CLEANUP (every 10 min)
// ═══════════════════════════════════════
setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 60; // 1 hour
  for (const [code, room] of rooms.entries()) {
    if (room.createdAt < cutoff) {
      rooms.delete(code);
      console.log(`[R] Stale room cleaned: ${code}`);
    }
  }
}, 1000 * 60 * 10);

// ═══════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════
process.on('SIGTERM', () => {
  console.log('[Bleedon] Shutting down...');
  wss.close(() => process.exit(0));
});