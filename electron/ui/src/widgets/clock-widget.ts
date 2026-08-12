// clock-widget.ts —— 时钟 Widget（大字时间显示）
import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BaseWidget } from './base.js';

@customElement('widget-clock')
export class ClockWidget extends BaseWidget {
  static widgetId = 'clock';
  static widgetTitle = '时钟';
  static widgetIcon = 'schedule';

  static styles = css`
    :host { display: block; width: 100%; box-sizing: border-box; overflow: hidden; }
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
    const s = this.state as { time?: string };
    return html`<div class="time">${s?.time ?? '--:--'}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'widget-clock': ClockWidget; }
}
