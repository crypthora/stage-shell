const { app, BrowserWindow, screen, powerMonitor, nativeTheme, dialog, Menu, Tray, session } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { VoiceService } = require('./voice-service.cjs');

const APP_NAME = 'stage-shell';
const APP_ID = 'com.crypthora.stage-shell';
const STAGE_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_ROOT = path.join(STAGE_ROOT, 'backend');
const BACKEND = path.join(__dirname, '..', 'backend.py');
const APPBAR = path.join(__dirname, '..', 'native', 'appbar.ps1');
const APPBAR_HOST = path.join(__dirname, '..', 'native', 'appbar-host.ps1');
const POSITION_WINDOW = path.join(__dirname, '..', 'native', 'position-window.ps1');
const NATIVE_CORE = path.join(STAGE_ROOT, 'zig-core', 'zig-out', 'bin', 'stage-shell-core.exe');
const NATIVE_CORE_URL = 'http://127.0.0.1:7803';
app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
let backend;
let sidebar;
let settingsWindow;
let tray;
let backendUrl;
let readyFile;
let appBarHandleFile;
let appBarHost;
let appBarReadyFile;
let dockSignature = '';
let recoveryTimer;
let rebuildingDock = false;
let voiceService;
let voiceCapture;
let voiceOverlay;
let voiceOverlayPosition = '';
let voiceEditor;
let voiceEditorVisible = false;
let voiceEditorCenterRequest = 0;
let voiceEditorBoundsTimer;
let hotkeyHelper;
let nativeCoreProcess;
let hotkeyRestarting = false;
let initialHotkeyRecovery;
let restartingBackend = false;
let backendFailures = 0;
const VOICE_OVERLAY_SIZE = Object.freeze({ width: 440, height: 86 });

function voiceEditorBoundsPath() { return path.join(app.getPath('userData'), 'voice-editor-window.json'); }
function loadVoiceEditorBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(voiceEditorBoundsPath(), 'utf8'));
    const bounds = { x: Number(saved.x), y: Number(saved.y), width: Number(saved.width), height: Number(saved.height) };
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width < 460 || bounds.height < 260) return null;
    const visible = screen.getAllDisplays().some((display) => bounds.x + bounds.width > display.bounds.x + 32 && bounds.x < display.bounds.x + display.bounds.width - 32 && bounds.y + bounds.height > display.bounds.y + 32 && bounds.y < display.bounds.y + display.bounds.height - 32);
    return visible ? bounds : null;
  } catch { return null; }
}
function saveVoiceEditorBounds() {
  if (!voiceEditor || voiceEditor.isDestroyed()) return;
  try { fs.writeFileSync(voiceEditorBoundsPath(), JSON.stringify(voiceEditor.getBounds())); } catch {}
}
function scheduleVoiceEditorBoundsSave() {
  clearTimeout(voiceEditorBoundsTimer);
  voiceEditorBoundsTimer = setTimeout(saveVoiceEditorBounds, 250);
}

function voiceCommand(pathname) {
  return fetch(`http://127.0.0.1:7798${pathname}`, { method: 'POST' })
    .catch((error) => console.error(`Voice command ${pathname} failed:`, error));
}

function pythonCommand() { return process.env.STAGE_SHELL_PYTHON || 'python'; }

function startHotkeyHelper() {
  if (hotkeyHelper && hotkeyHelper.exitCode === null && !hotkeyHelper.killed) return;
  const script = path.join(__dirname, '..', 'native', 'caps-hotkey.py');
  const python = pythonCommand();
  const helper = spawn(python, [script], {
    windowsHide: true, stdio: 'ignore',
  });
  hotkeyHelper = helper;
  helper.once('error', (error) => console.error('CapsLock hook launch failed:', error));
  helper.once('exit', (code, signal) => {
    // Do not let an old helper's delayed exit erase the reference to its
    // replacement. That race created two competing low-level hooks.
    if (hotkeyHelper === helper) hotkeyHelper = undefined;
    // A helper crash removes only its Windows hook. Restart it separately;
    // never relaunch/kill Electron or the active microphone capture.
    if (!app.isQuitting && !hotkeyRestarting) {
      console.error(`CapsLock hook exited (${code ?? signal ?? 'unknown'}); retrying.`);
      setTimeout(() => {
        if (!hotkeyHelper) startHotkeyHelper();
      }, 1200);
    }
  });
}

function restartHotkeyHelper(reason = '手动重新挂钩') {
  if (hotkeyRestarting || app.isQuitting) return;
  hotkeyRestarting = true;
  const previous = hotkeyHelper;
  hotkeyHelper = undefined;
  try {
    if (previous?.pid && previous.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(previous.pid), '/T', '/F'], { windowsHide: true });
    }
  } catch (error) {
    console.error('CapsLock hook stop failed:', error);
  }
  forceCapsOff();
  setTimeout(() => {
    hotkeyRestarting = false;
    startHotkeyHelper();
    console.log(`CapsLock hook restarted: ${reason}`);
  }, 250);
}

function scheduleInitialHotkeyRecovery() {
  // Pynput can successfully install its low-level hook while Electron is still
  // bringing up hidden renderers.  On a few Windows starts that first hook
  // receives no usable CapsLock callback, whereas re-installing it after the
  // desktop is fully ready works.  Do that automatically once per launch.
  clearTimeout(initialHotkeyRecovery);
  initialHotkeyRecovery = setTimeout(() => {
    restartHotkeyHelper('启动后自动校准');
  }, 1800);
}

function forceCapsOff() {
  const script = path.join(__dirname, '..', 'native', 'caps-hotkey.py');
  const python = pythonCommand();
  try { spawnSync(python, [script, '--force-off'], { windowsHide: true, stdio: 'ignore' }); } catch {}
}

async function startVoiceCore() {
  voiceService = new VoiceService(app.getPath('userData'));
  if (!fs.existsSync(NATIVE_CORE)) throw new Error(`Zig 输入核心不存在：${NATIVE_CORE}`);
  voiceService.setNativeCoreUrl(NATIVE_CORE_URL);
  await voiceService.start();
  // The capture renderer only speaks the localhost service. Permission is
  // granted once for this trusted Electron-owned file page, never to the UI.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });
  voiceCapture = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  voiceCapture.webContents.setAudioMuted(true);
  voiceCapture.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.error(`Voice capture console [${level}] ${sourceId}:${line} ${message}`);
  });
  voiceCapture.webContents.on('render-process-gone', (_event, details) => {
    console.error('Voice capture renderer exited:', details);
  });
  await voiceCapture.loadFile(path.join(__dirname, 'voice-capture.html'));
  syncWindowDevTools(voiceCapture);
  voiceCapture.on('closed', () => { voiceCapture = undefined; });
}

async function startNativeCore() {
  // A previous host can occasionally leave the local Core alive while the
  // Electron parent exits. Reuse a healthy listener instead of launching a
  // second process that immediately fails to bind the same port.
  try {
    const health = await getJson(`${NATIVE_CORE_URL}/v1/core/health`);
    if (health?.ok) return;
  } catch {}
  if (nativeCoreProcess?.exitCode === null && !nativeCoreProcess.killed) return;
  nativeCoreProcess = spawn(NATIVE_CORE, ['serve', '7803'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  nativeCoreProcess.stderr.on('data', (chunk) => console.error(`Zig core: ${String(chunk).trim()}`));
  const child = nativeCoreProcess;
  child.once('exit', (code) => {
    if (nativeCoreProcess === child) nativeCoreProcess = undefined;
    if (!app.isQuitting) {
      console.error(`Zig core exited: ${code}`);
      setTimeout(() => void startNativeCore().catch((error) => console.error('Zig core recovery failed:', error)), 900);
    }
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const health = await getJson(`${NATIVE_CORE_URL}/v1/core/health`);
      if (health?.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Zig 输入核心未在 3 秒内就绪');
}

async function resetVoiceCapture(reason = '语音核心重置') {
  if (!voiceService || !voiceCapture || voiceCapture.isDestroyed()) return;
  // The capturer owns getUserMedia. Restarting only Python/Dock cannot repair
  // a renderer that stopped delivering audio frames, so rebuild this page too.
  voiceService.resetCapture(reason, voiceService.enabled);
  await voiceCapture.webContents.reloadIgnoringCache();
}

async function reloadVoiceEditor() {
  // The editor is intentionally kept alive when users hide it, so a backend
  // and Dock restart otherwise leaves it running an older bundled UI.  Reload
  // from disk without cache; the document itself is saved through the local
  // API and is restored by the renderer during boot.
  if (!voiceEditor || voiceEditor.isDestroyed()) return;
  await voiceEditor.webContents.reloadIgnoringCache();
}

function createVoiceOverlay() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = VOICE_OVERLAY_SIZE;
  voiceOverlay = new BrowserWindow({
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: display.workArea.y + display.workArea.height - height - 24,
    width, height, frame: false, transparent: false, backgroundColor: '#1a1b20', resizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  voiceOverlay.setAlwaysOnTop(true, 'screen-saver');
  voiceOverlay.setIgnoreMouseEvents(true, { forward: true });
  voiceOverlay.loadFile(path.join(__dirname, 'voice-overlay.html')).catch(console.error);
  voiceOverlay.webContents.once('did-finish-load', () => syncWindowDevTools(voiceOverlay));
  setInterval(() => {
    if (!voiceOverlay || voiceOverlay.isDestroyed()) return;
    positionVoiceOverlay();
    const overlay = voiceService?.state().overlay;
    const visible = overlay?.visible;
    if (visible && !voiceOverlay.isVisible()) voiceOverlay.showInactive();
    if (!visible && voiceOverlay.isVisible()) voiceOverlay.hide();
  }, 100);
}

function createVoiceEditor() {
  const restoredBounds = loadVoiceEditorBounds();
  let needsInitialEditorCenter = !restoredBounds;
  voiceEditor = new BrowserWindow({
    title: '语音输入', ...(restoredBounds || { width: 680, height: 420 }), minWidth: 460, minHeight: 260,
    frame: false, resizable: true, minimizable: false, maximizable: false,
    show: false, backgroundColor: '#15181d', alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  voiceEditor.setAlwaysOnTop(true, 'screen-saver');
  voiceEditor.on('move', scheduleVoiceEditorBoundsSave);
  voiceEditor.on('resize', scheduleVoiceEditorBoundsSave);
  voiceEditor.on('close', (event) => {
    // Closing the writing center is a visibility toggle, not a destructive
    // window close.  Keeping the renderer alive makes the next short press
    // reliable and preserves the draft.
    if (!app.isQuitting) {
      event.preventDefault();
      voiceService?.hideEditor();
      voiceEditorVisible = false;
      voiceEditor.hide();
    }
  });
  voiceEditor.loadFile(path.join(BACKEND_ROOT, 'ui', 'dist', 'voice-editor.html')).catch(console.error);
  voiceEditor.webContents.once('did-finish-load', () => syncWindowDevTools(voiceEditor));
  setInterval(() => {
    if (!voiceEditor || voiceEditor.isDestroyed()) return;
    const editorState = voiceService?.state().editor;
    const visible = Boolean(editorState?.visible);
    if (Number(editorState?.centerRequest) !== voiceEditorCenterRequest) {
      voiceEditorCenterRequest = Number(editorState?.centerRequest) || 0;
      positionVoiceEditor();
    }
    if (visible && !voiceEditorVisible) {
      if (needsInitialEditorCenter) { positionVoiceEditor(); needsInitialEditorCenter = false; }
      voiceEditor.show(); voiceEditor.focus();
    }
    if (!visible && voiceEditorVisible) voiceEditor.hide();
    voiceEditorVisible = visible;
  }, 100);
}

function syncWindowDevTools(window) {
  if (!window || window.isDestroyed() || !voiceService?.config?.devTools) return;
  if (!window.webContents.isDevToolsOpened()) window.webContents.openDevTools({ mode: 'detach' });
}

function positionVoiceEditor() {
  if (!voiceEditor || voiceEditor.isDestroyed()) return;
  const display = sidebar && !sidebar.isDestroyed() ? screen.getDisplayMatching(sidebar.getBounds()) : screen.getPrimaryDisplay();
  const bounds = voiceEditor.getBounds();
  const dock = sidebar && !sidebar.isDestroyed() ? sidebar.getBounds() : null;
  let left = display.bounds.x, right = display.bounds.x + display.bounds.width;
  if (dock && Math.abs(dock.x - left) <= 2) left += dock.width;
  if (dock && Math.abs(dock.x + dock.width - right) <= 2) right -= dock.width;
  voiceEditor.setPosition(Math.round(left + (right - left - bounds.width) / 2), Math.round(display.bounds.y + (display.bounds.height - bounds.height) / 2));
}

function positionVoiceOverlay() {
  if (!voiceOverlay || voiceOverlay.isDestroyed()) return;
  const dockBounds = sidebar && !sidebar.isDestroyed() ? sidebar.getBounds() : null;
  const display = dockBounds ? screen.getDisplayMatching(dockBounds) : screen.getPrimaryDisplay();
  // Use display.bounds, not workArea: the native AppBar may already have
  // changed workArea, which would subtract the Dock twice.  Only the real
  // Dock rectangle is removed from the horizontal centering area.
  let left = display.bounds.x;
  let right = display.bounds.x + display.bounds.width;
  if (dockBounds && dockBounds.y < display.bounds.y + display.bounds.height &&
      dockBounds.y + dockBounds.height > display.bounds.y) {
    if (Math.abs(dockBounds.x - display.bounds.x) <= 2) left += dockBounds.width;
    if (Math.abs(dockBounds.x + dockBounds.width - right) <= 2) right -= dockBounds.width;
  }
  const { width, height } = VOICE_OVERLAY_SIZE;
  const x = Math.round(left + (right - left - width) / 2);
  const y = Math.round(display.workArea.y + display.workArea.height - height - 24);
  const signature = `${x},${y},${width},${height}`;
  if (signature === voiceOverlayPosition && voiceOverlay.getBounds().width === width && voiceOverlay.getBounds().height === height) return;
  voiceOverlayPosition = signature;
  // Never derive layout from the current window rectangle: Windows/Electron
  // can occasionally leave this transient overlay at a tiny native size.
  voiceOverlay.setBounds({ x, y, width, height }, false);
}

function probe(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.once('error', reject);
  });
}

function hwndOf(window) {
  const handle = window.getNativeWindowHandle();
  return Number(handle.readBigUInt64LE(0));
}

function stopAppBarHost() {
  const previous = appBarHost;
  appBarHost = undefined;
  if (previous?.pid && previous.exitCode === null) {
    spawnSync('taskkill.exe', ['/PID', String(previous.pid), '/T', '/F'], { windowsHide: true });
  }
  if (appBarReadyFile) try { fs.unlinkSync(appBarReadyFile); } catch {}
}

async function waitForAppBarHost() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(appBarReadyFile)) return JSON.parse(fs.readFileSync(appBarReadyFile, 'utf8'));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Native AppBar host did not become ready.');
}

async function startAppBarHost(dock) {
  stopAppBarHost();
  if (!dock.reserve) return;
  const child = spawn('powershell.exe', [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', APPBAR_HOST,
    '-Width', String(dock.width), '-Side', dock.side, '-ReadyFile', appBarReadyFile,
  ], { windowsHide: true, stdio: 'ignore' });
  appBarHost = child;
  child.once('error', (error) => console.error('AppBar host launch failed:', error));
  child.once('exit', (code) => {
    if (appBarHost === child && !app.isQuitting) console.error(`AppBar host exited (${code}).`);
  });
  await waitForAppBarHost();
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).once('error', reject);
  });
}

function postCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command, args });
    const url = new URL(`${backendUrl}/api/command`);
    const request = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function syncHostTheme() {
  return postCommand('setHostTheme', [nativeTheme.shouldUseDarkColors ? 'dark' : 'light'])
    .catch((error) => console.error('Host theme sync failed:', error));
}

function removePreviousAppBar() {
  if (!appBarHandleFile || !fs.existsSync(appBarHandleFile)) return;
  const oldHandle = fs.readFileSync(appBarHandleFile, 'utf8').trim();
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', APPBAR,
      '-Action', 'remove', '-Hwnd', oldHandle], { encoding: 'utf8', windowsHide: true });
  } finally {
    try { fs.unlinkSync(appBarHandleFile); } catch {}
  }
}

function positionSidebar([x, y, width, height]) {
  const display = screen.getPrimaryDisplay();
  fs.writeFileSync(path.join(app.getPath('userData'), 'display-diagnostic.json'), JSON.stringify({ appBar: { x, y, width, height }, display }, null, 2));
  // SHAppBarMessage can reposition a native HWND without Electron receiving a
  // normal move notification.  Reasserting visibility/top-most status after
  // that native move restores Chromium's DWM surface after display sleep.
  if (sidebar && !sidebar.isDestroyed()) {
    // Electron's DIP positioning is virtualized by a separate process's
    // AppBar reservation on some Windows builds. The independent host gives
    // us the exact physical rectangle, so move the Chromium HWND only after
    // that reservation is complete. It is no longer itself an AppBar.
    try {
      const host = JSON.parse(fs.readFileSync(appBarReadyFile, 'utf8'));
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', POSITION_WINDOW,
        '-Hwnd', String(hwndOf(sidebar)), '-Left', String(host.left), '-Top', String(host.top),
        '-Width', String(host.width), '-Height', String(host.height),
      ], { windowsHide: true, stdio: 'ignore' });
      child.unref();
    } catch (error) { console.error('Native Dock placement failed:', error); }
    sidebar.setAlwaysOnTop(true, 'screen-saver');
    sidebar.showInactive();
    sidebar.moveTop();
  }
}

async function applyDockConfig(config, force = false) {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const logicalWidth = Math.max(120, Math.min(900, Number(config.BAR_W) || 300));
  const dock = {
    // BAR_W is the UI's logical/CSS width, matching the old host. AppBar is
    // native pixels, so it needs the monitor scale factor.
    width: Math.round(logicalWidth * scale),
    side: String(config.DOCK_SIDE) === 'left' ? 'left' : 'right',
    reserve: config.RESERVE_SPACE !== false,
  };
  const signature = JSON.stringify(dock);
  if (!force && signature === dockSignature) return;
  dockSignature = signature;
  await startAppBarHost(dock);
  if (sidebar && !sidebar.isDestroyed()) positionSidebarInReservedCoordinates(config);
  positionVoiceOverlay();
}

function positionSidebarInReservedCoordinates(config) {
  if (!sidebar || sidebar.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const width = Math.max(120, Math.min(900, Number(config.BAR_W) || 300));
  const side = String(config.DOCK_SIDE) === 'left' ? 'left' : 'right';
  // The AppBar has its own HWND, so this Electron window uses normal monitor
  // DIP coordinates. Electron's Display.workArea is not refreshed reliably
  // after a different process registers an AppBar, therefore use bounds here
  // and keep the Dock flush to the physical monitor edge.
  const x = side === 'right'
    ? display.bounds.x + display.bounds.width - width
    : display.bounds.x;
  sidebar.setBounds({ x, y: display.bounds.y, width, height: display.bounds.height });
  positionSidebar([x, display.bounds.y, width, display.bounds.height]);
}

async function recoverDock() {
  if (!sidebar || sidebar.isDestroyed()) return;
  try {
    const config = await getJson(`${backendUrl}/api/config`);
    // After a monitor power-cycle a retained AppBar HWND can keep its shell
    // reservation while Chromium's DWM surface is gone.  Showing/reloading
    // that HWND is not reliable; rebuild the tiny host window instead.
    rebuildingDock = true;
    stopAppBarHost();
    sidebar.destroy();
    sidebar = undefined;
    dockSignature = '';
    await createSidebar(config);
  } catch (error) {
    console.error('Dock recovery failed:', error);
  } finally {
    rebuildingDock = false;
  }
}

function scheduleDockRecovery() {
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    void recoverDock();
    // Windows may report display recovery before DWM has recreated its
    // surface; one delayed retry covers that ordering without polling.
    setTimeout(() => void recoverDock(), 1600);
  }, 300);
}

async function refreshHostConfig() {
  try {
    await applyDockConfig(await getJson(`${backendUrl}/api/config`));
    // Keep auxiliary Electron windows on the same wallpaper-derived accent
    // colour as the Dock, even when the wallpaper is changed at runtime.
    try { voiceService?.setTheme((await getJson(`${backendUrl}/api/state`)).wallpaper?.seed); } catch {}
    backendFailures = 0;
  } catch {
    if (++backendFailures >= 3) void restartBackend('健康检查连续失败');
    return;
  }
  try {
    const actions = await getJson(`${backendUrl}/api/host-actions`);
    if (actions.includes('recoverDock')) void recoverDock();
    if (actions.includes('recoverHotkey')) restartHotkeyHelper('设置');
    if (actions.includes('restart')) { app.relaunch(); app.exit(0); }
  } catch {}
}

async function waitForBackend() {
  // Python can legitimately need more than 15 seconds after a cold restart
  // (imports, desktop enumeration and media initialization).  Do not give up
  // before its ready file and local health endpoint agree.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      if (!readyFile || !fs.existsSync(readyFile)) throw new Error('not ready');
      const { port } = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
      backendUrl = `http://127.0.0.1:${Number(port)}`;
      if (await probe(`${backendUrl}/api/state`)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Python sidecar did not become ready within 45 seconds.');
}

function startBackend() {
  const python = pythonCommand();
  readyFile = path.join(app.getPath('userData'), 'backend-ready.json');
  try { fs.unlinkSync(readyFile); } catch {}
  const child = spawn(python, [BACKEND, BACKEND_ROOT], {
    cwd: BACKEND_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STAGE_SHELL_READY_FILE: readyFile, STAGE_SHELL_APP_NAME: APP_NAME },
  });
  backend = child;
  child.stdout.on('data', (data) => console.log(`[backend] ${data}`));
  child.stderr.on('data', (data) => console.error(`[backend] ${data}`));
  child.once('exit', (code) => {
    if (backend === child) backend = undefined;
    if (!app.isQuitting) {
      console.error(`${APP_NAME} backend exited (${code}).`);
      setTimeout(() => void restartBackend(`后端退出 (${code})`), 1200);
    }
  });
}

async function restartBackend(reason = '手动重启') {
  if (restartingBackend || app.isQuitting) return;
  restartingBackend = true;
  try {
    const previous = backend;
    backend = undefined;
    if (previous && !previous.killed) {
      // The project Python launcher can own an inner uv Python process. Kill
      // only this known child tree so a stale server cannot retain port 7799.
      previous.intentionalStop = true;
      spawnSync('taskkill.exe', ['/PID', String(previous.pid), '/T', '/F'], { windowsHide: true });
    }
    backendUrl = undefined;
    startBackend();
    await waitForBackend();
    await resetVoiceCapture('后端重启后重新初始化麦克风');
    await reloadVoiceEditor();
    try { voiceService?.setTheme((await getJson(`${backendUrl}/api/state`)).wallpaper?.seed); } catch {}
    // Use exactly the same recreate-and-position sequence as clicking the
    // tray icon. Re-reserving an existing HWND can leave Electron's DIP
    // bounds stale and shift the Dock after a backend restart.
    await recoverDock();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.loadURL(`${backendUrl}/settings`).catch((error) => console.error('Settings reload failed:', error));
    }
    backendFailures = 0;
    console.log(`${APP_NAME} backend restarted: ${reason}`);
  } catch (error) {
    console.error(`${APP_NAME} backend restart failed (${reason}):`, error);
  } finally {
    restartingBackend = false;
  }
}

async function createSidebar(initialConfig) {
  const width = Math.max(120, Math.min(900, Number(initialConfig.BAR_W) || 300));
  sidebar = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height: screen.getPrimaryDisplay().workArea.height,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    title: APP_NAME,
    skipTaskbar: true,
    resizable: false,
    // The Dock must remain a visible native surface even while Chromium is
    // restoring after display sleep; do not gate visibility on renderer load.
    show: true,
    backgroundColor: '#1b1b1b',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  sidebar.setAlwaysOnTop(true, 'screen-saver');
  sidebar.webContents.on('render-process-gone', (_event, details) => {
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'sidebar-renderer-error.txt'), JSON.stringify(details)); } catch {}
  });
  const sidebarHwnd = hwndOf(sidebar);
  // The backend uses this only to filter its own Dock window during Win32
  // enumeration.  It travels through the same localhost Web API as all UI
  // communication; no Electron IPC or renderer bridge is involved.
  void postCommand('setOwnWindow', [sidebarHwnd]).catch(() => {});
  await applyDockConfig(initialConfig, true);
  positionSidebarInReservedCoordinates(initialConfig);
  sidebar.loadURL(`${backendUrl}/`).catch((error) => console.error('Dock load failed:', error));
  sidebar.webContents.once('did-finish-load', () => syncWindowDevTools(sidebar));
  // A monitor sleep/reconnect can prevent Electron from emitting
  // ready-to-show for a recreated offscreen window. Show the native surface
  // immediately; page readiness must never be allowed to hide the Dock.
  sidebar.showInactive();
  sidebar.once('ready-to-show', () => {
    sidebar.show();
    sidebar.setAlwaysOnTop(true, 'screen-saver');
    sidebar.moveTop();
    // Some Windows sessions retain a stale top-most ordering after a display
    // sleep.  Activate once when creating the Dock to rebuild that ordering;
    // later configuration and state refreshes remain non-activating.
    sidebar.focus();
  });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    title: `${APP_NAME} 设置`,
    width: 760,
    height: 820,
    minWidth: 580,
    minHeight: 560,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1b1b1b',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  settingsWindow.loadURL(`${backendUrl}/settings`);
  settingsWindow.webContents.once('did-finish-load', () => syncWindowDevTools(settingsWindow));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.once('closed', () => { settingsWindow = undefined; });
}

async function createTray() {
  // In development the executable already carries Electron's official icon.
  // Asking Windows for that resource produces a real tray bitmap, unlike SVG
  // data URLs which some notification-area hosts render as a blank square.
  const icon = await app.getFileIcon(process.execPath, { size: 'small' });
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开设置', click: openSettings },
    { label: '重启后端与侧边栏', click: () => void restartBackend() },
    { label: `完整重启 ${APP_NAME}`, click: () => { app.relaunch(); app.quit(); } },
    { label: '重新挂钩 CapsLock', click: () => restartHotkeyHelper() },
    { label: '恢复 Dock', click: () => void recoverDock() },
    { type: 'separator' },
    { role: 'quit', label: '退出' },
  ]));
  tray.on('click', () => void recoverDock());
}

app.whenReady().then(async () => {
  try {
    appBarHandleFile = path.join(app.getPath('userData'), 'appbar-hwnd.txt');
    appBarReadyFile = path.join(app.getPath('userData'), 'appbar-host-ready.json');
    removePreviousAppBar();
    await startNativeCore();
    await startVoiceCore();
    forceCapsOff();
    startHotkeyHelper();
    startBackend();
    await waitForBackend();
    try { voiceService.setTheme((await getJson(`${backendUrl}/api/state`)).wallpaper?.seed); } catch {}
    createVoiceOverlay();
    createVoiceEditor();
    await syncHostTheme();
    nativeTheme.on('updated', () => void syncHostTheme());
    // The global Electron menu bar is intentionally absent. It used to add a
    // “设置” menu to every native window, including the plain CodeMirror
    // editor. Settings and recovery actions remain available from the tray.
    Menu.setApplicationMenu(null);
    await createTray();
    const initialConfig = await getJson(`${backendUrl}/api/config`);
    await createSidebar(initialConfig);
    scheduleInitialHotkeyRecovery();
    setInterval(() => void refreshHostConfig(), 1000);
    void refreshHostConfig();
    powerMonitor.on('resume', scheduleDockRecovery);
    powerMonitor.on('unlock', scheduleDockRecovery);
    screen.on('display-added', scheduleDockRecovery);
    screen.on('display-removed', scheduleDockRecovery);
  } catch (error) {
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'startup-error.txt'), String(error.stack || error)); } catch {}
    dialog.showErrorBox(APP_NAME, String(error.message || error));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (!rebuildingDock) app.quit();
});
app.on('before-quit', () => {
  app.isQuitting = true;
  try { hotkeyHelper?.kill(); } catch {}
  try { nativeCoreProcess?.kill(); } catch {}
  forceCapsOff();
  stopAppBarHost();
  try { fs.unlinkSync(appBarHandleFile); } catch {}
  tray?.destroy();
  try { voiceCapture?.destroy(); } catch {}
  try { voiceOverlay?.destroy(); } catch {}
  try { voiceEditor?.destroy(); } catch {}
  try { voiceService?.stop(); } catch {}
  try { hotkeyHelper?.kill(); } catch {}
  if (backend && !backend.killed) backend.kill();
});
