import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 8080);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://solo-lane-duel.prime-clock-7617.chatgpt.site")
  .split(",").map((item) => item.trim()).filter(Boolean);
const rooms = new Map();
const clients = new WeakMap();

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  response.writeHead(404).end();
});

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => !origin || allowedOrigins.includes(origin),
});

function code() {
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

function leave(socket) {
  const info = clients.get(socket);
  if (!info) return;
  const room = rooms.get(info.code);
  if (!room) return;
  const peer = info.role === "host" ? room.guest : room.host;
  send(peer, { type: "peer_left" });
  rooms.delete(info.code);
  clients.delete(socket);
}

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type === "create") {
      const roomCode = code();
      rooms.set(roomCode, { host: socket, guest: null, hostChampion: data.champion, guestChampion: null });
      clients.set(socket, { code: roomCode, role: "host" });
      send(socket, { type: "created", code: roomCode });
      return;
    }
    if (data.type === "join") {
      const roomCode = String(data.code || "").toUpperCase();
      const room = rooms.get(roomCode);
      if (!room || room.guest) return send(socket, { type: "error", message: "참가할 수 없는 방입니다." });
      room.guest = socket;
      room.guestChampion = data.champion;
      clients.set(socket, { code: roomCode, role: "guest" });
      send(socket, { type: "joined", code: roomCode });
      send(room.host, { type: "ready", opponentChampion: room.guestChampion });
      send(room.guest, { type: "ready", opponentChampion: room.hostChampion });
      return;
    }
    if (data.type === "relay") {
      const info = clients.get(socket);
      const room = info && rooms.get(info.code);
      if (!room) return;
      const peer = info.role === "host" ? room.guest : room.host;
      send(peer, { type: "relay", message: data.message });
    }
  });
  socket.on("close", () => leave(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, 15000);
wss.on("close", () => clearInterval(heartbeat));
server.listen(port, "0.0.0.0", () => console.log(`realtime server listening on ${port}`));
