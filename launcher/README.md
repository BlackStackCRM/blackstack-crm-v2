# BlackStack CRM V2 — Server Launcher

The **Server Launcher** is a lightweight always-running gateway that eliminates
the `ERR_CONNECTION_REFUSED` browser error when the CRM backend is stopped.

## How It Works

```
Browser (http://localhost:3000)
     │
     ▼
┌──────────────────────────────────────┐
│  Server Launcher  (port 3000)         │
│  - Always running                    │
│  - Serves "Server Offline" page      │
│  - Spawns CRM backend on port 3001   │
│  - Reverse-proxies to CRM on 3001    │
└──────────────────────────────────────┘
     │                            │
     │  (CRM running?)             │  (CRM stopped?)
     ▼                            ▼
┌──────────────┐         ┌─────────────────────┐
│  CRM Backend  │         │  "Server Offline"   │
│  (port 3001)  │         │  "Start CRM Server" │
│  (node server │         │  button + loading   │
│   /app.js)    │         │  + retry on error   │
└──────────────┘         └─────────────────────┘
```

## Quick Start

```bash
# From the project root:
npm run launcher
# Or:
node launcher/app.js

# Then open: http://localhost:3000
```

## Startup

To make the launcher start automatically when Windows starts (so the CRM is
always accessible after a reboot):

```bash
python3 launcher/create_startup.py
```

This creates a `.vbs` file in your Windows Startup folder that launches
`start-launcher.bat` hidden when you sign in.

## Usage

1. **Open `http://localhost:3000`** in your browser.
2. If the CRM backend is running, it loads immediately.
3. If the CRM is stopped, you see the branded "Server Offline" page with a
   **Start CRM Server** button.
4. Click the button → the launcher spawns `node server/app.js` (the existing
   startup mechanism) on port 3001.
5. The launcher polls `/health` until the CRM is ready, then proxies your
   browser to the CRM automatically.
6. You land on `http://localhost:3000/#dashboard` — no manual refresh needed.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/launcher/status` | Current launcher + CRM state |
| POST | `/api/launcher/start` | Start the CRM backend |
| POST | `/api/launcher/stop` | Stop the CRM backend |

## Configuration

Edit `launcher/.env` to customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `LAUNCHER_PORT` | `3000` | User-facing port (what the browser opens) |
| `LAUNCHER_CRM_PORT` | `3001` | Internal CRM backend port |
| `DEMO_MODE` | `true` | Passed to `server/app.js` |
| `DB_PATH` | `./data/blackstack-crm.db` | Passed to `server/app.js` |

The user-facing URL remains `http://localhost:3000` — the existing port.
The CRM backend port (3001) is a non-breaking implementation detail.

## Key Design Decisions

- **No new npm dependencies**: Uses only Node.js built-ins + Express (already
  a project dependency).
- **Existing startup mechanism**: The launcher spawns `node server/app.js`
  with the same env vars (DEMO_MODE, DB_PATH, PORT) the project already uses.
- **No CRM changes**: The CRM server code is untouched. The launcher simply
  acts as a reverse proxy.
- **No auth system changes**: JWT login, API guards, and all auth flows work
  transparently through the proxy.
