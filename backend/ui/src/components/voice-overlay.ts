// voice-overlay.ts —— CapsLock 按住说话浮层：脉动圆点 + 识别文字。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { VoiceState } from '../state';

@customElement('voice-overlay')
export class VoiceOverlay extends LitElement {
  @property({ attribute: false }) voice!: VoiceState;

  static styles = css`
    :host {
      display: block;
    }
    .ov {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-radius: 14px;
      background: var(--md-sys-color-surface-container-high);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      animation: rise 0.18s ease;
    }
    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: #ff3b30;
    }
    .listening .dot {
      animation: pulse 1.1s ease-in-out infinite;
    }
    .recognizing .dot {
      background: #f5b942;
    }
    .error .dot {
      background: #ff3b30;
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 0.35;
        transform: scale(0.85);
      }
      50% {
        opacity: 1;
        transform: scale(1.1);
      }
    }
    .txt {
      font-size: 13px;
      line-height: 1.35;
      color: var(--md-sys-color-on-surface);
      word-break: break-word;
    }
    .error .txt {
      color: var(--md-sys-color-error);
    }
  `;

  render() {
    const v = this.voice;
    if (!v || !v.visible) return nothing;
    return html`
      <div class="ov ${v.mode}">
        <div class="dot"></div>
        <div class="txt">${v.text}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'voice-overlay': VoiceOverlay;
  }
}
