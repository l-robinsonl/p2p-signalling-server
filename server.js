import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 8787);
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE ?? 64);

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

const rooms = new Map();
const clients = new Map();
const wsToClientId = new WeakMap();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
};

function json(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function roomKey(app, room) {
  return `${app}::${room}`;
}

function validChannelName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  );
}

function normalizeDisplayName(value) {
  const cleaned = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  return cleaned || "Player";
}

function normalizePresenceStatus(value) {
  return value === "playing" ? "playing" : "lobby";
}

function normalizeMeta(input) {
  const meta = input && typeof input === "object" ? input : {};
  return {
    name: normalizeDisplayName(meta.name),
    status: normalizePresenceStatus(meta.status),
  };
}

function roomUsedNames(key, ignoreId = null) {
  const members = rooms.get(key);
  const used = new Set();
  if (!members) return used;
  for (const memberId of members) {
    if (ignoreId && memberId === ignoreId) continue;
    const member = clients.get(memberId);
    const name = member?.meta?.name;
    if (typeof name === "string" && name) used.add(name.toLowerCase());
  }
  return used;
}

function uniqueName(baseName, key, ignoreId = null) {
  const base = normalizeDisplayName(baseName);
  const used = roomUsedNames(key, ignoreId);
  if (!used.has(base.toLowerCase())) return base;

  for (let i = 0; i < 500; i++) {
    const candidate = `${base}${Math.floor(Math.random() * 900 + 100)}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  let n = 2;
  while (n < 10000) {
    const candidate = `${base}${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
    n++;
  }
  return `${base}${Date.now() % 100000}`;
}

function relayPeerMeta(client, includeSelfAck = true) {
  if (!client.app || !client.room) return;
  const key = roomKey(client.app, client.room);
  const members = rooms.get(key);
  if (!members) return;

  if (includeSelfAck) {
    json(client.ws, { type: "meta-updated", id: client.id, meta: client.meta });
  }

  for (const peerId of members) {
    if (peerId === client.id) continue;
    const peer = clients.get(peerId);
    if (!peer) continue;
    json(peer.ws, { type: "peer-meta", id: client.id, meta: client.meta });
  }
}

function leaveRoom(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.app && client.room) {
    const key = roomKey(client.app, client.room);
    const members = rooms.get(key);
    if (members) {
      members.delete(clientId);
      for (const memberId of members) {
        const member = clients.get(memberId);
        if (member) {
          json(member.ws, { type: "peer-left", id: clientId });
        }
      }
      if (members.size === 0) {
        rooms.delete(key);
      }
    }
  }

  clients.delete(clientId);
}

async function serveStatic(req, res) {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "method-not-allowed" }));
    return;
  }

  if (reqUrl.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, now: new Date().toISOString() }));
    return;
  }

  const rawPath = reqUrl.pathname === "/" ? "index.html" : reqUrl.pathname;
  const safePath = normalize(rawPath)
    .replace(/^([/\\])+/, "")
    .replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  try {
    const fileBuffer = await readFile(filePath);
    const type = mimeTypes[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(fileBuffer);
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not-found" }));
  }
}

const server = createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "internal-server-error" }));
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const clientId = randomUUID();
  wsToClientId.set(ws, clientId);
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      json(ws, { type: "error", reason: "invalid-json" });
      return;
    }

    const existingClient = clients.get(clientId);

    if (!existingClient) {
      if (msg.type !== "join") {
        json(ws, { type: "error", reason: "join-required-first" });
        return;
      }

      const { app, room, meta } = msg;
      if (!validChannelName(app) || !validChannelName(room)) {
        json(ws, { type: "error", reason: "invalid-app-or-room" });
        return;
      }

      const key = roomKey(app, room);
      const members = rooms.get(key) ?? new Set();
      if (members.size >= MAX_ROOM_SIZE) {
        json(ws, { type: "error", reason: "room-full", max: MAX_ROOM_SIZE });
        return;
      }

      const nextMeta = normalizeMeta(meta);
      nextMeta.name = uniqueName(nextMeta.name, key, clientId);

      const peers = Array.from(members);
      const peerMeta = peers.map((peerId) => {
        const peer = clients.get(peerId);
        return { id: peerId, meta: peer?.meta ?? null };
      });

      members.add(clientId);
      rooms.set(key, members);
      clients.set(clientId, { id: clientId, ws, app, room, meta: nextMeta });

      json(ws, {
        type: "welcome",
        id: clientId,
        app,
        room,
        peers,
        peerMeta,
        meta: nextMeta,
        maxRoomSize: MAX_ROOM_SIZE,
      });

      for (const peerId of peers) {
        const peer = clients.get(peerId);
        if (!peer) continue;
        json(peer.ws, { type: "peer-joined", id: clientId, meta: nextMeta });
      }
      return;
    }

    if (msg.type === "signal") {
      const targetId = msg.to;
      if (typeof targetId !== "string") {
        json(ws, { type: "error", reason: "missing-target" });
        return;
      }

      const target = clients.get(targetId);
      if (!target) {
        json(ws, { type: "error", reason: "peer-not-found", to: targetId });
        return;
      }

      if (target.app !== existingClient.app || target.room !== existingClient.room) {
        json(ws, { type: "error", reason: "peer-outside-room", to: targetId });
        return;
      }

      json(target.ws, {
        type: "signal",
        from: clientId,
        signal: msg.signal ?? null,
      });
      return;
    }

    if (msg.type === "direct") {
      const targetId = msg.to;
      if (typeof targetId !== "string") {
        json(ws, { type: "error", reason: "missing-target" });
        return;
      }

      const target = clients.get(targetId);
      if (!target) {
        json(ws, { type: "error", reason: "peer-not-found", to: targetId });
        return;
      }

      if (target.app !== existingClient.app || target.room !== existingClient.room) {
        json(ws, { type: "error", reason: "peer-outside-room", to: targetId });
        return;
      }

      json(target.ws, {
        type: "direct",
        from: clientId,
        payload: msg.payload ?? null,
      });
      return;
    }

    if (msg.type === "broadcast") {
      const key = roomKey(existingClient.app, existingClient.room);
      const members = rooms.get(key);
      if (!members) return;
      for (const peerId of members) {
        if (peerId === clientId) continue;
        const peer = clients.get(peerId);
        if (!peer) continue;
        json(peer.ws, {
          type: "broadcast",
          from: clientId,
          payload: msg.payload ?? null,
        });
      }
      return;
    }

    if (msg.type === "set-meta") {
      if (!msg.patch || typeof msg.patch !== "object") {
        json(ws, { type: "error", reason: "invalid-meta-patch" });
        return;
      }

      const next = {
        name: existingClient.meta?.name ?? "Player",
        status: existingClient.meta?.status ?? "lobby",
      };

      if (Object.prototype.hasOwnProperty.call(msg.patch, "name")) {
        const key = roomKey(existingClient.app, existingClient.room);
        next.name = uniqueName(normalizeDisplayName(msg.patch.name), key, existingClient.id);
      }

      if (Object.prototype.hasOwnProperty.call(msg.patch, "status")) {
        next.status = normalizePresenceStatus(msg.patch.status);
      }

      existingClient.meta = next;
      relayPeerMeta(existingClient, true);
      return;
    }

    if (msg.type === "ping") {
      json(ws, { type: "pong", now: Date.now() });
      return;
    }

    json(ws, { type: "error", reason: "unknown-message-type", received: msg.type ?? null });
  });

  ws.on("close", () => {
    leaveRoom(clientId);
  });

  ws.on("error", () => {
    leaveRoom(clientId);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(PORT, HOST, () => {
  console.log(`signalling server running on http://${HOST}:${PORT}`);
  console.log(`websocket endpoint: ws://${HOST}:${PORT}/ws`);
});
