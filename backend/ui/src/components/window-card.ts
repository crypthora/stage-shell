// window-card.ts —— 单张窗口卡：仅缩略图（无标题/无角标）。
// 点击=切过去；中键=关闭；右键=派发 card-menu 事件给 app-root 弹上下文菜单。
// 拖拽：拖到桌面格→移到该桌面；拖到另一张卡→堆叠成"卡片夹"。
// 卡片夹（c.stack）：在场 ≥2 张→类华为大文件夹固定 2×2（最多 4 张）；
//   在场仅剩 1 张（其余在前台）→ 单卡 + 左上静态分组图标。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { CardState } from '../state';
import { focusCard, closeWindow } from '../bridge';
import { getRoleColor, type RoleConfig } from '../roles';
import { drag } from '../drag';
import { handleCardDrop } from '../drop-actions';
import { externalDragHasContent, parseExternalDrop, sendDrop } from '../external-drop';

@customElement('window-card')
export class WindowCard extends LitElement {
  @property({ attribute: false }) card!: CardState;
  @property({ attribute: false }) roles: RoleConfig[] = [];
  /** 拖拽落点模式：stack=叠放高亮 / before=上插线 / after=下插线 / null=无 */
  @state() private _dropMode: 'stack' | 'before' | 'after' | null = null;
  /** 外部 OS 拖入（文本/图片/文件）高亮 —— 拖到本卡=新建带 #应用名# 标签的便签 */
  @state() private _extDrop = false;
  private _unsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsub = drag.subscribe(() => {
      const ht = drag.hoverTarget;
      const hoverThis =
        drag.dragging && ht?.kind === 'card' && ht.number === this.card?.hwnd;
      this._dropMode = hoverThis ? (ht!.mode ?? 'stack') : null;
    });
  }

  disconnectedCallback() {
    this._unsub?.();
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      display: block;
      position: relative;
    }
    img {
      -webkit-user-drag: none;
      user-select: none;
    }
    /* 插入排序落点指示线：贴卡上/下沿，落在与相邻卡的间隙里（列表 gap 12px） */
    .insert-line {
      position: absolute;
      left: 4px;
      right: 4px;
      height: 3px;
      border-radius: 2px;
      background: var(--md-sys-color-primary);
      box-shadow: 0 0 0 1px var(--md-sys-color-surface);
      z-index: 5;
      pointer-events: none;
    }
    .insert-line.top {
      top: -7px;
    }
    .insert-line.bottom {
      bottom: -7px;
    }
    .card {
      position: relative;
      border-radius: 16px;
      background: var(--md-sys-color-surface-container, #211f26);
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.15s ease, background 0.15s;
      --md-elevation-level: 0;
    }
    .card:hover {
      background: var(--md-sys-color-surface-container-high, #2b2930);
      transform: translateY(-2px);
      --md-elevation-level: 1;
    }
    .card:active {
      transform: translateY(0) scale(0.985);
    }
    /* 文件夹卡：整卡统一磨砂玻璃——缩略图与图标行同处一层背景，消除不透明接缝。
       磨砂背景从 .folder-grid 上移到这里，让 .folder-bar 也落在同一块玻璃上。
       固定 4:3（与单卡 .thumb-wrap 一致），内容（缩略图+图标行）整体上下居中，
       上下留白属于卡片本体，落点仍触发卡片 @click（focusCard）。 */
    .card.folder {
      background: color-mix(
        in srgb,
        var(--md-sys-color-surface-container-highest, #36343b) 75%,
        transparent
      );
      backdrop-filter: blur(12px) saturate(1.3);
      aspect-ratio: 4 / 3;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .thumb-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 4 / 3;
      background: var(--md-sys-color-surface-container-high, #2b2930);
      overflow: hidden;
    }
    .thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .thumb.placeholder {
      display: grid;
      place-items: center;
    }
    /* 静态分组标记：夹子在场仅剩 1 张（其余成员在前台）时，左上角标识仍是个组 */
    .group-mark {
      position: absolute;
      top: 5px;
      left: 5px;
      width: 20px;
      height: 20px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(4px);
      display: grid;
      place-items: center;
    }
    .group-mark md-icon {
      font-size: 14px;
      width: 14px;
      height: 14px;
      color: #fff;
    }
    .group-tag {
      position: absolute;
      bottom: 6px;
      right: 6px;
      padding: 1px 7px;
      border-radius: 999px;
      background: var(--md-sys-color-secondary-container);
      color: var(--md-sys-color-on-secondary-container);
      font-size: 10px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .group-tag md-icon {
      font-size: 12px;
      width: 12px;
      height: 12px;
    }
    /* ---- 卡片夹：类华为大文件夹，固定 2×2、每格 1/4、最多 4 张 ----
       磨砂背景在父级 .card.folder 上，这里只负责网格布局，背景透明。 */
    .folder-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      grid-template-rows: repeat(2, 1fr);
      gap: 4px;
      padding: 4px;
      aspect-ratio: 4 / 3;
    }
    /* 恰好 2 张时：折叠成单行；网格按缩略图内容定高（取消继承的 4:3），
       消除缩略图上下空白带，让图标行紧贴缩略图下方 */
    .folder-grid.two-tile {
      grid-template-rows: auto;
      aspect-ratio: auto;
      padding: 0;
      gap: 2px;
    }
    .tile {
      position: relative;
      border-radius: 8px;
      overflow: hidden;
      background: var(--md-sys-color-surface-container-high, #2b2930);
      display: grid;
      place-items: center;
    }
    /* two-tile tile：透明全高点击区，内部 flex 居中小卡 */
    .folder-grid.two-tile .tile {
      border-radius: 0;
      cursor: pointer;
      background: transparent;
      overflow: visible;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px 3px;
    }
    .folder-grid.two-tile .tile:first-child {
      border-radius: 16px 0 0 16px;
      padding-left: 5px;
    }
    .folder-grid.two-tile .tile:last-child {
      border-radius: 0 16px 16px 0;
      padding-right: 5px;
    }
    /* 两张时的可见小卡（与 2×2 格等大，4:3 居中） */
    .tile-inner {
      width: 100%;
      aspect-ratio: 4 / 3;
      border-radius: 10px;
      overflow: hidden;
      background: var(--md-sys-color-surface-container-high, #2b2930);
    }
    .tile img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .tile img.tile-ph {
      width: 50%;
      height: 50%;
      object-fit: contain;
      opacity: 0.7;
    }
    .ph-icon {
      width: 36px;
      height: 36px;
      opacity: 0.5;
    }
    /* 占位图标：角色渐变色填充背景，图标 img 加白底隔离透明像素 */
    .ph-icon-wrap {
      width: 52px;
      height: 52px;
      border-radius: 13px;
      background: radial-gradient(ellipse at bottom, var(--role-color, rgba(255, 255, 255, 0.93)) 0%, rgba(255, 255, 255, 0.93) 70%);
      padding: 9px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ph-icon-wrap img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    /* 嵌入截图底部居中的应用图标徽章：角色渐变色填充背景，图标 img 加白底隔离透明像素 */
    .app-icon-badge {
      position: absolute;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: radial-gradient(ellipse at bottom, var(--role-color, rgba(255, 255, 255, 0.95)) 0%, rgba(255, 255, 255, 0.95) 70%);
      padding: 4px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 3;
    }
    .app-icon-badge img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      border-radius: 3px;
    }
    /* ---- 卡片夹落点高亮 ---- */
    .card.drop-target {
      outline: 2px solid var(--md-sys-color-tertiary, #4ad6c0);
      outline-offset: -2px;
    }
    /* ---- 外部拖入（新建带应用标签的便签）高亮 ---- */
    .card.extdrop {
      outline: 2px dashed var(--md-sys-color-primary, #d0bcff);
      outline-offset: -2px;
    }
    .card .ext-badge {
      position: absolute; inset: 0; z-index: 6;
      display: grid; place-items: center;
      background: color-mix(in srgb, var(--md-sys-color-primary-container, #4f378b) 55%, transparent);
      color: var(--md-sys-color-on-primary-container, #eaddff);
      pointer-events: none;
    }
    .card .ext-badge md-icon { font-size: 28px; }
    /* ---- 卡片夹图标徽章 ---- */
    /* 两张：图标行在卡片内部、缩略图下方；两列网格，各徽章在自己列内居中，
       与上方两 tile 列对齐（中心约 25% / 75%） */
    .folder-bar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      place-items: center;
      padding: 2px 4px 8px;
    }
    /* 三张及以上：卡片内部底部居中，比单卡稍小 */
    .folder-icons-inside {
      position: absolute;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 4px;
      z-index: 3;
      pointer-events: none;
    }
    .folder-badge {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.93);
      padding: 4px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .folder-badge.sm {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      padding: 3px;
    }
    .folder-badge img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
  `;

  private _onAux(e: MouseEvent) {
    if (e.button === 1) {
      e.preventDefault();
      closeWindow(this.card.hwnd);
    }
  }

  private _onMenu(e: MouseEvent) {
    e.preventDefault();
    this.dispatchEvent(
      new CustomEvent('card-menu', {
        detail: {
          hwnd: this.card.hwnd,
          x: e.clientX,
          y: e.clientY,
          pinnedDesktop: this.card.pinnedDesktop ?? null,
          stackId: this.card.stackId ?? null,
          role: this.card.role ?? null,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  // 按下即可能开始拖拽；越过阈值才算拖，否则仍是点击=focusCard。
  // 落到桌面格 → 移到该桌面；落到另一张卡 → 堆叠成卡片夹。
  private _onDown(e: PointerEvent) {
    const c = this.card;
    drag.start(
      e,
      { hwnd: c.hwnd, fromIdx: null, icon: c.icon, title: c.title, stackId: c.stackId ?? null },
      handleCardDrop
    );
  }

  // 外部 OS 拖入（文本/图片/任意文件）→ 新建便签并带 #应用名#（后端按 hwnd 解析）。
  // externalDragHasContent 已在 drag.dragging（内部指针拖拽堆叠/移动）时让行，互不干扰。
  private _onExtOver(e: DragEvent) {
    if (!externalDragHasContent(e)) return;
    e.preventDefault();
    this._extDrop = true;
  }
  private _onExtLeave() { this._extDrop = false; }
  private _onExtDrop(e: DragEvent) {
    this._extDrop = false;
    if (drag.dragging) return;
    e.preventDefault();
    const hwnd = this.card.hwnd;
    void parseExternalDrop(e).then((c) => { if (c) sendDrop(c, hwnd); });
  }

  render() {
    const c = this.card;
    const count = c.stack?.count ?? 0;
    const tiles = c.stack?.tiles ?? [];
    const twoTile = count === 2;

    const renderTile = (t: typeof tiles[0]) => {
      const inner = t.thumb
        ? html`<img draggable="false" src=${t.thumb} alt="" />`
        : t.icon
          ? html`<img class="tile-ph" draggable="false" src=${t.icon} alt="" />`
          : nothing;
      if (twoTile) {
        return html`<div class="tile"
          @click=${(e: MouseEvent) => { e.stopPropagation(); if (t.hwnd) focusCard(t.hwnd); }}>
          <div class="tile-inner">${inner}</div>
        </div>`;
      }
      return html`<div class="tile">${inner}</div>`;
    };

    // 夹内在场 ≥ 2 张 → 类华为大文件夹固定 2×2（最多 4 张，多余不展示）；
    // 2 张时用 two-tile 单行布局：两格各占整个高度，左右独立可点击。
    // 否则单卡：普通窗口 / 或夹子在场仅剩 1 张（左上叠加静态分组图标）。
    const face =
      count >= 2
        ? html`<div class="folder-grid ${twoTile ? 'two-tile' : ''}">
            ${tiles.slice(0, 4).map((t) => renderTile(t))}
          </div>`
        : html`<div class="thumb-wrap" style=${c.role != null ? `--role-color:${getRoleColor(c.role, this.roles)}` : ''}>
            ${c.thumb
              ? html`
                  <img class="thumb" draggable="false" src=${c.thumb} alt="" />
                  ${c.icon ? html`<div class="app-icon-badge"><img draggable="false" src=${c.icon} alt="" /></div>` : nothing}
                `
              : html`<div class="thumb placeholder">
                  ${c.icon
                    ? html`<div class="ph-icon-wrap"><img draggable="false" src=${c.icon} alt="" /></div>`
                    : html`<md-icon class="ph-icon">web_asset</md-icon>`}
                </div>`}
            ${c.stack && count === 1
              ? html`<div class="group-mark"><md-icon>grid_view</md-icon></div>`
              : nothing}
            ${c.group
              ? html`<div class="group-tag">
                  <md-icon>grid_view</md-icon>+${c.groupCount}
                </div>`
              : nothing}
          </div>`;

    // folder→folder 不显示叠放高亮（引擎对组叠组 no-op）
    const srcStack = drag.sourceStackId != null;
    const showStack = this._dropMode === 'stack' && !(srcStack && c.stackId != null);
    return html`
      ${this._dropMode === 'before'
        ? html`<div class="insert-line top"></div>`
        : nothing}
      <div
        class="card ${count >= 2 ? 'folder' : ''} ${showStack ? 'drop-target' : ''} ${this._extDrop ? 'extdrop' : ''}"
        @pointerdown=${this._onDown}
        @click=${() => focusCard(c.hwnd)}
        @auxclick=${this._onAux}
        @contextmenu=${this._onMenu}
        @dragover=${this._onExtOver}
        @dragleave=${this._onExtLeave}
        @drop=${this._onExtDrop}
      >
        <md-elevation></md-elevation>
        <md-ripple></md-ripple>
        ${this._extDrop ? html`<div class="ext-badge"><md-icon>add</md-icon></div>` : nothing}
        ${face}
        ${count >= 3
          ? html`<div class="folder-icons-inside">
              ${tiles.map((t) => t.icon ? html`<div class="folder-badge sm"><img draggable="false" src=${t.icon} alt="" /></div>` : nothing)}
            </div>`
          : nothing}
        ${twoTile
          ? html`<div class="folder-bar">
              ${tiles.map((t) => t.icon ? html`<div class="folder-badge"><img draggable="false" src=${t.icon} alt="" /></div>` : nothing)}
            </div>`
          : nothing}
      </div>
      ${this._dropMode === 'after'
        ? html`<div class="insert-line bottom"></div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'window-card': WindowCard;
  }
}
