// sysmon-widget.ts —— 系统监控 Widget（CPU / RAM 进度条）
import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BaseWidget } from './base.js';

interface SysmonState { cpu: number; ram: number; ramUsed: number; ramTotal: number; }

@customElement('widget-sysmon')
export class SysmonWidget extends BaseWidget {
  static widgetId = 'sysmon';
  static widgetTitle = '系统监控';
  static widgetIcon = 'monitoring';

  static styles = css`
    :host { display: block; width: 100%; box-sizing: border-box; overflow: hidden; }
    .card {
      padding: 10px 12px;
      border-radius: 16px;
      background: var(--md-sys-color-surface-container-high, #2b2930);
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
      overflow: hidden;
    }
    .row { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .label {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant);
      min-width: 0;
      gap: 4px;
    }
    .label .val {
      color: var(--md-sys-color-on-surface);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 1;
      min-width: 0;
    }
    .bar {
      height: 5px;
      border-radius: 3px;
      background: var(--md-sys-color-surface-container-highest, #36343b);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      border-radius: 3px;
      background: var(--md-sys-color-primary, #d0bcff);
      transition: width 0.4s ease;
    }
    .fill.warn { background: var(--md-sys-color-error, #f2b8b5); }
  `;

  render() {
    const s = (this.state ?? {}) as SysmonState;
    const cpu = s.cpu ?? 0;
    const ram = s.ram ?? 0;
    return html`
      <div class="card">
        <div class="row">
          <div class="label">
            <span>CPU</span>
            <span class="val">${cpu.toFixed(1)}%</span>
          </div>
          <div class="bar">
            <div class="fill ${cpu > 80 ? 'warn' : ''}" style="width:${cpu}%"></div>
          </div>
        </div>
        <div class="row">
          <div class="label">
            <span>内存</span>
            <span class="val">${ram.toFixed(1)}% · ${(s.ramUsed ?? 0).toFixed(1)} / ${(s.ramTotal ?? 0).toFixed(1)} GB</span>
          </div>
          <div class="bar">
            <div class="fill ${ram > 80 ? 'warn' : ''}" style="width:${ram}%"></div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'widget-sysmon': SysmonWidget; }
}
