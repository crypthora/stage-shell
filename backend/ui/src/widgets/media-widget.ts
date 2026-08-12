// media-widget.ts —— 媒体播放 Widget（封面 + 曲名 + 控制按钮）
import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BaseWidget } from './base.js';
import type { MediaState } from '../state.js';
import { mediaPlayPause, mediaNext, mediaPrev, focusMediaApp } from '../bridge.js';

@customElement('widget-media')
export class MediaWidget extends BaseWidget {
  static widgetId = 'media';
  static widgetTitle = '媒体播放';
  static widgetIcon = 'music_note';

  static styles = css`
    :host { display: block; min-width: 0; width: 100%; box-sizing: border-box; overflow: hidden; }
    .card {
      position: relative;
      display: block;
      padding: 10px 12px;
      border-radius: 16px;
      background: var(--md-sys-color-surface-container-high, #2b2930);
      overflow: hidden;
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
    }
    .top-row {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .cover {
      width: 42px;
      height: 42px;
      border-radius: 10px;
      object-fit: cover;
      flex: 0 0 auto;
      background: var(--md-sys-color-surface-container-highest, #36343b);
      cursor: pointer;
    }
    .cover.placeholder {
      display: grid;
      place-items: center;
      color: var(--md-sys-color-on-surface-variant);
      cursor: pointer;
    }
    .meta { flex: 1 1 0; min-width: 0; overflow: hidden; }
    .title {
      font-size: 13px;
      font-weight: 500;
      color: var(--md-sys-color-on-surface);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .artist {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
    }
    .controls {
      display: flex;
      align-items: center;
      justify-content: space-evenly;
      padding: 0 4px;
      margin-top: 6px;
      overflow: hidden;
      min-width: 0;
    }
    md-icon-button {
      --md-icon-button-icon-size: 18px;
      width: 32px; height: 32px;
      flex: 0 0 auto;
    }
    .pp {
      --md-icon-button-icon-size: 22px;
      width: 36px; height: 36px;
    }
  `;

  private _onCoverClick() {
    focusMediaApp();
  }

  render() {
    const m = this.state as MediaState;
    if (!m?.active) return nothing;
    return html`
      <div class="card">
        <div class="top-row">
          ${m.cover
            ? html`<img class="cover" src=${m.cover} alt="" @click=${this._onCoverClick} />`
            : html`<div class="cover placeholder" @click=${this._onCoverClick}><md-icon>music_note</md-icon></div>`}
          <div class="meta">
            <div class="title">${m.title || '未知曲目'}</div>
            <div class="artist">${m.artist || ''}</div>
          </div>
        </div>
        <div class="controls">
          <md-icon-button @click=${() => mediaPrev()} aria-label="上一首">
            <md-icon>skip_previous</md-icon>
          </md-icon-button>
          <md-icon-button class="pp" @click=${() => mediaPlayPause()} aria-label="播放/暂停">
            <md-icon>${m.isPlaying ? 'pause' : 'play_arrow'}</md-icon>
          </md-icon-button>
          <md-icon-button @click=${() => mediaNext()} aria-label="下一首">
            <md-icon>skip_next</md-icon>
          </md-icon-button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'widget-media': MediaWidget; }
}
