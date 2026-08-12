import { Compartment, EditorState } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
// The upstream repository does not publish its declared dist entry. Importing
// its TypeScript source lets Vite bundle the same plugin reproducibly.
import richEditor from 'codemirror-rich-markdoc/src/index.ts';
import 'material-symbols/outlined.css';

const API = 'http://127.0.0.1:7798/v1/voice/editor';
let saveTimer: number | undefined;
let revision = 0;
const themeCompartment = new Compartment();
const breakpointCompartment = new Compartment();

class EditorTaskBox extends WidgetType {
  constructor(private readonly statePos: number, private readonly checked: boolean, private readonly toggle: (statePos: number, checked: boolean) => void) { super(); }
  eq(other: EditorTaskBox) { return this.statePos === other.statePos && this.checked === other.checked; }
  toDOM() {
    const box = document.createElement('span');
    box.className = `material-symbols-outlined cm-editor-task ${this.checked ? 'checked' : ''}`;
    box.textContent = this.checked ? 'check_box' : 'check_box_outline_blank';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成');
    box.addEventListener('mousedown', (event) => event.preventDefault());
    box.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.toggle(this.statePos, this.checked); });
    return box;
  }
  ignoreEvent() { return false; }
}

function editorTaskDecorations(view: EditorView) {
  const ranges = [];
  for (let number = 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number);
    // GitHub-Flavored Markdown task syntax: `- [ ] text` / `- [x] text`.
    // Replace the whole prefix so rich-markdoc cannot also emit a list bullet.
    const task = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)/.exec(line.text);
    if (!task) continue;
    const statePos = line.from + task[1].length;
    ranges.push(Decoration.replace({ widget: new EditorTaskBox(statePos, task[2].toLowerCase() === 'x', (at, checked) => {
      view.dispatch({ changes: { from: at, to: at + 1, insert: checked ? ' ' : 'x' } });
    }) }).range(line.from, line.from + task[0].length));
  }
  return Decoration.set(ranges, true);
}

const editorTaskControls = ViewPlugin.fromClass(class {
  decorations;
  constructor(view: EditorView) { this.decorations = editorTaskDecorations(view); }
  update(update: { docChanged: boolean; view: EditorView }) { if (update.docChanged) this.decorations = editorTaskDecorations(update.view); }
}, { decorations: (plugin) => plugin.decorations });
function editorTheme(seed: string, preference: string) {
  const dark = preference === 'dark' || (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const accent = /^#[0-9a-f]{6}$/i.test(seed) ? seed : '#4aa3ff';
  const surface = dark ? '#171a1f' : '#f7f9fc';
  const text = dark ? '#e8edf5' : '#1b1d22';
  const muted = dark ? '#aeb8c7' : '#5c6573';
  const selection = dark ? `${accent}66` : `${accent}4d`;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--surface', surface);
  document.documentElement.style.setProperty('--titlebar', dark ? '#20242b' : '#ffffff');
  document.documentElement.style.setProperty('--title-text', text);
  document.documentElement.style.setProperty('--active-title', dark ? '#3a351d' : '#fff8db');
  return EditorView.theme({
    '&': { height: '100%', backgroundColor: surface, color: text, fontSize: '18px' },
    // The editor is the complete client area. Keep no shell gutter around it:
    // clicking anywhere below the native title bar must still land in
    // CodeMirror instead of blurring the active text selection.
    '.cm-scroller': { fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif', lineHeight: '1.7', padding: '0' },
    '.cm-content': { padding: '0', caretColor: accent },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: accent },
    '.cm-selectionBackground, ::selection': { backgroundColor: `${selection} !important` },
    '.cm-activeLine': { backgroundColor: dark ? '#ffffff08' : '#00000005' },
    '.cm-gutters': { backgroundColor: surface, color: muted, borderRight: `1px solid ${dark ? '#ffffff18' : '#00000012'}` },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '42px', padding: '0 8px 0 10px', cursor: 'pointer' },
    '.cm-line': { color: text },
    '.ͼb': { color: muted },
    '.cm-markdoc-hidden': { display: 'none' },
    '.cm-markdoc-bullet *': { display: 'none' },
    '.cm-markdoc-bullet::after': { display: 'inline !important', color: muted, content: "'•'" },
    '.cm-editor-task': { display: 'inline-block', width: '21px', height: '21px', margin: '0 7px 0 0', color: muted, fontSize: '21px', lineHeight: '21px', verticalAlign: '-4px', cursor: 'pointer' },
    '.cm-editor-task.checked': { color: accent },
  }, { dark });
}

function breakpointGutter(line: number | null, toggle: (line: number) => void) {
  return lineNumbers({
    formatNumber: (value) => value === line ? `● ${value}` : String(value),
    domEventHandlers: {
      mousedown: (view, gutterLine) => {
        // Gutter callbacks receive a BlockInfo (document position), not a
        // document line object.  Reading `.number` here silently produced
        // undefined and made every click a no-op.
        toggle(view.state.doc.lineAt(gutterLine.from).number);
        return true;
      },
    },
  });
}

function save(text: string) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void fetch(`${API}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  }, 120);
}

function reportFocus(focused: boolean) {
  document.body.classList.toggle('active', focused);
  void fetch(`${API}/focus`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ focused }),
  }).catch(() => {});
}

function setupWindowControls() {
  const menu = document.querySelector<HTMLElement>('#window-menu-wrap');
  const menuButton = document.querySelector<HTMLButtonElement>('#window-menu-button');
  menuButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !menu?.classList.contains('open');
    menu?.classList.toggle('open', open);
    menuButton.setAttribute('aria-expanded', String(open));
  });
  document.querySelector<HTMLButtonElement>('#center-window')?.addEventListener('click', () => {
    menu?.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
    void fetch(`${API}/center`, { method: 'POST' });
  });
  document.querySelector<HTMLButtonElement>('#close-window')?.addEventListener('click', () => {
    // This window is deliberately kept alive by the host.  Closing it must
    // update the service state first, otherwise the next CapsLock short press
    // toggles a stale "visible" flag instead of reopening the editor.
    void fetch(`${API}/close`, { method: 'POST' });
  });
  document.addEventListener('click', () => {
    menu?.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
  });
}

async function boot() {
  setupWindowControls();
  let initial = '';
  let breakpointLine: number | null = 1;
  try {
    const response = await fetch(`${API}/document`, { cache: 'no-store' });
    const payload = await response.json();
    initial = String(payload.text || '');
    revision = Number(payload.revision) || 0;
  } catch {}
  try {
    const response = await fetch(`${API}/breakpoint`, { cache: 'no-store' });
    const payload = await response.json();
    breakpointLine = Number.isInteger(payload.line) && payload.line > 0 ? payload.line : null;
  } catch {}

  let currentSeed = '#4aa3ff';
  let currentPreference = 'system';
  let view!: EditorView;
  const toggleBreakpoint = async (line: number) => {
    const next = breakpointLine === line ? null : line;
    try {
      const response = await fetch(`${API}/breakpoint`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line: next }),
      });
      const payload = await response.json();
      breakpointLine = Number.isInteger(payload.line) && payload.line > 0 ? payload.line : null;
      view.dispatch({ effects: breakpointCompartment.reconfigure(breakpointGutter(breakpointLine, (target) => void toggleBreakpoint(target))) });
    } catch {}
  };
  view = new EditorView({
    state: EditorState.create({
      doc: initial,
      extensions: [
        history(),
        // Rich Markdoc hides normal Markdown syntax away from the active
        // cursor and renders headings, lists, links and inline emphasis as
        // formatted content while preserving the original Markdown document.
        richEditor({ markdoc: {} }),
        editorTaskControls,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        breakpointCompartment.of(breakpointGutter(breakpointLine, (line) => void toggleBreakpoint(line))),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          save(update.state.doc.toString());
        }),
        themeCompartment.of(editorTheme(currentSeed, currentPreference)),
      ],
    }),
    parent: document.querySelector('#editor')!,
  });
  view.focus();
  window.addEventListener('focus', () => reportFocus(true));
  window.addEventListener('blur', () => reportFocus(false));
  window.addEventListener('pagehide', () => reportFocus(false));
  reportFocus(document.hasFocus());

  const syncTheme = async () => {
    try {
      const state = await fetch('http://127.0.0.1:7798/v1/voice/state', { cache: 'no-store' }).then((r) => r.json());
      const nextSeed = String(state.theme || '#4aa3ff');
      const nextPreference = String(state.config?.editorTheme || 'system');
      if (nextSeed !== currentSeed || nextPreference !== currentPreference) {
        currentSeed = nextSeed;
        currentPreference = nextPreference;
        view.dispatch({ effects: themeCompartment.reconfigure(editorTheme(currentSeed, currentPreference)) });
      }
    } catch {}
  };
  void syncTheme();
  window.setInterval(() => void syncTheme(), 1000);

  window.setInterval(async () => {
    try {
      const response = await fetch(`${API}/updates?after=${revision}`, { cache: 'no-store' });
      const payload = await response.json();
      for (const update of payload.updates || []) {
        if (typeof update.document === 'string') {
          const anchor = Math.min(view.state.selection.main.anchor, update.document.length);
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: update.document }, selection: { anchor } });
          continue;
        }
        const selection = view.state.selection.main;
        view.dispatch({ changes: { from: selection.from, to: selection.to, insert: String(update.text || '') }, selection: { anchor: selection.from + String(update.text || '').length } });
      }
      revision = Number(payload.revision) || revision;
    } catch {}
  }, 120);
}

void boot();
