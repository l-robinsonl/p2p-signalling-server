# p2p-signalling-server

Lightweight Node signalling server for WebRTC P2P sessions.

## Features

- Generic signalling by `app` + `room`
- Peer discovery (`welcome`, `peer-joined`, `peer-left`)
- Relay for SDP / ICE (`signal`)
- Optional room broadcast (`broadcast`)

## Run

```bash
npm install
npm run start
```

Defaults:

- HTTP: `http://0.0.0.0:8787`
- WS: `ws://0.0.0.0:8787/ws`

## Env

- `PORT` (default: `8787`)
- `HOST` (default: `0.0.0.0`)
- `MAX_ROOM_SIZE` (default: `8`)
