// clock-pomodoro.ts —— 时钟显示。
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('clock-pomodoro')
export class ClockPomodoro extends LitElement {
  @property({ attribute: false }) clock = '--:--';

  static styles = css`
    :host {
      display: block;
    }
    .time {
      font-family: 'Segoe UI Variable Display', 'Segoe UI', 'Roboto', sans-serif;
      font-weight: 300;
      font-size: 52px;
      line-height: 1;
      letter-spacing: -1px;
      color: var(--md-sys-color-on-surface);
      text-align: center;
      padding: 16px 4px 14px;
    }
  `;

  render() {
    return html`<div class="time">${this.clock}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'clock-pomodoro': ClockPomodoro;
  }
}
