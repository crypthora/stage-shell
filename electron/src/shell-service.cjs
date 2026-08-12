// Electron-owned local Web API for every renderer.  It retains one portable
// HTTP contract without a separate runtime.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const DEFAULT_CONFIG = Object.freeze({
  BAR_W: 280, DOCK_SIDE: 'right', RESERVE_SPACE: true, SHOW_THUMBNAIL: true,
  DESKTOP_PAGER_MODE: 'preview', WIDGETS_ENABLED: true,
  WIDGETS: [{ id: 'voice-note', enabled: true }], WALLPAPER_ENABLED: false,
  WALLPAPER_PATH: '', WALLPAPER_ALPHA: 0.15, MOUSE_LEAVE_RESET_TAB: false,
  ROLES: [], INNER_PAD: 8,
});

function json(res, code, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

class ShellService {
  constructor({ userData, uiRoot, voiceService, onCommand }) {
    this.userData = userData;
    this.uiRoot = uiRoot;
    this.voiceService = voiceService;
    this.onCommand = onCommand;
    this.configFile = path.join(userData, 'shell-config.json');
    this.config = { ...DEFAULT_CONFIG };
    try { Object.assign(this.config, JSON.parse(fs.readFileSync(this.configFile, 'utf8'))); } catch {}
    this.server = http.createServer((req, res) => void this.route(req, res));
    this.port = 0;
  }
  start() { return new Promise((resolve, reject) => this.server.listen(7799, '127.0.0.1', (error) => error ? reject(error) : (this.port = 7799, resolve()))); }
  stop() { this.server.close(); }
  saveConfig(update) {
    if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('settings must be an object');
    this.config = { ...this.config, ...update };
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    return this.config;
  }
  state() {
    const voice = this.voiceService?.state?.() || {};
    const draft = this.voiceService?.readDraft?.() || '';
    const breakpoint = Number(this.voiceService?.breakpointLine) || 1;
    const preview = draft.split('\n').slice(Math.max(0, breakpoint - 1)).join('\n');
    return {
      clock: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      media: { active: false, title: '', artist: '', isPlaying: false, cover: null },
      cards: [], staged: [], desktops: { active: 0, cols: 2, items: [] },
      voice: { visible: !!voice.recording, mode: voice.recording ? 'listening' : 'idle', text: voice.overlay?.text || '' },
      wallpaper: {
        url: this.config.WALLPAPER_ENABLED && this.config.WALLPAPER_PATH && fs.existsSync(this.config.WALLPAPER_PATH)
          ? `http://127.0.0.1:${this.port}/asset/wallpaper` : null,
        seed: voice.theme || '#4aa3ff', alpha: Number(this.config.WALLPAPER_ALPHA) || 0,
      },
      widgets: { 'voice-note': { startLine: breakpoint, text: preview, headings: ['语音便笺'] } },
      widgetOrder: Array.isArray(this.config.WIDGETS) ? this.config.WIDGETS : [],
      widgetsEnabled: this.config.WIDGETS_ENABLED !== false,
      allWidgets: [{ id: 'voice-note', title: '语音便笺', icon: 'bookmark' }],
      roles: Array.isArray(this.config.ROLES) ? this.config.ROLES : [],
      mouseLeaveReset: !!this.config.MOUSE_LEAVE_RESET_TAB,
      systemTheme: null,
    };
  }
  serveStatic(res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname === '/settings' || pathname === '/settings/' ? 'settings.html' : pathname.replace(/^\/+/, '');
    const root = path.resolve(this.uiRoot);
    const full = path.resolve(root, relative);
    if (!full.startsWith(root + path.sep) && full !== root) return json(res, 403, { error: 'forbidden' });
    let file = full;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) return json(res, 503, { error: 'UI is not built' });
    const body = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(body);
  }
  async command(name, args) {
    if (name === 'ready') return true;
    if (name === 'widgetCommand') {
      const [widget, action, kwargs = {}] = args;
      if (widget === 'voice-note' && action === 'toggle_task') return this.voiceService.toggleDraftTask(Number(kwargs.line));
      if (widget === 'voice-note' && action === 'open_editor') return this.voiceService.showEditor();
      return false;
    }
    if (name === 'setHostTheme') return true;
    if (name === 'restartDock' || name === 'recoverCapsHotkey' || name === 'setOwnWindow') return this.onCommand(name, args);
    if (name === 'getConfig') return this.config;
    if (name === 'saveConfig') return this.saveConfig(args[0] || {});
    return this.onCommand(name, args);
  }
  async route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, this.state());
      if (req.method === 'GET' && url.pathname === '/asset/wallpaper') {
        const file = this.config.WALLPAPER_PATH;
        if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'wallpaper not found' });
        const bytes = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
        return res.end(bytes);
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, this.config);
      if (req.method === 'POST' && url.pathname === '/api/config') return json(res, 200, { ok: true, config: this.saveConfig(JSON.parse((await requestBody(req)).toString() || '{}')) });
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const data = JSON.parse((await requestBody(req)).toString() || '{}');
        return json(res, 200, { ok: true, result: await this.command(String(data.command || ''), Array.isArray(data.args) ? data.args : []) });
      }
      if (req.method === 'POST' && url.pathname === '/api/wallpaper') {
        const raw = await requestBody(req);
        if (!raw.length || raw.length > 40 * 1024 * 1024) return json(res, 400, { ok: false, error: 'bad wallpaper size' });
        const file = path.join(this.userData, 'wallpaper.png');
        fs.writeFileSync(file, raw);
        this.saveConfig({ WALLPAPER_PATH: file, WALLPAPER_ENABLED: true });
        return json(res, 200, { ok: true, path: file });
      }
      if (req.method === 'POST' && url.pathname === '/api/wallpaper/clear') { this.saveConfig({ WALLPAPER_PATH: '', WALLPAPER_ENABLED: false }); return json(res, 200, { ok: true }); }
      return this.serveStatic(res, url.pathname);
    } catch (error) { return json(res, 500, { ok: false, error: String(error.message || error) }); }
  }
}

module.exports = { ShellService, DEFAULT_CONFIG };
