// control-center.ts —— 控制中心：Widget 面板。
// （语音历史栏已上移到 app-root，作为常驻底栏显示在桌面切换器之下，跨标签页可见。）
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { State } from '../state.js';

import './widget-panel.js';

@customElement('control-center')
export class ControlCenter extends LitElement {
  @property({ attribute: false }) state!: State;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    widget-panel {
      flex: 1 1 0;
      min-height: 0;
    }
  `;

  render() {
    const s = this.state;
    return html`
      <widget-panel .state=${s}></widget-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'control-center': ControlCenter;
  }
}
