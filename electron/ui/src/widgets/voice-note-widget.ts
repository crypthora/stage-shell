import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import richEditor from 'codemirror-rich-markdoc/src/index.ts';
import { BaseWidget } from './base.js';
import { widgetCommand } from '../bridge.js';

type VoiceNoteState = { line?: number; startLine?: number; headings?: string[]; text?: string; truncated?: boolean };
const DEFAULT_PREVIEW_HEIGHT = 176;
const MIN_PREVIEW_HEIGHT = 56;
const MAX_PREVIEW_HEIGHT = 420;
const HEIGHT_KEY = 'stage-shell.voice-note.preview-height';

class TaskBox extends WidgetType {
  constructor(private readonly line: number, private readonly checked: boolean, private readonly toggle: (line: number) => void) { super(); }
  eq(other: TaskBox) { return this.line === other.line && this.checked === other.checked; }
  toDOM() {
    const box = document.createElement('span');
    box.className = `material-symbols-outlined cm-note-task ${this.checked ? 'checked' : ''}`;
    box.textContent = this.checked ? 'check_box' : 'check_box_outline_blank';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成');
    box.addEventListener('mousedown', (event) => event.preventDefault());
    box.addEventListener('click', (event) => { event.stopPropagation(); this.toggle(this.line); });
    return box;
  }
  ignoreEvent() { return false; }
}

function noteDecorations(text: string, startLine: number, toggle: (line: number) => void) {
  const builder = new RangeSetBuilder<Decoration>();
  let offset = 0;
  for (const [index, line] of text.split('\n').entries()) {
    const task = /^(\s*[-*+]\s+\[([ xX])\]\s+)/.exec(line);
    const heading = /^(\s{0,3}#{1,6}\s+)/.exec(line);
    if (task) {
      // Replace the entire GFM task prefix (`- [ ] `) so rich-markdoc does
      // not render its own bullet in addition to our interactive checkbox.
      builder.add(offset, offset + task[1].length, Decoration.replace({ widget: new TaskBox(startLine + index, task[2].toLowerCase() === 'x', toggle), inclusive: true }));
    } else if (heading) {
      builder.add(offset, offset + heading[1].length, Decoration.replace({}));
      builder.add(offset + heading[1].length, offset + line.length, Decoration.mark({ class: 'cm-note-heading' }));
    }
    offset += line.length + 1;
  }
  return builder.finish();
}

@customElement('widget-voice-note')
export class VoiceNoteWidget extends BaseWidget {
  static widgetId = 'voice-note';
  static widgetTitle = '语音便笺';
  static widgetIcon = 'bookmark';
  private view?: EditorView;
  private previewText = '';
  private previewStartLine = 1;
  private previewHeight = DEFAULT_PREVIEW_HEIGHT;
  private resizing = false;

  static styles = css`
    :host { display:block; overflow:hidden; background:var(--md-sys-color-surface-container, #211f26); border-radius:16px; color:var(--md-sys-color-on-surface, #e8e1e9); }
    .note { overflow:hidden; cursor:pointer; }
    .head { min-width:0; padding:10px 12px 5px; overflow:hidden; color:var(--md-sys-color-primary, #d0bcff); font-size:12px; text-align:left; }
    .crumbs { display:block; overflow:hidden; white-space:nowrap; text-align:left; }
    .crumbs-inner { display:inline; white-space:nowrap; }
    .crumb-segment { display:inline; vertical-align:baseline; }
    .crumb-segment + .crumb-segment::before { content:'chevron_right'; display:inline-block; margin:0 2px; font-family:'Material Symbols Outlined'; font-size:15px; line-height:1; vertical-align:-2px; opacity:.8; }
    #preview { width:100%; overflow:hidden; }
    .resize-handle { height:10px; margin-top:-10px; position:relative; z-index:2; cursor:ns-resize; touch-action:none; }
    .resize-handle::after { content:''; position:absolute; left:50%; top:5px; width:30px; height:3px; border-radius:3px; transform:translateX(-50%); background:var(--md-sys-color-outline-variant, #49454f); opacity:.75; }
    .resize-handle:hover::after, .resize-handle:active::after { background:var(--md-sys-color-primary, #d0bcff); opacity:1; }
    .empty { padding:2px 12px 12px; color:var(--md-sys-color-on-surface-variant, #cac4d0); font:13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
  `;

  disconnectedCallback() { this.view?.destroy(); this.view = undefined; super.disconnectedCallback(); }
  connectedCallback() {
    super.connectedCallback();
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    if (Number.isFinite(saved)) this.previewHeight = Math.max(MIN_PREVIEW_HEIGHT, Math.min(MAX_PREVIEW_HEIGHT, saved));
  }

  private toggleTask(line: number) { void widgetCommand('voice-note', 'toggle_task', { line }); }
  private openEditor() { void widgetCommand('voice-note', 'open_editor'); }

  private createPreview(text: string, startLine: number) {
    const parent = this.renderRoot.querySelector<HTMLElement>('#preview');
    if (!parent) return;
    this.view?.destroy();
    this.previewText = text;
    this.previewStartLine = startLine;
    this.view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          richEditor({ markdoc: {} }),
          EditorView.decorations.of(noteDecorations(text, startLine, (line) => this.toggleTask(line))),
          EditorView.domEventHandlers({
            mousedown: (event, editor) => this.handleTaskLineEvent(event, editor),
            click: (event, editor) => this.handleTaskLineEvent(event, editor),
          }),
          EditorView.theme({
            '&': { height: `${this.previewHeight}px`, backgroundColor: 'transparent', color: 'inherit', font: '13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif' },
            '.cm-scroller': { overflow: 'hidden', padding: '2px 12px 12px', fontFamily: 'inherit', lineHeight: 'inherit' },
            '.cm-content': { padding: '0' },
            '.cm-line': { padding: '0' },
            '.cm-note-heading': { fontWeight: '700' },
            '.cm-markdoc-hidden': { display: 'none' },
            '.cm-markdoc-bullet *': { display: 'none' },
            '.cm-markdoc-bullet::after': { display: 'inline !important', content: "'•'", color: 'var(--md-sys-color-on-surface-variant, #cac4d0)' },
            '.cm-note-task': { display: 'inline-block', width: '19px', height: '19px', margin: '0 6px 0 0', color: 'var(--md-sys-color-on-surface-variant, #cac4d0)', fontFamily: 'Material Symbols Outlined', fontSize: '19px', lineHeight: '19px', verticalAlign: '-4px', cursor: 'pointer' },
            '.cm-note-task.checked': { color: 'var(--md-sys-color-primary, #d0bcff)' },
          }),
        ],
      }),
      parent,
    });
    this.applyPreviewHeight();
  }

  private handleTaskLineEvent(event: MouseEvent, editor: EditorView) {
    if ((event.target as HTMLElement).closest('.cm-note-task')) return false;
    const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const line = editor.state.doc.lineAt(pos);
    if (!/^\s*[-*+]\s+\[([ xX])\]\s+/.test(line.text)) return false;
    event.preventDefault();
    event.stopPropagation();
    this.toggleTask(this.previewStartLine + line.number - 1);
    return true;
  }

  private applyPreviewHeight() {
    if (this.view) this.view.dom.style.height = `${this.previewHeight}px`;
    const preview = this.renderRoot.querySelector<HTMLElement>('#preview');
    if (preview) preview.style.height = `${this.previewHeight}px`;
  }

  private startResize(event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const initial = this.previewHeight;
    this.resizing = true;
    const move = (next: PointerEvent) => {
      this.previewHeight = Math.max(MIN_PREVIEW_HEIGHT, Math.min(MAX_PREVIEW_HEIGHT, initial + next.clientY - startY));
      this.applyPreviewHeight();
    };
    const finish = () => {
      this.resizing = false;
      localStorage.setItem(HEIGHT_KEY, String(this.previewHeight));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  }

  protected updated() {
    const s = (this.state || {}) as VoiceNoteState;
    const text = String(s.text || '');
    const startLine = Number.isInteger(s.startLine) && s.startLine! > 0 ? s.startLine! : (s.line || 1);
    if (!text) { this.view?.destroy(); this.view = undefined; return; }
    if (!this.view || text !== this.previewText || startLine !== this.previewStartLine) this.createPreview(text, startLine);
    else this.applyPreviewHeight();
  }

  render() {
    const s = (this.state || {}) as VoiceNoteState;
    const text = String(s.text || '');
    const headings = Array.isArray(s.headings) ? s.headings.map(String).filter(Boolean) : [];
    return html`<div class="note" @click=${() => { if (!this.resizing) this.openEditor(); }}><div class="head"><span class="crumbs"><span class="crumbs-inner">${headings.length ? headings.map((heading) => html`<span class="crumb-segment">${heading}</span>`) : html`<span class="crumb-segment">语音便笺</span>`}</span></span></div>${text ? html`<div id="preview"></div><div class="resize-handle" title="拖动调整便笺高度" @pointerdown=${this.startResize}></div>` : html`<div class="empty">此断点后暂无内容</div>`}</div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'widget-voice-note': VoiceNoteWidget; } }
