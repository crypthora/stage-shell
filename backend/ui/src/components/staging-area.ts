// staging-area.ts —— 顶部暂存区：一行 3 个，空则 placeholder。只显示当前桌面的暂存窗口。
// 拖窗口卡上来 = 暂存（从主列表移除，只留这里）；
// 点击暂存卡 = peek 到前台并高亮边框（类似桌面分页器「当前」），再点同一张 = 恢复先前布局；
// 暂存卡可像普通窗口卡一样拖拽：拖进列表某处 = 取消暂存并插入/叠放，拖到桌面格 = 移动该窗口。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { StagedWindow } from '../state';
import { getRoleColor, type RoleConfig } from '../roles';
import { peekStaged } from '../bridge';
import { drag, type DropTarget } from '../drag';
import { handleCardDrop } from '../drop-actions';
import { externalDragHasContent, parseExternalDrop, sendDrop } from '../external-drop';

@customElement('staging-area')
export class StagingArea extends LitElement {
  @property({ attribute: false }) staged: StagedWindow[] = [];
  @property({ attribute: false }) roles: RoleConfig[] = [];
  /** 拖拽中、指针悬停在本区上方时高亮为落点 */
  @state() private _drop = false;
  /** 外部 OS 拖入（文本/图片/文件）高亮 —— 与内部 _drop 分开 */
  @state() private _extDrop = false;
  private _unregister?: () => void;
  private _unsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsub = drag.subscribe(() => {
      this._drop = drag.dragging && drag.hoverTarget?.kind === 'stage';
    });
  }

  firstUpdated() {
    // 整个暂存区登记为「落点」：拖一张窗口卡上来即暂存。
    this._unregister = drag.registerProvider(() => {
      if (drag.sourceHwnd == null) return [];
      const host = this.renderRoot.querySelector('.grid') as HTMLElement | null;
      if (!host) return [];
      return [
        { kind: 'stage', idx: -1, number: -1, rect: host.getBoundingClientRect() } as DropTarget,
      ];
    });
  }

  disconnectedCallback() {
    this._unsub?.();
    this._unregister?.();
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      display: block;
      flex: 0 0 auto;
    }
    img {
      -webkit-user-drag: none;
      user-select: none;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      padding: 6px 2px;
      min-height: 56px;
      max-height: 132px; /* 固定高度上限（约 2 行），更多则滚动，不挤占下面列表 */
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: none;
    }
    .grid::-webkit-scrollbar {
      display: none;
    }
    .grid.empty {
      display: block;
    }
    /* 拖拽落点高亮（与桌面格一致的 tertiary） */
    .grid.drop {
      outline: 2px solid var(--md-sys-color-tertiary, #4ad6c0);
      outline-offset: -2px;
      border-radius: 12px;
    }
    /* 外部拖入（新建便签）高亮 */
    .grid.extdrop {
      outline: 2px dashed var(--md-sys-color-primary, #d0bcff);
      outline-offset: -2px;
      border-radius: 12px;
    }
    .placeholder {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 56px;
      border: 1.5px dashed var(--md-sys-color-outline-variant, #49454f);
      border-radius: 12px;
      color: var(--md-sys-color-on-surface-variant);
      font-size: 12px;
      opacity: 0.7;
    }
    .placeholder md-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .scard {
      position: relative;
      aspect-ratio: 4 / 3;
      border-radius: 10px;
      overflow: hidden;
      background: #000;
      cursor: pointer;
      border: 2px solid transparent;
      transition: border-color 0.12s, transform 0.1s;
    }
    .scard:hover {
      transform: translateY(-1px);
    }
    /* peek 高亮：类似底部桌面分页器「当前桌面」的 primary 边框 */
    .scard.peeked {
      border-color: var(--md-sys-color-primary);
    }
    .scard img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .scard::after {
      content: '';
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.2);
      pointer-events: none;
      border-radius: inherit;
    }
    .scard .ph {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      background: var(--md-sys-color-surface-container-high, #2b2930);
    }
    .scard .ph md-icon {
      font-size: 22px;
      opacity: 0.5;
    }
    /* 占位图标：角色渐变色填充背景，图标 img 加白底隔离透明像素 */
    .ph-icon-wrap {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: radial-gradient(ellipse at bottom, var(--role-color, rgba(255, 255, 255, 0.93)) 0%, rgba(255, 255, 255, 0.93) 70%);
      padding: 5px;
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
    /* 嵌入截图中央的应用图标徽章：角色渐变色填充背景，图标 img 加白底隔离透明像素 */
    .scard-icon {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 20px;
      height: 20px;
      border-radius: 5px;
      background: radial-gradient(ellipse at bottom, var(--role-color, rgba(255, 255, 255, 0.95)) 0%, rgba(255, 255, 255, 0.95) 70%);
      padding: 2px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 3;
    }
    .scard-icon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  `;

  // 外部 OS 拖入（文本/图片/任意文件）→ 新建未分类便签。externalDragHasContent 已在
  // drag.dragging（内部指针拖拽）时让行，故与「拖窗口卡来暂存」互不干扰。
  private _onExtOver = (e: DragEvent) => {
    if (!externalDragHasContent(e)) return;
    e.preventDefault();
    this._extDrop = true;
  };
  private _onExtLeave = () => { this._extDrop = false; };
  private _onExtDrop = (e: DragEvent) => {
    this._extDrop = false;
    if (drag.dragging) return;
    e.preventDefault();
    void parseExternalDrop(e).then((c) => { if (c) sendDrop(c); });
  };

  render() {
    const items = this.staged ?? [];
    if (items.length === 0) {
      return html`
        <div
          class="grid empty ${this._drop ? 'drop' : ''} ${this._extDrop ? 'extdrop' : ''}"
          @dragover=${this._onExtOver}
          @dragleave=${this._onExtLeave}
          @drop=${this._onExtDrop}
        >
          <div class="placeholder">
            <md-icon>inventory_2</md-icon><span>拖窗口到此暂存</span>
          </div>
        </div>
      `;
    }
    return html`
      <div
        class="grid ${this._drop ? 'drop' : ''} ${this._extDrop ? 'extdrop' : ''}"
        @dragover=${this._onExtOver}
        @dragleave=${this._onExtLeave}
        @drop=${this._onExtDrop}
      >
        ${repeat(
          items,
          (w) => w.hwnd,
          (w) => html`
            <div
              class="scard ${w.peeked ? 'peeked' : ''}"
              style=${w.role != null ? `--role-color:${getRoleColor(w.role, this.roles)}` : ''}
              title=${w.title}
              @pointerdown=${(e: PointerEvent) =>
                drag.start(
                  e,
                  { hwnd: w.hwnd, fromIdx: null, icon: w.icon, title: w.title },
                  handleCardDrop
                )}
              @click=${() => peekStaged(w.hwnd)}
            >
              ${w.thumb
                ? html`
                    <img draggable="false" src=${w.thumb} alt="" />
                    ${w.icon ? html`<div class="scard-icon"><img draggable="false" src=${w.icon} alt="" /></div>` : nothing}
                  `
                : html`<div class="ph">
                    ${w.icon
                      ? html`<div class="ph-icon-wrap"><img draggable="false" src=${w.icon} alt="" /></div>`
                      : html`<md-icon>web_asset</md-icon>`}
                  </div>`}
            </div>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'staging-area': StagingArea;
  }
}
