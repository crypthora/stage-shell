// window-management.ts —— 窗口管理区：窗口列表 + 快速切换 + 桌面分页。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { StagedWindow } from '../state';
import type { RoleConfig } from '../roles';

import './window-list';
import './staging-area';

@customElement('window-management')
export class WindowManagement extends LitElement {
  @property({ attribute: false }) cards: any[] = [];
  @property({ attribute: false }) staged: StagedWindow[] = [];
  @property({ attribute: false }) roles: RoleConfig[] = [];

  static styles = css`
    :host {
      display: block;
      height: 100%;
      /* Shared Dock gutter: keep the cards comfortably tappable while using
         the narrow sidebar width for content rather than empty margins. */
      padding: 8px 6px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    /* Only the list area scrolls. */
    .list-area {
      /* This is the remainder after widgets and staging. It
         owns overflow so no cards can sit behind another section. */
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 6px 2px;
      scrollbar-width: none;
    }
    .list-area::-webkit-scrollbar {
      display: none;
    }
  `;

  render() {
    const { cards, staged } = this;
    return html`
      <staging-area .staged=${staged} .roles=${this.roles}></staging-area>
      <div class="list-area">
        <window-list .cards=${cards} .roles=${this.roles}></window-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'window-management': WindowManagement;
  }
}
