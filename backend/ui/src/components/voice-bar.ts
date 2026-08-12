// voice-bar.ts — 底部常驻麦克风状态与波形。语音历史已彻底移除。
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { VoiceState } from '../state.js';

@customElement('voice-bar')
export class VoiceBar extends LitElement {
  @property({ attribute: false }) voice!: VoiceState;

  @state() private _capture: { enabled: boolean; capture?: { state?: string; waveform?: number[]; error?: string; stale?: boolean } } = { enabled: false };
  private _captureTimer?: number;

  connectedCallback() {
    super.connectedCallback();
    void this._refreshCapture();
    this._captureTimer = window.setInterval(() => void this._refreshCapture(), 350);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._captureTimer) window.clearInterval(this._captureTimer);
  }

  static styles = css`
    :host { display: block; position: relative; }
    .vbar { height: 58px; box-sizing: border-box; padding: 5px 6px; border-top: 1px solid var(--md-sys-color-outline-variant, #49454f); user-select: none; }
    .mic-monitor { width: 100%; height: 100%; padding: 0 16px; border: 1px solid var(--md-sys-color-outline-variant, #49454f); border-radius: 999px; display: flex; align-items: center; gap: 10px; background: var(--md-sys-color-surface-container, #211f26); color: var(--md-sys-color-on-surface-variant); cursor: pointer; }
    .mic-monitor:active { transform: scale(.98); }
    .mic-monitor.on { color: #30d158; background: color-mix(in srgb, #30d158 14%, var(--md-sys-color-surface-container, #211f26)); border-color: color-mix(in srgb, #30d158 45%, var(--md-sys-color-outline-variant, #49454f)); }
    .mic-monitor.error { color: #ff453a; background: color-mix(in srgb, #ff453a 14%, var(--md-sys-color-surface-container, #211f26)); border-color: color-mix(in srgb, #ff453a 55%, var(--md-sys-color-outline-variant, #49454f)); }
    .wave { height: 25px; flex: 1; display: flex; gap: 2px; align-items: center; justify-content: center; }
    .wave i { width: 3px; min-height: 2px; max-height: 25px; border-radius: 2px; background: currentColor; opacity: .9; }
    .mic-monitor md-icon { font-size: 21px; }
  `;

  private async _refreshCapture() {
    try {
      const response = await fetch('http://127.0.0.1:7798/v1/voice/state', { cache: 'no-store' });
      if (response.ok) this._capture = await response.json();
    } catch { this._capture = { enabled: false, capture: { state: 'offline' } }; }
  }

  private async _toggleCapture(event: Event) {
    event.stopPropagation();
    try {
      await fetch('http://127.0.0.1:7798/v1/voice/capture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !this._capture.enabled }),
      });
      await this._refreshCapture();
    } catch {}
  }

  private _waveHeights(): number[] {
    const recent = (this._capture.capture?.waveform ?? []).slice(-24);
    const peak = Math.max(0.002, ...recent);
    return recent.map((value) => Math.max(2, Math.round(25 * Math.pow(value / peak, 0.55))));
  }

  render() {
    const problem = this._capture.capture?.state === 'error' || this._capture.capture?.stale;
    return html`<div class="vbar"><button class="mic-monitor ${this._capture.enabled ? 'on' : ''} ${problem ? 'error' : ''}" title=${this._capture.capture?.error || (this._capture.enabled ? '点击释放麦克风' : '点击开始捕获麦克风')} @click=${this._toggleCapture}><md-icon>${problem ? 'mic_off' : 'mic'}</md-icon><span class="wave">${this._waveHeights().map((height) => html`<i style=${`height:${height}px`}></i>`)}</span></button></div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'voice-bar': VoiceBar; } }
