# p2p-signalling-server

Lightweight signalling server for WebRTC P2P sessions.

## Protocol

- Generic signalling by `app` + `room`
- Peer discovery (`welcome`, `peer-joined`, `peer-left`)
- Relay for SDP / ICE (`signal`)
- Optional room broadcast (`broadcast`)

## Local run (Node)

```bash
npm install
npm run start
```

Defaults:

- HTTP: `http://0.0.0.0:8787`
- WS: `ws://0.0.0.0:8787/ws`

## Cloudflare Worker + Durable Object

This repo includes a Worker implementation at `src/worker.js` with a Durable Object (`SignalHub`) for WebSocket room state.

Deploy:

```bash
npm install
npm run cf:deploy
```

After deploy, your signalling endpoint is:

- `wss://<your-worker-subdomain>/ws`

Health check:

- `https://<your-worker-subdomain>/healthz`

## Env

- `MAX_ROOM_SIZE` (default: `8`)
