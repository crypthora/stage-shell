// widget-panel.ts —— 可配置 Widget 容器：支持排序、增删、实时更新。
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { State, WidgetCfg, WidgetMeta } from '../state.js';
import { saveConfig } from '../bridge.js';

// ── Widget 导入（新增 widget 只需在这里加一行 import + 注册）──
import '../widgets/clock-widget.js';
import '../widgets/media-widget.js';
import '../widgets/sysmon-widget.js';
import '../widgets/pomo-widget.js';
import '../widgets/netspeed-widget.js';
import '../widgets/voice-note-widget.js';

// ── 渲染器注册表：id → 给定 state slice 生成 TemplateResult ──
type Renderer = (widgetState: unknown) => TemplateResult;
const RENDERERS: Record<string, Renderer> = {
  clock:    (s) => html`<widget-clock    .state=${s}></widget-clock>`,
  media:    (s) => html`<widget-media    .state=${s}></widget-media>`,
  sysmon:   (s) => html`<widget-sysmon   .state=${s}></widget-sysmon>`,
  pomo:     (s) => html`<widget-pomo     .state=${s}></widget-pomo>`,
  netspeed: (s) => html`<widget-netspeed .state=${s}></widget-netspeed>`,
  'voice-note': (s) => html`<widget-voice-note .state=${s}></widget-voice-note>`,
};

// 内置 widget 的 state 从 root State 字段取，而不是 state.widgets[id]
const BUILTIN_STATE: Record<string, (s: State) => unknown> = {
  clock: (s) => ({ time: s.clock }),
  media: (s) => s.media,
};

function getWidgetState(id: string, appState: State): unknown {
  const fn = BUILTIN_STATE[id];
  return fn ? fn(appState) : (appState?.widgets?.[id] ?? {});
}

// 默认排布（本地服务首帧未到达时的占位）
const DEFAULT_ORDER: WidgetCfg[] = [
  { id: 'clock', enabled: true },
  { id: 'media', enabled: true },
];

@customElement('widget-panel')
export class WidgetPanel extends LitElement {
  @property({ attribute: false }) state!: State;

  @state() private _editMode = false;
  @state() private _addOpen = false;
  @state() private _dragOver: string | null = null;
  private _dragId: string | null = null;

  /** Entered by the shell's right-click menu; keeps editing out of the normal UI. */
  enterEditMode() {
    this._editMode = true;
    this._addOpen = false;
  }

  get editing(): boolean { return this._editMode; }

  exitEditMode() {
    this._editMode = false;
    this._addOpen = false;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      /* Strictly content-sized. This panel deliberately never becomes a
         scroll region; its position and remaining space belong to app-root. */
      height: auto;
      max-height: none;
      padding: 5px 6px;
      box-sizing: border-box;
      gap: 4px;
      overflow: visible;
    }

    /* ── 底部编辑按钮 ── */
    .edit-toggle {
      align-self: flex-end;
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      color: var(--md-sys-color-on-surface-variant);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.6;
      transition: opacity .15s, background .15s;
      flex: 0 0 auto;
    }
    .edit-toggle:hover { opacity: 1; background: var(--md-sys-color-surface-container-high, #2b2930); }

    /* ── Widget 外壳 ── */
    .wcard {
      position: relative;
      flex: 0 0 auto;
      border-radius: 16px;
      min-width: 0;
      overflow: hidden;
      width: 100%;
      box-sizing: border-box;
    }
    .wcard.drag-over { outline: 2px solid var(--md-sys-color-primary, #d0bcff); outline-offset: 2px; }
    .wcard[draggable='true'] { cursor: grab; }
    .wcard[draggable='true']:active { cursor: grabbing; }

    /* 编辑模式覆盖层 */
    .edit-bar {
      position: absolute;
      top: 6px;
      left: 6px;
      right: 6px;
      z-index: 2;
      display: flex;
      justify-content: space-between;
      align-items: center;
      pointer-events: none;
    }
    .edit-bar > * { pointer-events: auto; }
    .drag-handle {
      color: var(--md-sys-color-on-surface-variant);
      font-size: 20px;
      opacity: .8;
      cursor: grab;
    }
    .remove-btn {
      --md-icon-button-icon-size: 16px;
      width: 28px; height: 28px;
      background: var(--md-sys-color-error-container, #8c1d18);
      border-radius: 50%;
      color: var(--md-sys-color-on-error-container, #f9dedc);
    }

    /* ── 「添加组件」区域 ── */
    .add-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 10px 14px;
      background: var(--md-sys-color-surface-container, #211f26);
      border: 1.5px dashed var(--md-sys-color-outline-variant, #49454f);
      border-radius: 14px;
      color: var(--md-sys-color-on-surface-variant);
      font-size: 13px;
      cursor: pointer;
      transition: background .15s, border-color .15s;
      flex: 0 0 auto;
    }
    .add-btn:hover {
      background: var(--md-sys-color-surface-container-high, #2b2930);
      border-color: var(--md-sys-color-primary, #d0bcff);
      color: var(--md-sys-color-primary, #d0bcff);
    }
    .add-btn md-icon { font-size: 18px; }

    .add-sheet {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: var(--md-sys-color-surface-container, #211f26);
      border-radius: 14px;
      padding: 6px;
      flex: 0 0 auto;
    }
    .add-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 10px;
      border-radius: 10px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--md-sys-color-on-surface);
      font-size: 13px;
      text-align: left;
      transition: background .12s;
    }
    .add-item:hover { background: var(--md-sys-color-surface-container-high, #2b2930); }
    .add-item md-icon { color: var(--md-sys-color-primary, #d0bcff); font-size: 20px; }
    .add-empty { padding: 10px 12px; font-size: 12px; color: var(--md-sys-color-on-surface-variant); }

    /* ── 背景点击区 ── */
    #bg-tap {
      display: none;
    }

  `;

  // ── 拖拽排序 ──
  private _onDragStart(e: DragEvent, id: string) {
    this._dragId = id;
    e.dataTransfer?.setData('text/plain', id);
    (e.currentTarget as HTMLElement).style.opacity = '0.5';
  }

  private _onDragEnd(e: DragEvent) {
    (e.currentTarget as HTMLElement).style.opacity = '';
    this._dragOver = null;
  }

  private _onDragOver(e: DragEvent, id: string) {
    e.preventDefault();
    this._dragOver = id;
  }

  private _onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    const srcId = this._dragId;
    this._dragId = null;
    this._dragOver = null;
    if (!srcId || srcId === targetId) return;
    const order = [...(this.state?.widgetOrder ?? DEFAULT_ORDER)];
    const si = order.findIndex((w) => w.id === srcId);
    const ti = order.findIndex((w) => w.id === targetId);
    if (si < 0 || ti < 0) return;
    const [item] = order.splice(si, 1);
    order.splice(ti, 0, item);
    saveConfig({ WIDGETS: order });
  }

  // ── 增删操作 ──
  private _removeWidget(id: string) {
    const order = (this.state?.widgetOrder ?? DEFAULT_ORDER).filter((w) => w.id !== id);
    saveConfig({ WIDGETS: order });
  }

  private _addWidget(id: string) {
    const current = this.state?.widgetOrder ?? DEFAULT_ORDER;
    const existing = current.find((w) => w.id === id);
    const order = existing
      ? current.map((w) => (w.id === id ? { ...w, enabled: true } : w))
      : [...current, { id, enabled: true }];
    saveConfig({ WIDGETS: order });
    this._addOpen = false;
  }

  // ── 渲染辅助 ──
  private _renderAddSheet() {
    const all: WidgetMeta[] = this.state?.allWidgets ?? [];
    const currentIds = new Set(
      (this.state?.widgetOrder ?? DEFAULT_ORDER)
        .filter((w) => w.enabled !== false)
        .map((w) => w.id)
    );
    const available = all.filter((m) => !currentIds.has(m.id) && m.id in RENDERERS);

    if (available.length === 0) {
      return html`<div class="add-sheet"><div class="add-empty">所有已知组件均已启用</div></div>`;
    }
    return html`
      <div class="add-sheet">
        ${available.map(
          (m) => html`
            <button class="add-item" @click=${() => this._addWidget(m.id)}>
              <md-icon>${m.icon}</md-icon>
              <span>${m.title}</span>
            </button>
          `
        )}
      </div>
    `;
  }

  render() {
    const s = this.state;
    const order = s?.widgetOrder ?? DEFAULT_ORDER;
    const enabled = order.filter((w) => w.enabled !== false);

    return html`
      ${enabled.map((w) => {
        const renderer = RENDERERS[w.id];
        if (!renderer) return nothing;
        const widgetState = getWidgetState(w.id, s);

        return html`
          <div
            class="wcard ${this._dragOver === w.id ? 'drag-over' : ''}"
            draggable=${this._editMode ? 'true' : 'false'}
            @dragstart=${(e: DragEvent) => this._editMode && this._onDragStart(e, w.id)}
            @dragend=${(e: DragEvent) => this._onDragEnd(e)}
            @dragover=${(e: DragEvent) => this._editMode && this._onDragOver(e, w.id)}
            @dragleave=${() => { if (this._editMode) this._dragOver = null; }}
            @drop=${(e: DragEvent) => this._editMode && this._onDrop(e, w.id)}
          >
            ${this._editMode
              ? html`
                  <div class="edit-bar">
                    <md-icon class="drag-handle">drag_indicator</md-icon>
                    <md-icon-button class="remove-btn" @click=${() => this._removeWidget(w.id)} aria-label="移除">
                      <md-icon>close</md-icon>
                    </md-icon-button>
                  </div>
                `
              : nothing}
            ${renderer(widgetState)}
          </div>
        `;
      })}

      ${this._editMode
        ? html`
            <button class="add-btn" @click=${() => (this._addOpen = !this._addOpen)}>
              <md-icon>add</md-icon>
              添加组件
            </button>
            ${this._addOpen ? this._renderAddSheet() : nothing}
          `
        : nothing}

      <div
        id="bg-tap"
        @pointerdown=${() => { if (!this._editMode) this.dispatchEvent(new CustomEvent('cc-bg-click', { bubbles: true, composed: true })); }}
      ></div>

      ${this._editMode ? html`
        <button class="edit-toggle" title="完成编辑" @click=${() => this.exitEditMode()}>
          <md-icon>check</md-icon>
        </button>
      ` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'widget-panel': WidgetPanel; }
}
