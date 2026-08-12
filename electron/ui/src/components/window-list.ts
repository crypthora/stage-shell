// window-list.ts —— 窗口卡片列表（用 hwnd 做 key，复用 DOM、保持图片缓存）。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { CardState } from '../state';
import type { RoleConfig } from '../roles';
import { drag, type DropTarget } from '../drag';
import './window-card';
import type { WindowCard } from './window-card';

@customElement('window-list')
export class WindowList extends LitElement {
  @property({ attribute: false }) cards: CardState[] = [];
  @property({ attribute: false }) roles: RoleConfig[] = [];
  private _unregister?: () => void;

  firstUpdated() {
    // 把每张窗口卡登记为落点（拖到卡上=堆叠成夹）；排除正在被拖的那张。
    this._unregister = drag.registerProvider(() => {
      const src = drag.sourceHwnd;
      const cards = Array.from(
        this.renderRoot.querySelectorAll('window-card')
      ) as WindowCard[];
      // 每张可见卡都登记为落点；落点模式（叠放/上插/下插）由 drag._hit 按指针高度算。
      // 组叠到组由引擎 stack_cards 兜底 no-op，这里不再排除夹子（否则无法在夹子前后插入）。
      return cards
        .filter((el) => el.card && el.card.hwnd !== src)
        .map(
          (el): DropTarget => ({
            kind: 'card',
            idx: -1,
            number: el.card.hwnd,
            rect: el.getBoundingClientRect(),
          })
        );
    });
  }

  disconnectedCallback() {
    this._unregister?.();
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      display: block;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .empty {
      text-align: center;
      color: var(--md-sys-color-on-surface-variant);
      font-size: 12px;
      opacity: 0.6;
      padding: 24px 8px;
    }
  `;

  render() {
    const visible = this.cards?.filter((c) => c.visible) ?? [];
    if (visible.length === 0) {
      return html`<div class="empty">暂无其它窗口</div>`;
    }
    return html`
      <div class="list">
        ${repeat(
          this.cards,
          (c) => (c.stackId != null ? 's' + c.stackId : String(c.hwnd)),
          (c) => html`<window-card .card=${c} .roles=${this.roles} ?hidden=${!c.visible}></window-card>`
        )}
      </div>
      ${nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'window-list': WindowList;
  }
}
