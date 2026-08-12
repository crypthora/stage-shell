// app-root.ts —— 布局外壳：顶部搜索栏 + 底部导航栏 + 动态内容区。
import { LitElement, html, css } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import type { State } from '../state';
import { subscribe } from '../store';

import './window-management';
import './desktop-pager';
import './widget-panel';
import './voice-bar';
import './context-menu';
import type { ContextMenu } from './context-menu';
import type { WidgetPanel } from './widget-panel';
import { toggleSidebar } from '../bridge.js';

const EMPTY: State = {
  clock: '--:--',
  media: { active: false, title: '', artist: '', isPlaying: false, cover: null },
  cards: [],
  staged: [],
  desktops: { active: 0, cols: 2, items: [] },
  voice: { visible: false, mode: 'listening', text: '' },
  wallpaper: { url: null, seed: null, alpha: 0.15 },
  widgets: {},
  widgetsEnabled: true,
  widgetOrder: [{ id: 'clock', enabled: true }, { id: 'media', enabled: true }],
  allWidgets: [
    { id: 'clock', title: '时钟', icon: 'schedule' },
    { id: 'media', title: '媒体播放', icon: 'music_note' },
  ],
  roles: [],
  mouseLeaveReset: false,
};

@customElement('app-root')
export class AppRoot extends LitElement {
  @state() private s: State = EMPTY;
  @state() private _isNarrow = window.innerWidth <= 48;
  @state() private _dockRight = true;
  @query('context-menu') private _menu!: ContextMenu;
  @query('widget-panel') private _widgets!: WidgetPanel;
  @state() private _widgetMenu: { x: number; y: number } | null = null;
  private _unsub: (() => void) | null = null;
  private _mouseLeaveReset = false;
  private _syncViewport = () => { this._isNarrow = window.innerWidth <= 48; };

  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
    #bar {
      position: relative;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      isolation: isolate;
      /* 壁纸淡出时露出的不是纯黑，而是由同一张壁纸种子生成的 M3 surface。 */
      background: color-mix(
        in srgb,
        var(--md-sys-color-surface) 90%,
        var(--wp-seed, #4aa3ff) 10%
      );
    }
    #bar.collapsed {
      cursor: ew-resize;
      background:
        linear-gradient(90deg,
          color-mix(in srgb, var(--md-sys-color-primary, #d0bcff) 14%, transparent) 0%,
          color-mix(in srgb, var(--md-sys-color-surface-container-highest, #36343b) 88%, transparent) 100%),
        var(--md-sys-color-surface);
    }
    /* 第 1 层：原图只负责承接 blur 的透明采样边缘，绝不参与透明度调节。 */
    #wp-base {
      position: absolute;
      inset: 0;
      background-image: var(--wp-url, none);
      background-size: cover;
      background-position: var(--wp-position-x, right) center;
      opacity: var(--wp-on, 0);
      filter: saturate(.82) contrast(.78);
      pointer-events: none;
      z-index: 0;
    }
    /* 第 2 层：壁纸模糊层必须先放大、偏向停靠边并给 blur 留足过扫描区。
       否则模糊核会采样到图片边缘，壁纸中明亮区域会变成一圈白边。 */
    #wp {
      position: absolute;
      inset: -28%;
      background-image: var(--wp-url, none);
      background-size: cover;
      background-position: var(--wp-position-x, right) center;
      /* 降低对比/饱和度，让内容浮在柔和的 iOS 式磨砂背景之上。 */
      filter: blur(56px) saturate(1.04) contrast(.76);
      transform: scale(1.12);
      transform-origin: var(--wp-position-x, right) center;
      opacity: var(--wp-on, 0);
      pointer-events: none;
      z-index: 1;
      will-change: transform;
    }
    /* 第 3 层：完整的低饱和主题色平面。surface 会随宿主深浅模式
       改变，因此浅色模式更亮、深色模式更暗；透明度滑块只改此层 opacity。 */
    #wp-tint {
      position: absolute;
      inset: 0;
      background: color-mix(
        in srgb,
        var(--wp-seed, #4aa3ff) 24%,
        var(--md-sys-color-surface) 76%
      );
      opacity: var(--wp-mask, 0);
      pointer-events: none;
      z-index: 2;
      transition: opacity 0.5s ease;
    }
    #content {
      position: relative;
      z-index: 3;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .pane {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }
    .pane.active {
      display: flex;
    }
    widget-panel {
      /* Widgets sit between the window area and desktop previews. They
         never claim a percentage of the window and never scroll: widget
         authors/users own their content height and the window list keeps all
         remaining space. */
      flex: 0 0 auto;
      position: relative;
      /* #content and desktop-pager establish z-index:3 stacking contexts.
         Without an explicit layer this later DOM sibling is painted beneath
         them, leaving widgets clickable but visually obscured. */
      z-index: 3;
      min-height: 0;
      max-height: none;
      overflow: visible;
      border-top: 1px solid var(--md-sys-color-outline-variant, #49454f);
    }
    /* 桌面切换器：常驻独立底栏，永不随标签页隐藏。
       补回它原先嵌在 window-management 时从其 :host 继承的横向内边距。 */
    desktop-pager {
      position: relative;
      z-index: 3;
      flex: 0 0 auto;
      padding: 0 6px;
      max-height: 45%;
      overflow-y: auto;
      scrollbar-width: none;
      border-top: 1px solid var(--md-sys-color-outline-variant, #49454f);
    }
    desktop-pager::-webkit-scrollbar {
      display: none;
    }
    /* 语音历史：常驻最底栏，位于桌面切换器「之下」。自带顶边框/内边距；
       z-index 高于内容层与桌面层，确保点开后向上展开的历史面板盖住它们。 */
    voice-bar {
      position: relative;
      z-index: 3;
      flex: 0 0 auto;
    }
    .collapse-handle {
      position: relative;
      z-index: 3;
      width: 100%;
      height: 100%;
      border: none;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: ew-resize;
      background: transparent;
      color: var(--md-sys-color-on-surface-variant);
      overflow: hidden;
    }
    .collapse-handle:hover {
      color: var(--md-sys-color-primary, #d0bcff);
      background: color-mix(in srgb, var(--md-sys-color-primary, #d0bcff) 12%, transparent);
    }
    .collapse-handle md-icon {
      font-size: 16px;
      --md-icon-size: 16px;
      opacity: .9;
    }
    .widget-menu {
      position: absolute;
      z-index: 20;
      min-width: 132px;
      padding: 5px;
      border: 1px solid var(--md-sys-color-outline-variant, #49454f);
      border-radius: 12px;
      background: var(--md-sys-color-surface-container-high, #2b2930);
      box-shadow: 0 8px 24px rgba(0, 0, 0, .34);
    }
    .widget-menu button {
      width: 100%; border: 0; border-radius: 8px; padding: 9px 10px;
      display: flex; align-items: center; gap: 8px; cursor: pointer;
      color: var(--md-sys-color-on-surface); background: transparent; text-align: left;
    }
    .widget-menu button:hover { background: var(--md-sys-color-surface-container-highest, #49454f); }
    .widget-menu md-icon { font-size: 18px; }
  `;

  connectedCallback() {
    super.connectedCallback();
    let prevDesktopActive: number | undefined;
    this._unsub = subscribe((s) => {
      const d = s.desktops?.active;
      prevDesktopActive = d;
      // 随帧热更新：设置页「保存并应用」后引擎下一帧即带上新值，无需重启。
      // 旧引擎（未推送该字段）时为 undefined，跳过、保留 fetch 的初值。
      if (typeof s.mouseLeaveReset === 'boolean') {
        this._mouseLeaveReset = s.mouseLeaveReset;
      }
      this.s = s;
    });
    this.addEventListener('card-menu', this._onCardMenu as EventListener);
    this.addEventListener('mouseleave', this._onMouseLeave);
    window.addEventListener('resize', this._syncViewport);
    // 启动初值（首帧 state 到达前的快速读取）；之后由随帧 state.mouseLeaveReset 接管热更新。
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        this._mouseLeaveReset = Boolean(cfg['MOUSE_LEAVE_RESET_TAB'] ?? false);
        this._dockRight = String(cfg['DOCK_SIDE'] ?? 'right') !== 'left';
      })
      .catch(() => {});
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    this.removeEventListener('card-menu', this._onCardMenu as EventListener);
    this.removeEventListener('mouseleave', this._onMouseLeave);
    window.removeEventListener('resize', this._syncViewport);
  }

  override updated(): void {
    const wp = this.s.wallpaper;
    this.style.setProperty('--wp-position-x', this._dockRight ? 'right' : 'left');
    if (wp?.url) {
      // 无壁纸时会显式覆写为纯黑；重新选择壁纸时必须撤销该内联值，
      // 否则降低透明度只会露出黑底而非新的 M3 主题底色。
      this.style.removeProperty('--md-sys-color-surface');
      this.style.setProperty('--wp-url', `url("${wp.url}")`);
      this.style.setProperty('--wp-alpha', String(wp.alpha ?? 0.15));
      this.style.setProperty('--wp-mask', String(1 - Math.max(0, Math.min(1, wp.alpha ?? 0.15))));
      this.style.setProperty('--wp-seed', wp.seed ?? '#4aa3ff');
      this.style.setProperty('--wp-on', '1');
    } else {
      this.style.setProperty('--wp-url', 'none');
      this.style.setProperty('--wp-alpha', '0');
      this.style.setProperty('--wp-mask', '0');
      this.style.setProperty('--wp-on', '0');
      // No current system wallpaper is deliberately a safe, unambiguous
      // state: do not revive an old color or cached image behind the UI.
      this.style.setProperty('--md-sys-color-surface', '#000000');
    }
  }

  private _onCardMenu = (
    e: CustomEvent<{
      hwnd: number;
      x: number;
      y: number;
      pinnedDesktop?: number | null;
      stackId?: number | null;
      role?: number | null;
    }>
  ) => {
    this._menu?.open(
      e.detail.x,
      e.detail.y,
      e.detail.hwnd,
      e.detail.pinnedDesktop ?? null,
      e.detail.stackId ?? null,
      e.detail.role ?? null
    );
  };

  private _onMouseLeave = () => {};

  private _expandSidebar = () => {
    toggleSidebar();
  };

  private _openWidgetMenu = (event: MouseEvent) => {
    event.preventDefault();
    const rect = this.getBoundingClientRect();
    this._widgetMenu = { x: Math.max(6, event.clientX - rect.left), y: Math.max(6, event.clientY - rect.top) };
  };

  private _enterWidgetEdit = () => {
    if (this._widgets?.editing) this._widgets.exitEditMode();
    else this._widgets?.enterEditMode();
    this._widgetMenu = null;
  };

  render() {
    const s = this.s;
    const collapsed = this._isNarrow;
    return html`
      <div id="bar" class=${collapsed ? 'collapsed' : ''}>
        <div id="wp-base" aria-hidden="true"></div>
        <div id="wp" aria-hidden="true"></div>
        <div id="wp-tint" aria-hidden="true"></div>
        ${collapsed
          ? html`
            <button class="collapse-handle" title="展开侧栏" @pointerenter=${this._expandSidebar}>
              <md-icon>${this._dockRight ? 'chevron_left' : 'chevron_right'}</md-icon>
            </button>
          `
          : html`
            <div id="content">
              <window-management
                class="pane active"
                .cards=${s.cards}
                .staged=${s.staged}
                .roles=${s.roles}
              ></window-management>
            </div>
            ${s.widgetsEnabled !== false
              ? html`<widget-panel .state=${s} @contextmenu=${this._openWidgetMenu}></widget-panel>`
              : null}
            <desktop-pager
              .desktops=${s.desktops}
              .cards=${s.cards}
              .roles=${s.roles}
              .mode=${s.desktopPagerMode ?? 'preview'}
            ></desktop-pager>
            <voice-bar .voice=${s.voice}></voice-bar>
          `
        }
      </div>
      ${this._widgetMenu ? html`
        <div class="widget-menu" style="left:${this._widgetMenu.x}px;top:${this._widgetMenu.y}px">
          <button @click=${this._enterWidgetEdit}>
            <md-icon>${this._widgets?.editing ? 'check' : 'tune'}</md-icon>
            ${this._widgets?.editing ? '完成编辑' : '编辑小组件'}
          </button>
        </div>
      ` : null}
      <context-menu .roles=${s.roles}></context-menu>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-root': AppRoot;
  }
}
