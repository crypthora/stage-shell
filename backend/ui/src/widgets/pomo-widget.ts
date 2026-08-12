// pomo-widget.ts —— 番茄钟 Widget：倒计时 + 进度环 + 控制按钮
import { html, css, svg, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BaseWidget } from './base.js';
import { widgetCommand } from '../bridge.js';

interface PomoState {
  phase: 'idle' | 'work' | 'break' | 'done';
  running: boolean;
  left: string;       // "MM:SS"
  fraction: number;   // 0~1，剩余时间比例
  breathe: string | null;
}

const PHASE_LABEL: Record<string, string> = {
  idle: '准备开始',
  work: '专注中',
  break: '休息',
  done: '休息结束',
};

const PHASE_COLOR: Record<string, string> = {
  idle:  'var(--md-sys-color-on-surface-variant)',
  work:  'var(--md-sys-color-primary)',
  break: '#5b8c6e',
  done:  '#5b7a9c',
};

// 进度环 SVG 参数
const R = 36, CX = 44, CY = 44, CIRC = 2 * Math.PI * R;

@customElement('widget-pomo')
export class PomoWidget extends BaseWidget {
  static widgetId = 'pomo';
  static widgetTitle = '番茄钟';
  static widgetIcon = 'timer';

  static styles = css`
    :host { display: block; width: 100%; box-sizing: border-box; overflow: hidden; }
    .card {
      padding: 12px 14px;
      border-radius: 16px;
      background: var(--md-sys-color-surface-container-high, #2b2930);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    /* ── 进度环 ── */
    .ring-wrap {
      position: relative;
      width: 88px;
      height: 88px;
    }
    svg { overflow: visible; }
    .ring-bg { fill: none; stroke: var(--md-sys-color-surface-container-highest, #36343b); stroke-width: 5; }
    .ring-fg { fill: none; stroke-width: 5; stroke-linecap: round;
               transition: stroke-dashoffset .6s ease, stroke .4s; }
    .ring-center {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
    }
    .time-text {
      font-family: 'Segoe UI Variable Display', 'Segoe UI', sans-serif;
      font-weight: 300;
      font-size: 20px;
      letter-spacing: -0.5px;
      color: var(--md-sys-color-on-surface);
      line-height: 1;
    }
    .phase-label {
      font-size: 9px;
      color: var(--md-sys-color-on-surface-variant);
      text-transform: uppercase;
      letter-spacing: .06em;
    }

    /* ── 按钮行 ── */
    .btn-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .btn {
      border: none;
      border-radius: 20px;
      padding: 6px 16px;
      font-size: 12px;
      cursor: pointer;
      transition: background .15s;
    }
    .btn-primary {
      background: var(--md-sys-color-primary, #d0bcff);
      color: var(--md-sys-color-on-primary, #381e72);
      font-weight: 600;
    }
    .btn-primary:hover { filter: brightness(0.9); }
    .btn-ghost {
      background: var(--md-sys-color-surface-container, #211f26);
      color: var(--md-sys-color-on-surface-variant);
    }
    .btn-ghost:hover { background: var(--md-sys-color-surface-container-highest, #36343b); }
  `;

  private _cmd(cmd: string) {
    widgetCommand('pomo', cmd);
  }

  render() {
    const s = (this.state ?? {}) as PomoState;
    const phase = s.phase ?? 'idle';
    const frac  = s.fraction ?? 0;
    const color = PHASE_COLOR[phase] ?? PHASE_COLOR.idle;

    // 剩余比例 → dashoffset（从顶部顺时针走）
    const dashOffset = CIRC * (1 - frac);

    const toggleLabel =
      phase === 'idle'    ? '开始' :
      phase === 'done'    ? '重置' :
      s.running           ? '暂停' : '继续';

    return html`
      <div class="card">
        <div class="ring-wrap">
          ${svg`
            <svg viewBox="0 0 88 88" width="88" height="88">
              <circle class="ring-bg" cx=${CX} cy=${CY} r=${R}/>
              <circle class="ring-fg"
                cx=${CX} cy=${CY} r=${R}
                stroke=${color}
                stroke-dasharray=${CIRC}
                stroke-dashoffset=${dashOffset}
                transform="rotate(-90 ${CX} ${CY})"
              />
            </svg>
          `}
          <div class="ring-center">
            <span class="time-text">${s.left ?? '--:--'}</span>
            <span class="phase-label">${PHASE_LABEL[phase] ?? phase}</span>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" @click=${() => this._cmd('toggle')}>
            ${toggleLabel}
          </button>
          ${phase !== 'idle'
            ? html`<button class="btn btn-ghost" @click=${() => this._cmd('reset')}>重置</button>`
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'widget-pomo': PomoWidget; }
}
