// context-menu.ts —— 窗口卡右键菜单：钉到快捷栏 / 移到桌面▸ / 标记角色▸ / 关闭窗口。
// 由 app-root 在收到 card-menu 事件时调用 open(x, y, hwnd)。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  pinAppHere,
  unpinApp,
  moveToDesktop,
  closeWindow,
  desktopsForMenu,
  unstack,
  setRole,
} from '../bridge';
import type { RoleConfig } from '../roles';

interface Desk {
  number: number;
  name: string;
}

@customElement('context-menu')
export class ContextMenu extends LitElement {
  @property({ attribute: false }) roles: RoleConfig[] = [];
  @state() private _open = false;
  @state() private _x = 0;
  @state() private _y = 0;
  @state() private _hwnd = 0;
  @state() private _desks: Desk[] = [];
  @state() private _subOpen = false;
  @state() private _roleOpen = false;
  @state() private _pinned: number | null = null;   // 已钉桌面号；null=未钉
  @state() private _stackId: number | null = null;  // 卡片夹 id；非空=本卡是夹子正面
  @state() private _role: number | null = null;     // 当前角色索引；null=无角色

  private _onDocDown = (e: MouseEvent) => {
    if (!e.composedPath().includes(this)) this.close();
  };
  private _onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  static styles = css`
    .menu {
      position: fixed;
      z-index: 1000;
      min-width: 168px;
      padding: 6px;
      border-radius: 12px;
      background: var(--md-sys-color-surface-container-high, #2b2930);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
      animation: pop 0.12s ease;
    }
    @keyframes pop {
      from {
        opacity: 0;
        transform: scale(0.96);
      }
    }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      border-radius: 8px;
      font-size: 13px;
      color: var(--md-sys-color-on-surface);
      cursor: pointer;
      white-space: nowrap;
    }
    .item:hover {
      background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
    }
    .item.danger:hover {
      background: var(--md-sys-color-error-container);
      color: var(--md-sys-color-on-error-container);
    }
    .item md-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      color: var(--md-sys-color-on-surface-variant);
    }
    .item .chev {
      margin-left: auto;
    }
    .sep {
      height: 1px;
      margin: 4px 6px;
      background: var(--md-sys-color-outline-variant);
    }
    .sub {
      max-height: 40vh;
      overflow-y: auto;
    }
    .sub .item {
      padding-left: 34px;
      font-size: 12px;
    }
    .role-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--rc);
      flex-shrink: 0;
    }
  `;

  async open(
    x: number,
    y: number,
    hwnd: number,
    pinned: number | null = null,
    stackId: number | null = null,
    role: number | null = null
  ) {
    this._hwnd = hwnd;
    this._pinned = pinned;
    this._stackId = stackId;
    this._role = role;
    this._subOpen = false;
    this._roleOpen = false;
    this._desks = [];
    this._open = true;
    // 视口内夹取（菜单宽约 180，避免溢出右/下缘）
    const W = 180;
    const H = 260;
    this._x = Math.max(6, Math.min(x, window.innerWidth - W));
    this._y = Math.max(6, Math.min(y, window.innerHeight - H));
    document.addEventListener('mousedown', this._onDocDown, true);
    document.addEventListener('keydown', this._onKey, true);
    try {
      const d = await desktopsForMenu();
      this._desks = Array.isArray(d) ? d : [];
    } catch {
      this._desks = [];
    }
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._subOpen = false;
    this._roleOpen = false;
    document.removeEventListener('mousedown', this._onDocDown, true);
    document.removeEventListener('keydown', this._onKey, true);
  }

  private _act(fn: () => void) {
    fn();
    this.close();
  }

  render() {
    if (!this._open) return nothing;
    return html`
      <div class="menu" style="left:${this._x}px; top:${this._y}px">
        ${this._stackId != null
          ? html`<div
              class="item"
              @click=${() => this._act(() => unstack(this._hwnd))}
            >
              <md-icon>filter_none</md-icon> 取消堆叠
            </div>`
          : nothing}
        ${this._pinned != null
          ? html`<div
              class="item"
              @click=${() => this._act(() => unpinApp(this._hwnd))}
            >
              <md-icon>location_off</md-icon> 取消钉（桌面${this._pinned}）
            </div>`
          : html`<div
              class="item"
              @click=${() => this._act(() => pinAppHere(this._hwnd))}
            >
              <md-icon>pin_drop</md-icon> 钉在此桌面
            </div>`}
        ${this._desks.length
          ? html`
              <div class="item" @click=${() => { this._subOpen = !this._subOpen; this._roleOpen = false; }}>
                <md-icon>desktop_windows</md-icon> 移到桌面
                <md-icon class="chev">${this._subOpen ? 'expand_more' : 'chevron_right'}</md-icon>
              </div>
              ${this._subOpen
                ? html`<div class="sub">
                    ${this._desks.map(
                      (d) => html`
                        <div
                          class="item"
                          @click=${() =>
                            this._act(() => moveToDesktop(this._hwnd, d.number))}
                        >
                          ${d.name}
                        </div>
                      `
                    )}
                  </div>`
                : nothing}
            `
          : nothing}
        ${this.roles.length
          ? html`
              <div class="item" @click=${() => { this._roleOpen = !this._roleOpen; this._subOpen = false; }}>
                <md-icon>label</md-icon> 标记角色
                <md-icon class="chev">${this._roleOpen ? 'expand_more' : 'chevron_right'}</md-icon>
              </div>
              ${this._roleOpen
                ? html`<div class="sub">
                    ${this.roles.map(
                      (r, i) => html`
                        <div
                          class="item"
                          style="--rc: ${r.color}"
                          @click=${() => this._act(() => setRole(this._hwnd, i))}
                        >
                          <span class="role-dot"></span>${r.label}
                          ${this._role === i
                            ? html`<md-icon class="chev">check</md-icon>`
                            : nothing}
                        </div>
                      `
                    )}
                    ${this._role != null
                      ? html`<div
                          class="item"
                          @click=${() => this._act(() => setRole(this._hwnd, null))}
                        >
                          <md-icon>cancel</md-icon> 清除角色
                        </div>`
                      : nothing}
                  </div>`
                : nothing}
            `
          : nothing}
        <div class="sep"></div>
        <div
          class="item danger"
          @click=${() => this._act(() => closeWindow(this._hwnd))}
        >
          <md-icon>close</md-icon> 关闭窗口
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'context-menu': ContextMenu;
  }
}
