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

function wsText(raw) {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  return String(raw ?? "");
}

function wsJson(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // socket already closed
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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

function randomSuffix() {
  return Math.floor(Math.random() * 900 + 100);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return json({ ok: true, now: new Date().toISOString() });
    }

    if (url.pathname !== "/ws") {
      return json({ error: "not-found" }, 404);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const id = env.SIGNAL_HUB.idFromName("global");
    const stub = env.SIGNAL_HUB.get(id);
    return stub.fetch(request);
  },
};

export class SignalHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();
    this.clients = new Map();
    this.wsToClientId = new WeakMap();
  }

  maxRoomSize() {
    const raw = Number(this.env.MAX_ROOM_SIZE ?? 64);
    if (!Number.isFinite(raw) || raw < 2) return 64;
    return Math.floor(raw);
  }

  roomUsedNames(key, ignoreId = null) {
    const members = this.rooms.get(key);
    const used = new Set();
    if (!members) return used;
    for (const memberId of members) {
      if (ignoreId && memberId === ignoreId) continue;
      const member = this.clients.get(memberId);
      const name = member?.meta?.name;
      if (typeof name === "string" && name) {
        used.add(name.toLowerCase());
      }
    }
    return used;
  }

  uniqueName(baseName, key, ignoreId = null) {
    const base = normalizeDisplayName(baseName);
    const used = this.roomUsedNames(key, ignoreId);
    if (!used.has(base.toLowerCase())) return base;

    for (let i = 0; i < 500; i++) {
      const candidate = `${base}${randomSuffix()}`;
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

  leaveRoom(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    if (client.app && client.room) {
      const key = roomKey(client.app, client.room);
      const members = this.rooms.get(key);
      if (members) {
        members.delete(clientId);
        for (const memberId of members) {
          const member = this.clients.get(memberId);
          if (member) {
            wsJson(member.ws, { type: "peer-left", id: clientId });
          }
        }
        if (members.size === 0) this.rooms.delete(key);
      }
    }

    this.clients.delete(clientId);
  }

  relayPeerMeta(client, includeSelfAck = true) {
    if (!client.app || !client.room) return;
    const key = roomKey(client.app, client.room);
    const members = this.rooms.get(key);
    if (!members) return;

    if (includeSelfAck) {
      wsJson(client.ws, { type: "meta-updated", id: client.id, meta: client.meta });
    }

    for (const peerId of members) {
      if (peerId === client.id) continue;
      const peer = this.clients.get(peerId);
      if (!peer) continue;
      wsJson(peer.ws, { type: "peer-meta", id: client.id, meta: client.meta });
    }
  }

  handleSetMeta(client, patch) {
    if (!patch || typeof patch !== "object") {
      wsJson(client.ws, { type: "error", reason: "invalid-meta-patch" });
      return;
    }

    const next = {
      name: client.meta?.name ?? "Player",
      status: client.meta?.status ?? "lobby",
    };

    if (Object.prototype.hasOwnProperty.call(patch, "name")) {
      const key = roomKey(client.app, client.room);
      next.name = this.uniqueName(normalizeDisplayName(patch.name), key, client.id);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      next.status = normalizePresenceStatus(patch.status);
    }

    client.meta = next;
    this.relayPeerMeta(client, true);
  }

  handleJoinedClientMessage(client, msg) {
    if (msg.type === "signal") {
      const targetId = msg.to;
      if (typeof targetId !== "string") {
        wsJson(client.ws, { type: "error", reason: "missing-target" });
        return;
      }

      const target = this.clients.get(targetId);
      if (!target) {
        wsJson(client.ws, { type: "error", reason: "peer-not-found", to: targetId });
        return;
      }

      if (target.app !== client.app || target.room !== client.room) {
        wsJson(client.ws, { type: "error", reason: "peer-outside-room", to: targetId });
        return;
      }

      wsJson(target.ws, {
        type: "signal",
        from: client.id,
        signal: msg.signal ?? null,
      });
      return;
    }

    if (msg.type === "direct") {
      const targetId = msg.to;
      if (typeof targetId !== "string") {
        wsJson(client.ws, { type: "error", reason: "missing-target" });
        return;
      }

      const target = this.clients.get(targetId);
      if (!target) {
        wsJson(client.ws, { type: "error", reason: "peer-not-found", to: targetId });
        return;
      }

      if (target.app !== client.app || target.room !== client.room) {
        wsJson(client.ws, { type: "error", reason: "peer-outside-room", to: targetId });
        return;
      }

      wsJson(target.ws, {
        type: "direct",
        from: client.id,
        payload: msg.payload ?? null,
      });
      return;
    }

    if (msg.type === "broadcast") {
      const key = roomKey(client.app, client.room);
      const members = this.rooms.get(key);
      if (!members) return;

      for (const peerId of members) {
        if (peerId === client.id) continue;
        const peer = this.clients.get(peerId);
        if (!peer) continue;
        wsJson(peer.ws, {
          type: "broadcast",
          from: client.id,
          payload: msg.payload ?? null,
        });
      }
      return;
    }

    if (msg.type === "set-meta") {
      this.handleSetMeta(client, msg.patch);
      return;
    }

    if (msg.type === "ping") {
      wsJson(client.ws, { type: "pong", now: Date.now() });
      return;
    }

    wsJson(client.ws, {
      type: "error",
      reason: "unknown-message-type",
      received: msg.type ?? null,
    });
  }

  handleFirstJoin(client, msg) {
    if (msg.type !== "join") {
      wsJson(client.ws, { type: "error", reason: "join-required-first" });
      return;
    }

    const { app, room, meta } = msg;
    if (!validChannelName(app) || !validChannelName(room)) {
      wsJson(client.ws, { type: "error", reason: "invalid-app-or-room" });
      return;
    }

    const key = roomKey(app, room);
    const members = this.rooms.get(key) ?? new Set();
    const maxRoomSize = this.maxRoomSize();
    if (members.size >= maxRoomSize) {
      wsJson(client.ws, { type: "error", reason: "room-full", max: maxRoomSize });
      return;
    }

    const nextMeta = normalizeMeta(meta);
    nextMeta.name = this.uniqueName(nextMeta.name, key, client.id);

    const peers = Array.from(members);
    const peerMeta = peers.map((peerId) => {
      const peer = this.clients.get(peerId);
      return { id: peerId, meta: peer?.meta ?? null };
    });

    members.add(client.id);
    this.rooms.set(key, members);

    client.app = app;
    client.room = room;
    client.meta = nextMeta;

    wsJson(client.ws, {
      type: "welcome",
      id: client.id,
      app,
      room,
      peers,
      peerMeta,
      meta: client.meta,
      maxRoomSize,
    });

    for (const peerId of peers) {
      const peer = this.clients.get(peerId);
      if (!peer) continue;
      wsJson(peer.ws, { type: "peer-joined", id: client.id, meta: client.meta });
    }
  }

  handleMessage(ws, raw) {
    const clientId = this.wsToClientId.get(ws);
    if (!clientId) return;

    const client = this.clients.get(clientId);
    if (!client) return;

    const text = wsText(raw);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      wsJson(ws, { type: "error", reason: "invalid-json" });
      return;
    }

    const joined = client.app && client.room;
    if (!joined) {
      this.handleFirstJoin(client, msg);
      return;
    }

    this.handleJoinedClientMessage(client, msg);
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];

    serverSocket.accept();

    const clientId = crypto.randomUUID();
    this.wsToClientId.set(serverSocket, clientId);
    this.clients.set(clientId, {
      id: clientId,
      ws: serverSocket,
      app: null,
      room: null,
      meta: null,
    });

    serverSocket.addEventListener("message", (event) => {
      this.handleMessage(serverSocket, event.data);
    });

    const cleanup = () => {
      this.leaveRoom(clientId);
    };
    serverSocket.addEventListener("close", cleanup);
    serverSocket.addEventListener("error", cleanup);

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  }
}
