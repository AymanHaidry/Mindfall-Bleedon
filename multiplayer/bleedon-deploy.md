# Bleedon Multiplayer — Deployment Guide

## File overview
```
bleedon-lobby.html    ← Link from your main site
bleedon-server.js     ← Deploy this on Render
package.json          ← Node.js dependencies
```

---

## Step 1 — package.json

Create this in the same folder as `bleedon-server.js`:

```json
{
  "name": "bleedon-server",
  "version": "1.0.0",
  "description": "Bleedon multiplayer WebSocket server",
  "main": "bleedon-server.js",
  "scripts": {
    "start": "node bleedon-server.js"
  },
  "dependencies": {
    "ws": "^8.16.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

---

## Step 2 — Deploy on Render

1. Push `bleedon-server.js` + `package.json` to a GitHub repo
   (can be private — just `bleedon-server` repo, two files)

2. Go to **https://render.com** → New → **Web Service**

3. Connect your GitHub repo

4. Fill in:
   | Field | Value |
   |-------|-------|
   | Name | `bleedon-server` |
   | Runtime | `Node` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | `Free` (fine for early access) |

5. Click **Deploy**

6. Render gives you a URL like:
   `https://bleedon-server.onrender.com`

---

## Step 3 — Connect lobby to server

Open `bleedon-lobby.html` and find line 3 of the script:

```js
const SERVER_URL = 'ws://localhost:3001';
```

Change it to your Render URL — **important: use `wss://` not `https://`**:

```js
const SERVER_URL = 'wss://bleedon-server.onrender.com';
```

Done. That's the only change needed.

---

## Step 4 — Link lobby from main site

In `bleedon.html`, wherever you want the multiplayer button, add:

```html
<a href="bleedon-lobby.html">
  <button>MULTIPLAYER</button>
</a>
```

Or in the nav alongside the existing PLAY FREE button.

---

## How it works

```
Player A opens lobby → creates room → gets code "XK7P2Q"
Player B opens lobby → enters "XK7P2Q" → joins room
Both mark ready → host clicks START
Server sends game_start → both redirect to bleedon.html?room=XK7P2Q
```

The `game_event` message type relays live events between players
(attacks in PvP, shared state in co-op). Hook it up in `bleedon.html`
by listening for `?room=` in the URL on load.

---

## Local dev (no Render needed)

```bash
npm install
node bleedon-server.js
# Server running on ws://localhost:3001
```

Open `bleedon-lobby.html` in browser — it connects automatically.

---

## Free tier note

Render free tier **spins down after 15 minutes of inactivity**.
First connection after idle takes ~30 seconds to wake.
Upgrade to Starter ($7/mo) for always-on. Fine for launch.

---

## Message reference

| Type | Direction | Description |
|------|-----------|-------------|
| `welcome` | S→C | Client gets their ID |
| `create_room` | C→S | Create room with mode + maxPlayers |
| `join_room` | C→S | Join by 6-char code |
| `player_ready` | C→S | Toggle ready state |
| `start_game` | C→S | Host starts (all must be ready) |
| `leave_room` | C→S | Leave current room |
| `game_event` | C→S→C | Relay in-game events between players |
| `room_created` | S→C | Room created confirmation |
| `room_joined` | S→C | Join confirmation |
| `room_updated` | S→C | Player list changed |
| `player_joined` | S→C | Broadcast: someone joined |
| `player_left` | S→C | Broadcast: someone left |
| `all_ready` | S→C | Everyone is ready |
| `game_start` | S→C | Game begins |
| `host_changed` | S→C | New host assigned |
| `error` | S→C | Error message |
| `ping/pong` | S↔C | Keepalive |
