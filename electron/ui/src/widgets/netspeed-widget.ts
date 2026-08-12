// netspeed-widget.ts —— 实时网速 Widget（↑ 上传 / ↓ 下载）
import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BaseWidget } from './base.js';

interface NetState { up: number; down: number; upFmt: string; downFmt: string; }

@customElement('widget-netspeed')
export class NetspeedWidget extends BaseWidget {
  static widgetId = 'netspeed';
  static widgetTitle = '网速';
  static widgetIcon = 'network_check';

  static styles = css`
    :host { display: block; width: 100%; box-sizing: border-box; overflow: hidden; }
    .card {
      padding: 10px 14px;
      border-radius: 16px;
      background: var(--md-sys-color-surface-container-high, #2b2930);
      display: flex;
      gap: 0;
    }
    .half {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    .half + .half {
      border-left: 1px solid var(--md-sys-color-outline-variant, #49454f);
    }
    .arrow {
      font-size: 18px;
      line-height: 1;
    }
    .up-arrow   { color: var(--md-sys-color-primary, #d0bcff); }
    .down-arrow { color: #7dd3a8; }
    .speed {
      font-size: 13px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--md-sys-color-on-surface);
      white-space: nowrap;
    }
    .label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .07em;
      color: var(--md-sys-color-on-surface-variant);
    }
  `;

  render() {
    const s = (this.state ?? {}) as NetState;
    return html`
      <div class="card">
        <div class="half">
          <md-icon class="arrow up-arrow">arrow_upward</md-icon>
          <span class="speed">${s.upFmt ?? '-- B/s'}</span>
          <span class="label">上传</span>
        </div>
        <div class="half">
          <md-icon class="arrow down-arrow">arrow_downward</md-icon>
          <span class="speed">${s.downFmt ?? '-- B/s'}</span>
          <span class="label">下载</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'widget-netspeed': NetspeedWidget; }
}
