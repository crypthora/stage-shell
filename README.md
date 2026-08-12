# stage-shell

Windows desktop dock and local-first voice-input shell built with Electron and a Zig foreground-input core.

## Privacy and local state

The repository intentionally contains no personal configuration, API keys, ASR endpoint, wallpaper, draft, audio, thumbnails, logs, virtual environments, Node dependencies, or Zig binaries.

At runtime, personal Electron state is stored below `%APPDATA%\\stage-shell`.

## Prerequisites

- Windows 10/11
- Node.js 20+
- Zig 0.14+

## Setup

```powershell
cd electron/ui
npm install
npm run build

cd ../../zig-core
zig build -Doptimize=ReleaseSafe

cd ../electron
npm install
npm start
```

Voice endpoint/API-key settings are entered locally through the app settings and are never committed.

## Architecture

- `electron/`: host windows, tray, AppBar integration, local HTTP services, settings, widgets and Dock UI source.
- `zig-core/`: local Win32 foreground capture and Unicode text injection service.
