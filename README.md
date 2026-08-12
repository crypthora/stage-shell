# stage-shell

Windows desktop dock and local-first voice-input shell built with Electron, a Python desktop backend, and a Zig foreground-input core.

## Privacy and local state

The repository intentionally contains no personal configuration, API keys, ASR endpoint, wallpaper, draft, audio, thumbnails, logs, virtual environments, Node dependencies, or Zig binaries.

At runtime, personal Electron state is stored below `%APPDATA%\\stage-shell`.

## Prerequisites

- Windows 10/11
- Node.js 20+
- Python 3.11+ with dependencies from `backend/requirements.txt`
- Zig 0.14+

## Setup

```powershell
Copy-Item backend/config.example.json backend/config.json
cd backend/ui
npm install
npm run build

cd ../../zig-core
zig build -Doptimize=ReleaseSafe

cd ../electron
npm install
npm start
```

Use `STAGE_SHELL_PYTHON` to point Electron at a specific Python interpreter. Voice endpoint/API-key settings are entered locally through the app settings and are never committed.

## Architecture

- `electron/`: host windows, tray, appbar integration, local voice HTTP service.
- `backend/`: desktop/window state, widgets, WebSocket state feed, and Dock UI source.
- `zig-core/`: local Win32 foreground capture and Unicode text injection service.
