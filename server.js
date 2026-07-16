import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 8080);
const defaultOrigins = [
  "https://riftline-ascendant.prime-clock-7617.chatgpt.site",
  "https://solo-lane-duel.prime-clock-7617.chatgpt.site",
];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || defaultOrigins.join(","))
  .split(",")
  .map((item) => item.trim().replace(/\/$/, ""))
  .filter(Boolean);
const championIds = new Set([
  "warden", "ranger", "mage", "duelist", "frost", "rift", "siphon", "bruiser",
  "fox", "demon", "beast", "hexer", "prism", "striker", "marshal", "arcblade", "dragon", "gale",
]);
const rooms = new Map();
const clients = new WeakMap();

const server = createServer((request, response) => {
  if (request.url === "/health") {
    const players = Array.from(rooms.values()).reduce(
      (total, room) => total + (room.protocol === 2 ? room.players.size : 1 + Number(Boolean(room.guest))),
      0,
    );
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, players, protocol: 2 }));
    return;
  }
  response.writeHead(404).end();
});

function originAllowed(origin) {
  if (!origin || allowedOrigins.includes("*")) return true;
  return allowedOrigins.includes(origin.replace(/\/$/, ""));
}

const wss = new WebSocketServer({
  server,
  maxPayload: 128 * 1024,
  verifyClient: ({ origin }) => originAllowed(origin),
});

function createCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  do {
    value = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(value));
  return value;
}

function send(socket, payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(room, payload, except) {
  if (room.protocol === 1) {
    for (const socket of [room.host, room.guest]) {
      if (socket && socket !== except) send(socket, payload);
    }
    return;
  }
  for (const player of room.players.values()) {
    if (player.socket !== except) send(player.socket, payload);
  }
}

function publicPlayer(player) {
  return {
    id: player.id,
    champion: player.champion,
    team: player.team,
    slot: player.slot,
    ready: player.ready,
    isHost: player.isHost,
    label: `플레이어 ${player.order}`,
  };
}

function roomCapacity(room) {
  return room.mode === "2v2" ? 4 : 2;
}

function teamCapacity(room) {
  return room.mode === "2v2" ? 2 : 1;
}

function startValidation(room) {
  const players = Array.from(room.players.values());
  const perTeam = teamCapacity(room);
  const blue = players.filter((player) => player.team === "blue");
  const red = players.filter((player) => player.team === "red");
  if (players.length !== roomCapacity(room)) return { ok: false, message: "필요한 인원이 모두 입장하지 않았습니다." };
  if (blue.length !== perTeam || red.length !== perTeam) return { ok: false, message: "파란 팀과 빨간 팀 인원을 맞춰 주세요." };
  if (players.some((player) => !player.ready)) return { ok: false, message: "모든 플레이어가 준비해야 합니다." };
  return { ok: true, message: "" };
}

function lobbyState(room) {
  return {
    type: "lobby_state",
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    players: Array.from(room.players.values()).sort((a, b) => a.order - b.order).map(publicPlayer),
    canStart: startValidation(room).ok,
  };
}

function broadcastLobby(room) {
  room.updatedAt = Date.now();
  broadcast(room, lobbyState(room));
}

function validChampion(value) {
  return typeof value === "string" && championIds.has(value);
}

function sameTeamChampion(room, player, team, champion = player.champion) {
  return Array.from(room.players.values()).some(
    (candidate) => candidate.id !== player.id && candidate.team === team && candidate.champion === champion,
  );
}

function addV2Player(room, socket, champion, isHost) {
  const player = {
    id: randomUUID(),
    socket,
    champion,
    team: room.mode === "1v1" ? (isHost ? "blue" : "red") : null,
    slot: null,
    ready: false,
    isHost,
    order: room.nextOrder++,
    rateWindowAt: Date.now(),
    rateCount: 0,
  };
  room.players.set(player.id, player);
  if (isHost) room.hostId = player.id;
  clients.set(socket, { code: room.code, protocol: 2, playerId: player.id });
  return player;
}

function allowRelay(player) {
  const now = Date.now();
  if (now - player.rateWindowAt >= 1000) {
    player.rateWindowAt = now;
    player.rateCount = 0;
  }
  player.rateCount += 1;
  return player.rateCount <= 120;
}

function finishRoom(room, leavingPlayer, reason = "left") {
  broadcast(room, {
    type: "player_left",
    playerId: leavingPlayer?.id ?? null,
    team: leavingPlayer?.team ?? null,
    reason,
  }, leavingPlayer?.socket);
  rooms.delete(room.code);
  for (const player of room.players.values()) clients.delete(player.socket);
}

function leaveLegacy(socket, info, room) {
  const peer = info.role === "host" ? room.guest : room.host;
  send(peer, { type: "peer_left" });
  rooms.delete(info.code);
  clients.delete(socket);
}

function leave(socket, reason = "left") {
  const info = clients.get(socket);
  if (!info) return;
  const room = rooms.get(info.code);
  clients.delete(socket);
  if (!room) return;
  if (room.protocol === 1) {
    leaveLegacy(socket, info, room);
    return;
  }
  const player = room.players.get(info.playerId);
  if (!player) return;
  if (room.phase === "playing") {
    finishRoom(room, player, reason);
    return;
  }
  room.players.delete(player.id);
  if (player.isHost) {
    broadcast(room, { type: "room_closed", message: "방장이 방을 나갔습니다." });
    rooms.delete(room.code);
    for (const remaining of room.players.values()) clients.delete(remaining.socket);
  } else {
    broadcastLobby(room);
  }
}

function handleLegacyCreate(socket, data) {
  const roomCode = createCode();
  rooms.set(roomCode, {
    protocol: 1,
    code: roomCode,
    host: socket,
    guest: null,
    hostChampion: data.champion,
    guestChampion: null,
    createdAt: Date.now(),
  });
  clients.set(socket, { code: roomCode, protocol: 1, role: "host" });
  send(socket, { type: "created", code: roomCode });
}

function handleCreate(socket, data) {
  if (data.protocol !== 2) return handleLegacyCreate(socket, data);
  if (!validChampion(data.champion)) return send(socket, { type: "error", message: "올바르지 않은 챔피언입니다." });
  const mode = data.mode === "2v2" ? "2v2" : "1v1";
  const roomCode = createCode();
  const room = {
    protocol: 2,
    code: roomCode,
    mode,
    phase: "lobby",
    hostId: "",
    players: new Map(),
    nextOrder: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rooms.set(roomCode, room);
  const player = addV2Player(room, socket, data.champion, true);
  send(socket, { type: "created", code: roomCode, playerId: player.id, mode, role: "host", protocol: 2 });
  broadcastLobby(room);
}

function handleJoin(socket, data) {
  const roomCode = String(data.code || "").trim().toUpperCase();
  const room = rooms.get(roomCode);
  if (!room) return send(socket, { type: "error", message: "존재하지 않거나 종료된 방입니다." });
  if (room.protocol === 1) {
    if (room.guest) return send(socket, { type: "error", message: "참가할 수 없는 방입니다." });
    room.guest = socket;
    room.guestChampion = data.champion;
    clients.set(socket, { code: roomCode, protocol: 1, role: "guest" });
    send(socket, { type: "joined", code: roomCode });
    send(room.host, { type: "ready", opponentChampion: room.guestChampion });
    send(room.guest, { type: "ready", opponentChampion: room.hostChampion });
    return;
  }
  if (data.protocol !== 2) return send(socket, { type: "error", message: "게임을 새로고침한 뒤 다시 참가해 주세요." });
  if (!validChampion(data.champion)) return send(socket, { type: "error", message: "올바르지 않은 챔피언입니다." });
  if (room.phase !== "lobby" || room.players.size >= roomCapacity(room)) {
    return send(socket, { type: "error", message: "이미 시작했거나 정원이 찬 방입니다." });
  }
  const player = addV2Player(room, socket, data.champion, false);
  send(socket, { type: "joined", code: roomCode, playerId: player.id, mode: room.mode, role: "guest", protocol: 2 });
  broadcastLobby(room);
}

function handleV2Message(socket, data, info, room) {
  const player = room.players.get(info.playerId);
  if (!player) return;
  if (data.type === "choose_team") {
    if (room.phase !== "lobby" || room.mode !== "2v2") return;
    const team = data.team === "blue" || data.team === "red" ? data.team : null;
    if (team) {
      const count = Array.from(room.players.values()).filter((candidate) => candidate.id !== player.id && candidate.team === team).length;
      if (count >= teamCapacity(room)) return send(socket, { type: "error", message: "선택한 팀의 자리가 모두 찼습니다." });
      if (sameTeamChampion(room, player, team)) return send(socket, { type: "error", message: "같은 팀에서는 같은 챔피언을 중복 선택할 수 없습니다." });
    }
    player.team = team;
    player.slot = null;
    player.ready = false;
    broadcastLobby(room);
    return;
  }
  if (data.type === "select_champion") {
    if (room.phase !== "lobby" || !validChampion(data.champion)) return;
    if (player.team && sameTeamChampion(room, player, player.team, data.champion)) {
      return send(socket, { type: "error", message: "같은 팀에서는 같은 챔피언을 중복 선택할 수 없습니다." });
    }
    player.champion = data.champion;
    player.ready = false;
    broadcastLobby(room);
    return;
  }
  if (data.type === "set_ready") {
    if (room.phase !== "lobby") return;
    if (!player.team) return send(socket, { type: "error", message: "먼저 팀을 선택해 주세요." });
    player.ready = Boolean(data.ready);
    broadcastLobby(room);
    return;
  }
  if (data.type === "start_match") {
    if (room.phase !== "lobby" || !player.isHost) return;
    const validation = startValidation(room);
    if (!validation.ok) return send(socket, { type: "error", message: validation.message });
    for (const team of ["blue", "red"]) {
      const teammates = Array.from(room.players.values())
        .filter((candidate) => candidate.team === team)
        .sort((a, b) => a.order - b.order);
      teammates.forEach((candidate, slot) => { candidate.slot = slot; });
    }
    room.phase = "playing";
    room.updatedAt = Date.now();
    broadcast(room, {
      type: "match_start",
      code: room.code,
      mode: room.mode,
      authorityPlayerId: room.hostId,
      players: Array.from(room.players.values()).sort((a, b) => a.order - b.order).map(publicPlayer),
      serverTime: Date.now(),
    });
    return;
  }
  if (data.type === "client_ping") {
    send(socket, { type: "client_pong", id: data.id, sentAt: data.sentAt, serverTime: Date.now() });
    return;
  }
  if (data.type === "leave") {
    leave(socket, data.forfeit ? "forfeit" : "left");
    return;
  }
  if (data.type !== "relay" || room.phase !== "playing" || !data.message || typeof data.message !== "object") return;
  if (!allowRelay(player)) return;
  const message = data.message;
  const authoritative = message.type === "snapshot" || message.type === "combat_snapshot"
    || (message.type === "command" && message.command?.type === "combat_event");
  if (authoritative && player.id !== room.hostId) return;
  broadcast(room, { type: "relay", fromPlayerId: player.id, message }, socket);
}

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("message", (raw) => {
    if (raw.length > 128 * 1024) return socket.close(1009, "message too large");
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || typeof data !== "object") return;
    if (data.type === "create") return handleCreate(socket, data);
    if (data.type === "join") return handleJoin(socket, data);

    const info = clients.get(socket);
    const room = info && rooms.get(info.code);
    if (!info || !room) return;
    if (room.protocol === 1) {
      if (data.type !== "relay") return;
      const peer = info.role === "host" ? room.guest : room.host;
      send(peer, { type: "relay", message: data.message });
      return;
    }
    handleV2Message(socket, data, info, room);
  });
  socket.on("close", () => leave(socket, "disconnect"));
  socket.on("error", () => leave(socket, "disconnect"));
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
  const staleBefore = Date.now() - 2 * 60 * 60 * 1000;
  for (const room of rooms.values()) {
    const touched = room.updatedAt ?? room.createdAt;
    if (touched >= staleBefore) continue;
    broadcast(room, { type: "room_closed", message: "오래 사용하지 않은 방이 종료되었습니다." });
    rooms.delete(room.code);
  }
}, 15000);

wss.on("close", () => clearInterval(heartbeat));
server.listen(port, "0.0.0.0", () => console.log(`realtime server listening on ${port}`));
