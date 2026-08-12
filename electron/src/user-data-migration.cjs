// One-time handoff from the predecessor Electron application.  The new
// product owns `%APPDATA%/stage-shell`; this only preserves this user's
// already-created document and settings when moving to that new identity.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VOICE_FILES = ['voice-core.json', 'voice-draft.txt', 'voice-breakpoint.json', 'voice-editor-window.json'];
const SHELL_KEYS = new Set(['BAR_W', 'DOCK_SIDE', 'RESERVE_SPACE', 'SHOW_THUMBNAIL', 'DESKTOP_PAGER_MODE', 'WIDGETS_ENABLED', 'WIDGETS', 'WALLPAPER_ENABLED', 'WALLPAPER_PATH', 'WALLPAPER_ALPHA', 'MOUSE_LEAVE_RESET_TAB', 'ROLES', 'INNER_PAD']);

function readLegacyShellConfig(legacyDir) {
  // The predecessor persisted its settings in Chromium's HTTP cache. Search
  // the small cache records only and accept a complete JSON object containing
  // the known Dock width key; never reuse Chromium profile data wholesale.
  const cacheDir = path.join(legacyDir, 'Cache', 'Cache_Data');
  let entries = [];
  try { entries = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(cacheDir, entry.name);
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
      const text = fs.readFileSync(file, 'utf8');
      const start = text.indexOf('{"ROOT_BG"');
      if (start < 0) continue;
      for (let end = start + 1, depth = 1, quote = false, escape = false; end < text.length; end += 1) {
        const ch = text[end];
        if (quote) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') quote = false; continue; }
        if (ch === '"') { quote = true; continue; }
        if (ch === '{') depth += 1;
        if (ch === '}' && --depth === 0) {
          const raw = JSON.parse(text.slice(start, end + 1));
          const clean = Object.fromEntries(Object.entries(raw).filter(([key]) => SHELL_KEYS.has(key)));
          return Object.keys(clean).length ? clean : null;
        }
      }
    } catch {}
  }
  return null;
}

function migrateUserData(userData) {
  const marker = path.join(userData, 'migrated-from-outputs-electron-v1');
  if (fs.existsSync(marker)) return;
  const legacy = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'outputs-electron');
  try {
    for (const name of VOICE_FILES) {
      const target = path.join(userData, name);
      const source = path.join(legacy, name);
      if (!fs.existsSync(target) && fs.existsSync(source)) fs.copyFileSync(source, target);
    }
    const shellFile = path.join(userData, 'shell-config.json');
    if (!fs.existsSync(shellFile)) {
      const settings = readLegacyShellConfig(legacy);
      if (settings) fs.writeFileSync(shellFile, JSON.stringify(settings, null, 2));
    }
  } finally {
    // The marker prevents further reads from old cache/profile data. All later
    // reads and writes use only the stage-shell directory.
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
  }
}

module.exports = { migrateUserData };
