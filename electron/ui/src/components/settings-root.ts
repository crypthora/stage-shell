// settings-root.ts —— MD3 设置表单，通过 /api/config (GET/POST) 读写配置。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

type CfgMap = Record<string, unknown>;

@customElement('settings-root')
export class SettingsRoot extends LitElement {
  @state() private cfg: CfgMap = {};
  @state() private loading = true;
  @state() private dirty = false;
  @state() private saving = false;
  @state() private toast: { msg: string; ok: boolean } | null = null;
  @state() private wpBusy = false; // 壁纸上传/清除进行中
  @state() private wpErr = false; // 预览图加载失败（无壁纸资源）
  @state() private wpUrl: string | null = null; // 与 Dock 状态使用同一个内容指纹 URL
  @state() private voiceCore: { url?: string; model?: string; language?: string; context?: string; apiKey?: string; stream?: boolean; editorTheme?: 'system' | 'light' | 'dark'; devTools?: boolean } = {};

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
    }

    /* ── 顶栏 ── */
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 24px;
      height: 64px;
      background: var(--md-sys-color-surface-container);
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
    }
    .top-bar md-icon {
      color: var(--md-sys-color-primary);
      font-size: 24px;
    }
    .top-bar-title {
      font-size: 22px;
      font-weight: 400;
      letter-spacing: 0;
      color: var(--md-sys-color-on-surface);
    }

    /* ── 内容区 ── */
    .content {
      max-width: 680px;
      margin: 0 auto;
      padding: 28px 20px 100px;
    }

    /* ── 分组 ── */
    .section {
      margin-bottom: 28px;
    }
    .section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      padding: 0 4px;
      color: var(--md-sys-color-primary);
    }
    .section-header md-icon {
      font-size: 18px;
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }

    /* ── 行容器 ── */
    .rows {
      background: var(--md-sys-color-surface-container-low);
      border-radius: 16px;
      overflow: hidden;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 56px;
      padding: 10px 20px;
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
    }
    .row:last-child {
      border-bottom: none;
    }
    .row.stacked {
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
    }

    /* ── 标签 ── */
    .row-label {
      flex: 1;
      min-width: 0;
      font-size: 14px;
      color: var(--md-sys-color-on-surface);
      display: flex;
      align-items: center;
      gap: 8px;
      line-height: 1.4;
    }
    .restart-badge {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.2px;
      color: var(--md-sys-color-tertiary);
      background: var(--md-sys-color-tertiary-container);
      padding: 2px 7px;
      border-radius: 10px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* ── 颜色输入 ── */
    .color-cell {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .color-swatch {
      position: relative;
      width: 44px;
      height: 28px;
      border-radius: 8px;
      border: 2px solid var(--md-sys-color-outline);
      overflow: hidden;
      cursor: pointer;
      flex-shrink: 0;
    }
    .color-swatch input[type='color'] {
      position: absolute;
      inset: -6px;
      opacity: 0;
      cursor: pointer;
      width: calc(100% + 12px);
      height: calc(100% + 12px);
    }
    .color-value {
      font-size: 12px;
      font-family: 'Roboto Mono', monospace;
      color: var(--md-sys-color-on-surface-variant);
      letter-spacing: 0.5px;
    }

    /* ── 数字 / 文本字段 ── */
    .num-field {
      width: 130px;
      flex-shrink: 0;
    }
    .text-field {
      width: 210px;
      flex-shrink: 0;
    }

    /* ── 角色编辑行 ── */
    .role-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .role-label-field {
      width: 100px;
      flex-shrink: 0;
    }

    /* ── 滑块行 ── */
    .slider-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .slider-val {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant);
    }
    md-slider {
      width: 100%;
    }

    /* ── Select ── */
    md-outlined-select {
      min-width: 155px;
      flex-shrink: 0;
    }

    /* ── Switch ── */
    md-switch {
      flex-shrink: 0;
    }

    /* ── 底栏 ── */
    .footer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 24px;
      background: var(--md-sys-color-surface-container);
      border-top: 1px solid var(--md-sys-color-outline-variant);
    }
    .restart-note {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant);
      transition: opacity 0.2s;
    }
    .restart-note.hidden {
      opacity: 0;
      pointer-events: none;
    }
    .restart-note md-icon {
      font-size: 16px;
      color: var(--md-sys-color-tertiary);
    }
    .footer-actions {
      display: flex;
      gap: 10px;
    }

    /* ── 提示条 Toast ── */
    .toast {
      position: fixed;
      bottom: 72px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 200;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      border-radius: 28px;
      font-size: 14px;
      white-space: nowrap;
      pointer-events: none;
      animation: toast-in 0.2s ease;
    }
    .toast.ok {
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
    }
    .toast.err {
      background: var(--md-sys-color-error-container);
      color: var(--md-sys-color-on-error-container);
    }
    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    }

    /* ── 加载态 ── */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 60vh;
      gap: 12px;
      color: var(--md-sys-color-on-surface-variant);
      font-size: 15px;
    }

    /* ── 壁纸 ── */
    .wp-cell {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .wp-preview {
      width: 96px;
      height: 60px;
      border-radius: 10px;
      overflow: hidden;
      flex-shrink: 0;
      border: 1px solid var(--md-sys-color-outline-variant);
      background: var(--md-sys-color-surface-container-high);
    }
    .wp-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .wp-empty {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--md-sys-color-on-surface-variant);
    }
    .wp-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    await this._load();
  }

  private async _load() {
    this.loading = true;
    try {
      const r = await fetch('/api/config');
      this.cfg = await r.json();
    } catch (_) {}
    try {
      this.voiceCore = await fetch('http://127.0.0.1:7798/v1/voice/config', { cache: 'no-store' }).then(r => r.json());
    } catch (_) {}
    await this._syncWallpaperPreview();
    this.loading = false;
    this.dirty = false;
  }

  private async _syncWallpaperPreview() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const state = await r.json() as { wallpaper?: { url?: string | null } };
      this.wpUrl = state.wallpaper?.url ?? null;
      this.wpErr = !this.wpUrl;
    } catch (_) {
      this.wpUrl = null;
      this.wpErr = true;
    }
  }

  private _set(key: string, val: unknown) {
    this.cfg = { ...this.cfg, [key]: val };
    this.dirty = true;
  }

  private async _saveVoiceCore(update: Record<string, unknown>) {
    try {
      const response = await fetch('http://127.0.0.1:7798/v1/voice/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
      });
      if (!response.ok) throw new Error('save failed');
      this.voiceCore = { ...this.voiceCore, ...update, apiKey: update.apiKey ? 'configured' : this.voiceCore.apiKey };
      this._showToast('Electron 语音核心设置已保存', true);
    } catch {
      this._showToast('Electron 语音核心未运行', false);
    }
  }

  private async _save() {
    this.saving = true;
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.cfg),
      });
      const d = await r.json();
      this._showToast(d.ok ? '设置已保存' : '保存失败', !!d.ok);
      if (d.ok) this.dirty = false;
    } catch (_) {
      this._showToast('保存失败：网络错误', false);
    }
    this.saving = false;
  }

  private async _restartDock() {
    try {
      const r = await fetch('/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'restartDock', args: [] }),
      });
      const d = await r.json();
      this._showToast(d.ok ? 'Dock 正在重启…' : '重启请求失败', !!d.ok);
    } catch (_) {
      this._showToast('重启请求失败：网络错误', false);
    }
  }

  private async _recoverCapsHotkey() {
    try {
      const r = await fetch('/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'recoverCapsHotkey', args: [] }),
      });
      const d = await r.json();
      this._showToast(d.ok ? 'CapsLock 热键已重新挂钩' : '重新挂钩请求失败', !!d.ok);
    } catch (_) {
      this._showToast('重新挂钩请求失败：网络错误', false);
    }
  }

  private _showToast(msg: string, ok: boolean) {
    this.toast = { msg, ok };
    setTimeout(() => {
      this.toast = null;
    }, 2800);
  }

  // ────────────────────────── render ──────────────────────────

  render() {
    const header = html`
      <div class="top-bar">
        <md-icon>settings</md-icon>
        <span class="top-bar-title">侧栏 M3 · 设置</span>
      </div>
    `;

    if (this.loading) {
      return html`
        ${header}
        <div class="loading">
          <md-icon>hourglass_top</md-icon>
          加载配置…
        </div>
      `;
    }

    const c = this.cfg;
    const str = (k: string, def = '') => String(c[k] ?? def);
    const num = (k: string, def: number) => Number(c[k] ?? def);
    const bool = (k: string, def = false): boolean =>
      c[k] == null ? def : Boolean(c[k]);

    return html`
      ${header}

      <div class="content">
        ${this._section(
          'palette',
          '外观（自动配色）',
          html`
            <div class="row"><span class="row-label">主题色从当前选择的壁纸自动计算，不能手动保存或覆盖。</span></div>
            ${this._sliderRow(
              '图标透明度',
              num('ICON_OPACITY', 0.8),
              0,
              1,
              0.05,
              (v) => this._set('ICON_OPACITY', Math.round(v * 100) / 100),
            )}
            ${this._switchRow('显示窗口缩略图', bool('SHOW_THUMBNAIL', true), (v) =>
              this._set('SHOW_THUMBNAIL', v))}
          `,
        )}

        ${this._rolesSection()}

        ${this._section(
          'wallpaper',
          '壁纸 / 主题',
          html`
            ${this._switchRow(
              '启用壁纸背景与取色',
              bool('WALLPAPER_ENABLED', true),
              (v) => this._set('WALLPAPER_ENABLED', v),
            )}
            ${this._sliderRow(
              '壁纸透明度',
              num('WALLPAPER_ALPHA', 0.15),
              0,
              1,
              0.05,
              (v) => this._set('WALLPAPER_ALPHA', Math.round(v * 100) / 100),
            )}
            ${this._wallpaperRow(str('WALLPAPER_PATH', ''))}
          `,
        )}

        ${this._section(
          'mic',
          'Electron 常驻麦克风 / 识别服务',
          html`
            <div class="row"><span class="row-label">麦克风由底栏波形按钮独占；关闭即立即释放设备。识别端不允许再自行打开麦克风。</span></div>
            <div class="row">
              <span class="row-label">CapsLock 无响应时可重新挂钩；诊断写入 <code>%APPDATA%\\stage-shell\\caps-hotkey.log</code>。</span>
              <md-outlined-button @click=${this._recoverCapsHotkey}><md-icon>keyboard</md-icon>重新挂钩</md-outlined-button>
            </div>
            ${this._textRow('识别地址', this.voiceCore.url ?? '', (v) => void this._saveVoiceCore({ url: v }))}
            <div class="row"><span class="row-label">OpenAI：填 <code>http://主机:端口/v1</code>；Qwen ASR：填 <code>ws://主机:10095</code>。Qwen 为松开后返回最终结果的非流式协议。</span></div>
            ${this._textRow('OpenAI 模型', this.voiceCore.model ?? 'gpt-4o-mini-transcribe', (v) => void this._saveVoiceCore({ model: v }))}
            ${this._textRow('语言', this.voiceCore.language ?? 'zh', (v) => void this._saveVoiceCore({ language: v }))}
            <div class="row">
              <span class="row-label">识别术语<br><small>一行一个；只保留真正需要偏置的少量词。</small></span>
              <md-outlined-text-field class="text-field" type="textarea" rows="7" .value=${this.voiceCore.context ?? ''}
                @change=${(e: Event) => void this._saveVoiceCore({ context: (e.target as HTMLInputElement).value })}></md-outlined-text-field>
            </div>
            <div class="row"><span class="row-label">Qwen ASR 将它们组合为简短的“术语表”提示，而非加权热词表；OpenAI 兼容接口使用标准 <code>prompt</code>。“键权”会在转写后规范为“鉴权”。</span></div>
            ${this._switchRow('使用 OpenAI 兼容 SSE 流式响应', Boolean(this.voiceCore.stream), (v) => void this._saveVoiceCore({ stream: v }))}
            ${this._selectRow('语音编辑器外观', this.voiceCore.editorTheme ?? 'system', [
              ['system', '跟随 Windows'], ['light', '始终浅色'], ['dark', '始终深色'],
            ], (v) => void this._saveVoiceCore({ editorTheme: v }))}
            ${this._switchRow('启动时打开所有组件开发工具', Boolean(this.voiceCore.devTools), (v) => void this._saveVoiceCore({ devTools: v }))}
            <div class="row">
              <span class="row-label">API 密钥</span>
              <md-outlined-text-field class="text-field" type="password" placeholder=${this.voiceCore.apiKey === 'configured' ? '已配置；留空不改变' : '可留空'}
                @change=${(e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) void this._saveVoiceCore({ apiKey: v }); }}></md-outlined-text-field>
            </div>
          `,
        )}

        ${this._section(
          'view_sidebar',
          '布局',
          html`
            ${this._selectRow(
              '停靠方向',
              str('DOCK_SIDE', 'right'),
              [
                ['right', '右侧停靠'],
                ['left', '左侧停靠'],
              ],
              (v) => this._set('DOCK_SIDE', v),
              true,
            )}
            ${this._numRow('侧栏宽度 px', num('BAR_W', 300), 200, 600, 10, (v) =>
              this._set('BAR_W', v), true)}
            ${this._sliderRow(
              'UI 缩放（整体大小）',
              num('UI_SCALE', 1.0),
              0.5,
              1.5,
              0.05,
              (v) => this._set('UI_SCALE', Math.round(v * 100) / 100),
              true,
            )}
            ${this._switchRow(
              '保留屏幕空间（AppBar）',
              bool('RESERVE_SPACE', true),
              (v) => this._set('RESERVE_SPACE', v),
              true,
            )}
            ${this._switchRow(
              '启用小组件',
              bool('WIDGETS_ENABLED', true),
              (v) => this._set('WIDGETS_ENABLED', v),
            )}
            ${this._selectRow(
              '侧栏收起后',
              str('SIDEBAR_HIDE_MODE', 'handle'),
              [
                ['handle', '显示几像素把手，鼠标滑过自动展开'],
                ['always', '永远展示'],
              ],
              (v) => this._set('SIDEBAR_HIDE_MODE', v),
            )}
            ${this._numRow(
              '最大窗口卡片数',
              num('MAX_CARDS', 5),
              1,
              20,
              1,
              (v) => this._set('MAX_CARDS', v),
            )}
            ${this._numRow('刷新间隔 ms', num('REFRESH_MS', 700), 100, 5000, 100, (v) =>
              this._set('REFRESH_MS', v))}
            ${this._numRow(
              '桌面分页列数',
              num('PAGER_MAX', 4),
              2,
              8,
              1,
              (v) => this._set('PAGER_MAX', v),
            )}
            ${this._selectRow(
              '桌面分页显示',
              str('DESKTOP_PAGER_MODE', 'preview'),
              [
                ['preview', '缩略图预览'],
                ['icons', '仅显示图标'],
              ],
              (v) => this._set('DESKTOP_PAGER_MODE', v),
            )}
            ${this._switchRow(
              '鼠标离开侧栏时自动回到窗口列表',
              bool('MOUSE_LEAVE_RESET_TAB', false),
              (v) => this._set('MOUSE_LEAVE_RESET_TAB', v),
            )}
          `,
        )}

        ${this._section(
          'timer',
          '番茄钟',
          html`
            ${this._numRow(
              '工作时长（分钟）',
              Math.round(num('WORK_SEC', 1500) / 60),
              1,
              120,
              1,
              (v) => this._set('WORK_SEC', v * 60),
            )}
            ${this._numRow(
              '休息时长（分钟）',
              Math.round(num('BREAK_SEC', 300) / 60),
              1,
              60,
              1,
              (v) => this._set('BREAK_SEC', v * 60),
            )}
            ${this._switchRow('声音提示', bool('SOUND_ENABLED', true), (v) =>
              this._set('SOUND_ENABLED', v))}
          `,
        )}

        ${this._section(
          'mic',
          '语音 / PTT',
          html`
            ${this._switchRow(
              '启用语音识别（CapsWriter）',
              bool('VOICE_ENABLED', true),
              (v) => this._set('VOICE_ENABLED', v),
            )}
            ${this._textRow('识别服务地址', str('VOICE_ADDR', '127.0.0.1'), (v) =>
              this._set('VOICE_ADDR', v))}
            ${this._textRow('识别服务端口', str('VOICE_PORT', '6016'), (v) =>
              this._set('VOICE_PORT', v))}
            ${this._selectRow(
              '识别语言',
              Array.isArray(c['VOICE_LANGUAGE']) ? 'zh' : str('VOICE_LANGUAGE', 'auto'),
              [
                ['auto', '自动检测（多语言）'],
                ['zh', '中文（普通话）'],
                ['en', '英语'],
                ['yue', '粤语'],
                ['ja', '日语'],
                ['ko', '韩语'],
                ['fr', '法语'],
                ['de', '德语'],
                ['ru', '俄语'],
              ],
              (v) => this._set('VOICE_LANGUAGE', v),
              true,
            )}
            ${this._selectRow(
              'PTT 触发模式',
              str('PTT_MODE', 'hold'),
              [
                ['hold', '按住说话 (Hold)'],
                ['toggle', '开关切换 (Toggle)'],
              ],
              (v) => this._set('PTT_MODE', v),
            )}
            ${this._numRow(
              '最短按住时长 s',
              num('MIN_HOLD_S', 0.15),
              0.05,
              2.0,
              0.05,
              (v) => this._set('MIN_HOLD_S', v),
            )}
            ${this._numRow(
              '识别等待超时 s',
              num('RESULT_TIMEOUT', 10.0),
              1,
              60,
              1,
              (v) => this._set('RESULT_TIMEOUT', v),
            )}
            ${this._numRow(
              '连接超时 s',
              num('CONNECT_TIMEOUT', 2.0),
              0.5,
              10,
              0.5,
              (v) => this._set('CONNECT_TIMEOUT', v),
            )}
            ${this._switchRow('识别后恢复剪贴板', bool('INSERT_RESTORE_CLIP', true), (v) =>
              this._set('INSERT_RESTORE_CLIP', v))}
            <div class="row" style="flex-direction:column;align-items:stretch;gap:6px;padding-bottom:4px">
              <span class="row-label" style="font-size:12px;color:var(--md-sys-color-on-surface-variant);line-height:1.6">
                <b>识别上下文</b>——填容易被误识别的专有名词、英文缩写、人名、应用名等（每行一条或用顿号分隔）。<br>
                例：<code>Claude、WebSocket、API网关、张明总监、Paraformer</code><br>
                将只按填写内容作为识别上下文发送。
              </span>
              <md-outlined-text-field
                type="textarea"
                rows="4"
                style="width:100%;box-sizing:border-box"
                .value=${str('VOICE_CONTEXT', '')}
                placeholder="Claude、WebSocket、API、张明、项目名..."
                @change=${(e: Event) => this._set('VOICE_CONTEXT', (e.target as HTMLInputElement).value)}
              ></md-outlined-text-field>
            </div>
          `,
        )}

      </div>

      <div class="footer">
        <div class="restart-note ${this.dirty ? '' : 'hidden'}">
          <md-icon>restart_alt</md-icon>
          标有 ⚠ 的项保存后需重启侧栏生效
        </div>
        <div class="footer-actions">
          <md-outlined-button @click=${this._restartDock}>
            <md-icon>restart_alt</md-icon>重启 Dock
          </md-outlined-button>
          <md-outlined-button
            ?disabled=${!this.dirty || this.saving}
            @click=${() => this._load()}
          >
            放弃更改
          </md-outlined-button>
          <md-filled-button
            ?disabled=${!this.dirty || this.saving}
            @click=${() => this._save()}
          >
            ${this.saving ? '保存中…' : '保存设置'}
          </md-filled-button>
        </div>
      </div>

      ${this.toast
        ? html`
            <div class="toast ${this.toast.ok ? 'ok' : 'err'}">
              <md-icon>${this.toast.ok ? 'check_circle' : 'error'}</md-icon>
              ${this.toast.msg}
            </div>
          `
        : nothing}
    `;
  }

  // ────────────────────────── helpers ──────────────────────────

  private _section(icon: string, title: string, rows: unknown) {
    return html`
      <div class="section">
        <div class="section-header">
          <md-icon>${icon}</md-icon>
          <span class="section-title">${title}</span>
        </div>
        <div class="rows">${rows}</div>
      </div>
    `;
  }

  private _rolesSection() {
    const defaultRoles = [
      { label: '个人', color: '#10D479' },
      { label: '工作', color: '#1B73FF' },
      { label: '隐私', color: '#FF2525' },
      { label: '专注', color: '#FFB300' },
      { label: '创意', color: '#A033FF' },
      { label: '社交', color: '#FF2D92' },
    ];
    const roles: { label: string; color: string }[] =
      Array.isArray(this.cfg['ROLES']) ? (this.cfg['ROLES'] as { label: string; color: string }[]) : defaultRoles;

    const updateRole = (idx: number, patch: Partial<{ label: string; color: string }>) => {
      const next = roles.map((r, i) => (i === idx ? { ...r, ...patch } : r));
      this._set('ROLES', next);
    };

    return this._section(
      'label',
      '角色标记',
      html`${roles.map(
        (r, i) => html`
          <div class="row">
            <span class="row-label" style="min-width:32px; flex:none">#${i + 1}</span>
            <div class="role-controls">
              <md-outlined-text-field
                class="role-label-field"
                .value=${r.label}
                @change=${(e: Event) =>
                  updateRole(i, { label: (e.target as HTMLInputElement).value })}
              ></md-outlined-text-field>
              <div
                class="color-swatch"
                style="background:${r.color}"
                title="点击选色"
              >
                <input
                  type="color"
                  .value=${r.color}
                  @input=${(e: Event) =>
                    updateRole(i, { color: (e.target as HTMLInputElement).value })}
                />
              </div>
              <span class="color-value">${r.color}</span>
            </div>
          </div>
        `,
      )}`,
    );
  }

  private _colorRow(
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) {
    return html`
      <div class="row">
        <span class="row-label">${label}</span>
        <div class="color-cell">
          <div
            class="color-swatch"
            style=${styleMap({ background: value })}
            title="点击选色"
          >
            <input
              type="color"
              .value=${value}
              @input=${(e: Event) =>
                onChange((e.target as HTMLInputElement).value)}
            />
          </div>
          <span class="color-value">${value}</span>
        </div>
      </div>
    `;
  }

  private _switchRow(
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    restart = false,
  ) {
    return html`
      <div class="row">
        <span class="row-label">
          ${label}
          ${restart
            ? html`<span class="restart-badge">⚠ 重启</span>`
            : nothing}
        </span>
        <md-switch
          ?selected=${checked}
          @change=${(e: Event) =>
            onChange((e.target as HTMLElement & { selected: boolean }).selected)}
        ></md-switch>
      </div>
    `;
  }

  private _sliderRow(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    restart = false,
  ) {
    return html`
      <div class="row stacked">
        <div class="slider-head">
          <span class="row-label">
            ${label}
            ${restart ? html`<span class="restart-badge">⚠ 重启</span>` : nothing}
          </span>
          <span class="slider-val">${value.toFixed(2)}</span>
        </div>
        <md-slider
          min=${min}
          max=${max}
          step=${step}
          .value=${value}
          @input=${(e: Event) =>
            onChange(Number((e.target as HTMLInputElement).value))}
        ></md-slider>
      </div>
    `;
  }

  private _numRow(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    restart = false,
  ) {
    return html`
      <div class="row">
        <span class="row-label">
          ${label}
          ${restart
            ? html`<span class="restart-badge">⚠ 重启</span>`
            : nothing}
        </span>
        <md-outlined-text-field
          class="num-field"
          type="number"
          .value=${String(value)}
          min=${min}
          max=${max}
          step=${step}
          @change=${(e: Event) =>
            onChange(Number((e.target as HTMLInputElement).value))}
        ></md-outlined-text-field>
      </div>
    `;
  }

  private _textRow(
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) {
    return html`
      <div class="row">
        <span class="row-label">${label}</span>
        <md-outlined-text-field
          class="text-field"
          .value=${value}
          @change=${(e: Event) =>
            onChange((e.target as HTMLInputElement).value)}
        ></md-outlined-text-field>
      </div>
    `;
  }

  private _selectRow(
    label: string,
    value: string,
    options: [string, string][],
    onChange: (v: string) => void,
    restart = false,
  ) {
    return html`
      <div class="row">
        <span class="row-label">
          ${label}
          ${restart
            ? html`<span class="restart-badge">⚠ 重启</span>`
            : nothing}
        </span>
        <md-outlined-select
          .value=${value}
          @change=${(e: Event) =>
            onChange(
              (e.currentTarget as HTMLElement & { value: string }).value,
            )}
        >
          ${options.map(
            ([v, l]) => html`
              <md-select-option .value=${v} ?selected=${value === v}>
                <div slot="headline">${l}</div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
      </div>
    `;
  }

  // ── 壁纸：浏览器里拿不到本地绝对路径，故用上传字节的方式让用户「自己提供」壁纸 ──
  private _wallpaperRow(path: string) {
    const custom = !!path;
    return html`
      <div class="row stacked">
        <div class="slider-head">
          <span class="row-label">自定义壁纸（取色生成主题，启动时生效）</span>
          <span class="slider-val">${custom ? '自定义图片' : '未选择（纯黑背景）'}</span>
        </div>
        <div class="wp-cell">
          <div class="wp-preview">
            ${this.wpErr || !this.wpUrl
              ? html`<div class="wp-empty"><md-icon>image</md-icon></div>`
              : html`<img
                  src=${this.wpUrl}
                  @error=${() => {
                    this.wpErr = true;
                  }}
                />`}
          </div>
          <div class="wp-actions">
            <md-outlined-button
              ?disabled=${this.wpBusy}
              @click=${this._pickWallpaper}
            >
              ${this.wpBusy ? '处理中…' : '选择图片'}
            </md-outlined-button>
            <md-outlined-button
              ?disabled=${this.wpBusy || !custom}
              @click=${this._clearWallpaper}
            >
              清除壁纸
            </md-outlined-button>
          </div>
        </div>
        <input
          id="wp-file"
          type="file"
          accept="image/*"
          style="display: none"
          @change=${this._onWallpaperFile}
        />
      </div>
    `;
  }

  private _pickWallpaper = () => {
    this.renderRoot.querySelector<HTMLInputElement>('#wp-file')?.click();
  };

  private _onWallpaperFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // 允许再次选择同一文件
    if (!file) return;
    this.wpBusy = true;
    try {
      const r = await fetch('/api/wallpaper', { method: 'POST', body: file });
      const d = await r.json();
      if (d.ok) {
        // 同步后端写入的真实路径（不标 dirty，避免被表单保存覆盖）
        this.cfg = { ...this.cfg, WALLPAPER_PATH: d.path ?? '' };
        await this._syncWallpaperPreview();
        this._showToast(
          '壁纸已更新' + (d.seed ? `（主题色 ${d.seed}）` : ''),
          true,
        );
      } else {
        this._showToast('壁纸更新失败：' + (d.error ?? '无效图片'), false);
      }
    } catch (_) {
      this._showToast('壁纸上传失败：网络错误', false);
    }
    this.wpBusy = false;
  };


  private _clearWallpaper = async () => {
    this.wpBusy = true;
    try {
      const r = await fetch('/api/wallpaper/clear', { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        this.cfg = { ...this.cfg, WALLPAPER_PATH: d.path ?? '' };
        await this._syncWallpaperPreview();
        this._showToast('壁纸已清除，侧栏将使用纯黑背景', true);
      } else {
        this._showToast('操作失败', false);
      }
    } catch (_) {
      this._showToast('操作失败：网络错误', false);
    }
    this.wpBusy = false;
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-root': SettingsRoot;
  }
}
