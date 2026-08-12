// desktop-pager.ts —— 底部虚拟桌面切换器（2 列网格）。
// 点格子=切到该桌面；点底部图标=切桌面并聚焦该软件。
// 每个格子的大图展示该桌面的前台应用缩略图。
// 拖拽：① 落点——窗口卡/桌面内图标拖到某格 → 移动该窗口到该桌面；
//       ② 拖拽源——格子里的前台徽标/软件图标可拖到另一格（功能2）。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { DesktopsState, DeskItem, CardState } from '../state';
import { switchDesktop, openApp, moveToDesktop, stackCards } from '../bridge';
import { getRoleColor, getRoleDarkColor, type RoleConfig } from '../roles';
import { drag, type DropTarget } from '../drag';
import { externalDragHasContent, parseExternalDrop, sendDrop } from '../external-drop';

@customElement('desktop-pager')
export class DesktopPager extends LitElement {
  @property({ attribute: false }) desktops!: DesktopsState;
  @property({ attribute: false }) cards: CardState[] = [];
  @property({ attribute: false }) roles: RoleConfig[] = [];
  @property({ reflect: true }) mode: 'preview' | 'icons' = 'preview';
  /** 拖拽悬停高亮的格子 idx（来自共享拖拽控制器） */
  @state() private _hover: number | null = null;
  /** 外部 OS 拖入（文本/图片/文件）悬停的格子 idx —— 拖到此=新建带该桌面前台应用标签的便签 */
  @state() private _extHover: number | null = null;
  private _unsub?: () => void;
  private _unregister?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsub = drag.subscribe(() => {
      this._hover = drag.dragging ? drag.hoverIdx : null;
    });
  }

  disconnectedCallback() {
    this._unsub?.();
    this._unregister?.();
    super.disconnectedCallback();
  }

  firstUpdated() {
    // 拖拽时实时返回各桌面格的视口矩形，供坐标命中（跨 Shadow DOM 可靠）
    this._unregister = drag.registerProvider(() => {
      const cells = Array.from(
        this.renderRoot.querySelectorAll('.cell')
      ) as HTMLElement[];
      return cells.map((el): DropTarget => {
        const idx = Number(el.dataset.idx);
        const num = Number(el.dataset.number);
        // 后端没下发 number（旧引擎进程未重启）时回退 idx+1：
        // pyvda 桌面号是 1 基且与格子顺序一致，故等于 idx+1。
        return {
          kind: 'desk',
          idx,
          number: Number.isFinite(num) ? num : idx + 1,
          rect: el.getBoundingClientRect(),
        };
      });
    });
  }

  private _onMenu(e: MouseEvent, hwnd: number | null) {
    if (!hwnd) return;
    e.preventDefault();
    const card = this.cards.find((c) => c.hwnd === hwnd);
    // pager 里的 app 可能不在 cards 列表中（其他桌面的窗口），role 从 DeskApp 取
    const deskApp = this.desktops?.items.flatMap((d) => d.apps).find((a) => a.hwnd === hwnd);
    const detail = {
      hwnd,
      x: e.clientX,
      y: e.clientY,
      pinnedDesktop: card?.pinnedDesktop ?? null,
      stackId: card?.stackId ?? null,
      role: card?.role ?? deskApp?.role ?? null,
    };
    // desktop-pager 直接在 app-root 的 shadow root 里，穿越 shadow 边界不可靠；
    // 通过 getRootNode().host 直接向 app-root 宿主派发，绕开 composed 冒泡。
    const sr = this.getRootNode();
    const target = sr instanceof ShadowRoot ? sr.host : document;
    target.dispatchEvent(new CustomEvent('card-menu', { detail, bubbles: true }));
  }

  // 功能2：从某桌面格里把一个窗口拖出去。越过阈值才算拖；落到另一格 → 移动窗口。
  private _dragWin(
    e: PointerEvent,
    hwnd: number | null,
    fromIdx: number,
    icon: string | null
  ) {
    if (!hwnd) return;
    drag.start(e, { hwnd, fromIdx, icon, title: '' }, (payload, target) => {
      if (target.kind === 'desk' && target.idx !== payload.fromIdx) {
        moveToDesktop(payload.hwnd, target.number);
      } else if (target.kind === 'card' && target.number !== payload.hwnd) {
        stackCards(payload.hwnd, target.number);
      }
    });
  }

  // ── 外部 OS 拖入 → 新建带应用标签的便签 ──
  // 桌面格里的前台应用(大图标)常是「只出现在分页器、不在窗口卡列表」的应用(如当前前台/
  // 它桌面的窗口)，故分页器是给这些应用打标签的唯一入口。拖到格子=按该桌面前台应用(fgHwnd)
  // 打标签；拖到某个小应用图标=按那个应用打标签。与内部指针拖拽各走一通道，drag.dragging 时让行。
  private _onCellExtOver(e: DragEvent, idx: number) {
    if (!externalDragHasContent(e)) return;
    e.preventDefault();           // 让整格(含子元素)成为可落区
    this._extHover = idx;
  }
  private _onCellExtLeave(e: DragEvent, idx: number) {
    const cell = e.currentTarget as HTMLElement;
    if (!cell.contains(e.relatedTarget as Node) && this._extHover === idx) {
      this._extHover = null;
    }
  }
  private _onCellExtDrop(e: DragEvent, hwnd: number | null) {
    if (drag.dragging) return;
    e.preventDefault();
    this._extHover = null;
    void parseExternalDrop(e).then((c) => { if (c) sendDrop(c, hwnd ?? undefined); });
  }
  private _onAppExtDrop(e: DragEvent, hwnd: number | null) {
    if (drag.dragging || !hwnd) return;
    e.preventDefault();
    e.stopPropagation();          // 命中小图标 → 用它的 hwnd，别落到格子的 fgHwnd
    this._extHover = null;
    void parseExternalDrop(e).then((c) => { if (c) sendDrop(c, hwnd); });
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
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      /* Four previews are the primary compact control: minimize only the
         horizontal gutter so each thumbnail retains useful visual detail. */
      column-gap: 4px;
      row-gap: 8px;
      padding: 8px 2px 10px;
    }
    .cell {
      position: relative;
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      background: var(--md-sys-color-surface-container, #211f26);
      border: 2px solid transparent;
      transition: border-color 0.12s, transform 0.1s, box-shadow 0.12s;
    }
    .cell:hover {
      transform: translateY(-1px);
    }
    .cell.active {
      border-color: var(--md-sys-color-primary);
      background: var(--md-sys-color-primary, #d0bcff);
      box-shadow: 0 0 0 1px var(--md-sys-color-primary, #d0bcff) inset;
    }
    .cell.active .apps {
      background: var(--md-sys-color-primary, #d0bcff);
    }
    .cell.active .app {
      background: color-mix(
        in srgb,
        var(--md-sys-color-primary, #d0bcff) 78%,
        var(--md-sys-color-on-primary, #381e72)
      );
    }
    /* 拖拽落点高亮：用 tertiary 跟 active 的 primary 区分开 */
    .cell.drop-target {
      border-color: var(--md-sys-color-tertiary, #4ad6c0);
      box-shadow: 0 0 0 2px var(--md-sys-color-tertiary, #4ad6c0) inset;
      transform: translateY(-1px);
    }
    /* 外部拖入(新建带应用标签的便签)高亮 */
    .cell.extdrop {
      border-color: var(--md-sys-color-primary, #d0bcff);
      box-shadow: 0 0 0 2px var(--md-sys-color-primary, #d0bcff) inset;
    }
    .ext-badge {
      position: absolute;
      inset: 0;
      z-index: 4;
      display: grid;
      place-items: center;
      background: color-mix(in srgb, var(--md-sys-color-primary-container, #4f378b) 50%, transparent);
      color: var(--md-sys-color-on-primary-container, #eaddff);
      pointer-events: none;
    }
    .ext-badge md-icon {
      font-size: 22px;
    }
    .shot {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 9;
      background: var(--md-sys-color-surface-container, #211f26);
      cursor: grab;
      touch-action: none;
    }
    .shot img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    /* 截图蒙版：让居中图标更突出 */
    .shot::after {
      content: '';
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.2);
      pointer-events: none;
    }
    .fg {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 26px;
      height: 26px;
      border-radius: 7px;
      background: radial-gradient(ellipse at bottom, var(--role-color, rgba(255, 255, 255, 0.93)) 0%, rgba(255, 255, 255, 0.93) 70%);
      padding: 4px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      touch-action: none;
      z-index: 1;
    }
    .fg img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .apps {
      display: flex;
      flex-wrap: nowrap;
      gap: 3px;
      padding: 3px 4px;
      min-height: 23px;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .app {
      width: 17px;
      height: 17px;
      border-radius: 5px;
      padding: 2px;
      box-sizing: border-box;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(ellipse at bottom, var(--role-color, rgba(255, 255, 255, 0.93)) 0%, rgba(255, 255, 255, 0.93) 70%);
      transition: background 0.1s;
      cursor: grab;
      touch-action: none;
    }
    .app:hover {
      background: var(--app-hover-color, rgba(255, 255, 255, 0.55));
    }
    .app img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    :host([mode='icons']) .grid {
      gap: 5px;
      padding: 5px 2px 6px;
    }
    :host([mode='icons']) .cell { min-height: 34px; }
    :host([mode='icons']) .shot { display: none; }
    :host([mode='icons']) .apps { padding: 5px 4px; min-height: 30px; }
    :host([mode='icons']) .app { width: 22px; height: 22px; padding: 3px; }
  `;

  private _cell(d: DeskItem, active: boolean) {
    const drop = this._hover === d.idx;
    const ext = this._extHover === d.idx;
    // 拖到格子（非具体小图标）→ 用该桌面前台应用打标签；无前台则退回第一个应用
    const tagHwnd = d.fgHwnd ?? (d.apps[0]?.hwnd ?? null);
    return html`
      <div
        class="cell ${active ? 'active' : ''} ${drop ? 'drop-target' : ''} ${ext ? 'extdrop' : ''}"
        data-idx=${d.idx}
        data-number=${d.number}
        @click=${() => switchDesktop(d.idx)}
        @dragover=${(e: DragEvent) => this._onCellExtOver(e, d.idx)}
        @dragleave=${(e: DragEvent) => this._onCellExtLeave(e, d.idx)}
        @drop=${(e: DragEvent) => this._onCellExtDrop(e, tagHwnd)}
      >
        ${ext ? html`<div class="ext-badge"><md-icon>note_add</md-icon></div>` : nothing}
        <div
          class="shot"
          @pointerdown=${(e: PointerEvent) =>
            this._dragWin(e, d.fgHwnd, d.idx, d.fgIcon)}
          @contextmenu=${(e: MouseEvent) => this._onMenu(e, d.fgHwnd)}
        >
          ${d.thumb
            ? html`<img draggable="false" src=${d.thumb} alt="" />`
            : nothing}
          ${d.fgIcon
            ? html`<div class="fg" style=${d.fgRole != null ? `--role-color:${getRoleColor(d.fgRole, this.roles)}` : ''}>
                <img draggable="false" src=${d.fgIcon} alt="" />
              </div>`
            : nothing}
        </div>
        <div class="apps">
          ${d.apps.map((a) =>
            a.icon
              ? html`<div
                  class="app"
                  style="${a.role != null ? `--role-color:${getRoleColor(a.role, this.roles)};` : ''}--app-hover-color:${getRoleDarkColor(a.role, this.roles)}"
                  @pointerdown=${(e: PointerEvent) =>
                    this._dragWin(e, a.hwnd, d.idx, a.icon)}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    openApp(d.idx, a.hwnd);
                  }}
                  @drop=${(e: DragEvent) => this._onAppExtDrop(e, a.hwnd)}
                  @contextmenu=${(e: MouseEvent) => this._onMenu(e, a.hwnd)}
                >
                  <img draggable="false" src=${a.icon} alt="" />
                </div>`
              : nothing
          )}
        </div>
      </div>
    `;
  }

  render() {
    const d = this.desktops;
    if (!d || !d.items || d.items.length === 0) return nothing;
    return html`
      <div class="grid">
        ${repeat(
          d.items,
          (it) => it.idx,
          (it) => this._cell(it, it.idx === d.active)
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'desktop-pager': DesktopPager;
  }
}
