// Electron-owned voice core.  Every client, including the hidden capturer and
// the Dock UI, talks to it over localhost HTTP; no renderer IPC is required.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 7798;
const RATE = 16000;
const PRE_ROLL_SECONDS = 2.5;

function json(res, code, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

function rms(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = pcm.readInt16LE(i) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / (pcm.length / 2));
}

function wav(pcm) {
  const out = Buffer.alloc(44 + pcm.length);
  out.write('RIFF', 0); out.writeUInt32LE(36 + pcm.length, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(RATE, 24); out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36);
  out.writeUInt32LE(pcm.length, 40); pcm.copy(out, 44); return out;
}

function transcriptionUrl(url) {
  const value = String(url || '').replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/i.test(value)) return value;
  return `${value}/audio/transcriptions`;
}

class VoiceService {
  constructor(userData) {
    this.configFile = path.join(userData, 'voice-core.json');
    this.config = { provider: 'openai', url: '', apiKey: '', model: 'gpt-4o-mini-transcribe', language: 'zh', context: '', stream: false, captureEnabled: true, editorTheme: 'system', devTools: true };
    try { Object.assign(this.config, JSON.parse(fs.readFileSync(this.configFile, 'utf8'))); } catch {}
    // Capture ownership is a deliberate user choice.  Preserve it across host
    // restarts so a working hold-to-talk key cannot silently become inert.
    this.enabled = Boolean(this.config.captureEnabled);
    this.capture = { state: 'released', device: '', error: '', sampleRate: 0, level: 0, speech: false, waveform: [], lastFrameAt: 0, startedAt: 0, stale: false };
    this.captureGeneration = 0;
    this.lastCaptureResetAt = 0;
    this.ring = [];
    this.ringBytes = 0;
    this.maxRingBytes = RATE * 2 * PRE_ROLL_SECONDS;
    this.recording = false;
    this.segment = [];
    this.theme = '#4aa3ff';
    this.overlay = { visible: false, mode: 'idle', text: '' };
    this.editor = { visible: false, focused: false, centerRequest: 0 };
    this.draftFile = path.join(userData, 'voice-draft.txt');
    this.breakpointFile = path.join(userData, 'voice-breakpoint.json');
    this.breakpointLine = this.loadBreakpoint();
    this.editorUpdates = [];
    this.editorRevision = 0;
    this.overlayTimer = undefined;
    this.server = http.createServer((req, res) => void this.route(req, res));
    this.nativeCoreUrl = '';
  }
  start() { this.captureWatchdog = setInterval(() => this.checkCaptureHealth(), 500); return new Promise((resolve, reject) => this.server.listen(PORT, '127.0.0.1', (e) => e ? reject(e) : resolve())); }
  stop() { clearInterval(this.captureWatchdog); this.server.close(); }
  setNativeCoreUrl(url) { this.nativeCoreUrl = String(url || '').replace(/\/+$/, ''); }
  asrContext() {
    const terms = String(this.config.context || '').split(/\r?\n/)
      .map((item) => item.trim()).filter(Boolean);
    if (!terms.length) return '';
    // Qwen3-ASR treats context as a system prompt, not a weighted hotword
    // graph. Present an intentionally short semantic terminology list rather
    // than pretending that newlines are independent decoder weights.
    return `术语和专有名词：${terms.join('、')}`;
  }
  normalizeTranscript(text) {
    // User-confirmed ASR homophone correction. Keep this intentionally narrow;
    // it is not a broad post-processing dictionary.
    return String(text || '').replaceAll('键权', '鉴权');
  }
  setTheme(seed) { if (typeof seed === 'string' && /^#[0-9a-f]{6}$/i.test(seed)) this.theme = seed; }
  showOverlay(mode, text, hideAfter = 0) { clearTimeout(this.overlayTimer); this.overlay = { visible: true, mode, text }; if (hideAfter) this.overlayTimer = setTimeout(() => { this.overlay = { visible: false, mode: 'idle', text: '' }; }, hideAfter); }
  hideOverlay() { clearTimeout(this.overlayTimer); this.overlay = { visible: false, mode: 'idle', text: '' }; }
  state() { return { enabled: this.enabled, captureGeneration: this.captureGeneration, recording: this.recording, preRollMs: PRE_ROLL_SECONDS * 1000, capture: this.capture, overlay: this.overlay, editor: this.editor, theme: this.theme, config: { ...this.config, apiKey: this.config.apiKey ? 'configured' : '' } }; }
  save() { fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }
  acceptAudio(pcm) {
    this.capture.lastFrameAt = Date.now();
    this.capture.stale = false;
    const level = rms(pcm);
    this.capture.level = level;
    this.capture.speech = level >= 0.012;
    this.capture.waveform.push(Math.min(1, level * 9));
    if (this.capture.waveform.length > 64) this.capture.waveform.splice(0, this.capture.waveform.length - 64);
    this.ring.push(pcm); this.ringBytes += pcm.length;
    while (this.ringBytes > this.maxRingBytes && this.ring.length) this.ringBytes -= this.ring.shift().length;
    if (this.recording) this.segment.push(pcm);
  }
  resetCapture(reason, enabled = this.enabled) {
    this.captureGeneration += 1;
    this.lastCaptureResetAt = Date.now();
    this.ring = [];
    this.ringBytes = 0;
    this.capture.waveform = [];
    this.capture.level = 0;
    this.capture.speech = false;
    this.capture.lastFrameAt = 0;
    this.capture.startedAt = Date.now();
    this.capture.stale = Boolean(enabled);
    this.capture.state = enabled ? 'resetting' : 'released';
    this.capture.error = reason;
  }
  checkCaptureHealth() {
    if (!this.enabled || this.capture.state !== 'capturing') return;
    const last = this.capture.lastFrameAt || this.capture.startedAt;
    if (last && Date.now() - last > 2500 && Date.now() - this.lastCaptureResetAt > 3000) {
      this.resetCapture('超过 2.5 秒未收到新的音频帧，正在重置麦克风');
    }
  }
  async waitForCapture(timeoutMs = 1800) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.enabled) throw new Error('麦克风捕获未开启');
      if (!this.capture.stale && this.capture.state === 'capturing' && this.capture.lastFrameAt) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(this.capture.error || '麦克风尚未收到新的音频帧');
  }
  async startRecording() {
    if (!this.enabled) throw new Error('麦克风捕获未开启');
    if (this.capture.stale || this.capture.state !== 'capturing') {
      await this.waitForCapture();
    }
    if (this.recording) return;
    this.inputTarget = await this.captureInputTarget();
    // Take the whole rolling pre-roll. VAD consumers can trim the leading
    // silence without ever losing speech during a hotkey/CPU jitter.
    this.segment = this.ring.slice();
    this.recording = true;
    this.showOverlay('listening', '正在聆听…');
  }
  abortRecording() {
    this.recording = false;
    this.segment = [];
    this.hideOverlay();
  }
  toggleEditor() {
    this.abortRecording();
    this.editor.visible = !this.editor.visible;
    if (!this.editor.visible) this.editor.focused = false;
    return this.editor;
  }
  showEditor() {
    this.editor.visible = true;
    return this.editor;
  }
  requestEditorCenter() {
    this.editor.centerRequest += 1;
    return this.editor;
  }
  hideEditor() { this.editor.visible = false; this.editor.focused = false; }
  setEditorFocus(focused) { this.editor.focused = Boolean(focused) && this.editor.visible; }
  async captureInputTarget() {
    if (this.nativeCoreUrl) {
      const response = await fetch(`${this.nativeCoreUrl}/v1/core/capture`);
      if (!response.ok) throw new Error(`Zig 目标窗口捕获失败: ${response.status}`);
      return Number((await response.json()).hwnd) || 0;
    }
    return 0;
  }
  appendToEditor(text) {
    if (!text) return;
    this.editorUpdates.push({ revision: ++this.editorRevision, text });
    if (this.editorUpdates.length > 100) this.editorUpdates.splice(0, this.editorUpdates.length - 100);
  }
  readDraft() { try { return fs.readFileSync(this.draftFile, 'utf8'); } catch { return ''; } }
  saveDraft(text) { fs.writeFileSync(this.draftFile, String(text ?? ''), 'utf8'); }
  replaceEditorDocument(text) {
    this.saveDraft(text);
    this.editorUpdates.push({ revision: ++this.editorRevision, document: String(text ?? '') });
    if (this.editorUpdates.length > 100) this.editorUpdates.splice(0, this.editorUpdates.length - 100);
  }
  toggleDraftTask(line) {
    // Do not retain a trailing newline on each item: the Markdown task
    // pattern intentionally anchors at the line end.
    const lines = this.readDraft().split('\n');
    const index = Number(line) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) throw new Error('任务行不存在');
    const match = /^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/.exec(lines[index]);
    if (!match) throw new Error('指定行不是 Markdown 待办');
    const checked = match[2].toLowerCase() !== 'x';
    lines[index] = lines[index].slice(0, match.index + match[1].length) + (checked ? 'x' : ' ') + lines[index].slice(match.index + match[1].length + 1);
    const text = lines.join('\n');
    this.replaceEditorDocument(text);
    return { ok: true, line: index + 1, checked };
  }
  loadBreakpoint() {
    try {
      const line = Number(JSON.parse(fs.readFileSync(this.breakpointFile, 'utf8')).line);
      return Number.isInteger(line) && line > 0 ? line : 1;
    } catch { return 1; }
  }
  setBreakpoint(line) {
    this.breakpointLine = Number.isInteger(line) && line > 0 ? line : null;
    fs.writeFileSync(this.breakpointFile, JSON.stringify({ line: this.breakpointLine }, null, 2), 'utf8');
    return this.breakpointLine;
  }
  async stopRecording() {
    if (!this.recording) return { ok: false, error: 'not recording' };
    this.recording = false;
    const pcm = Buffer.concat(this.segment);
    this.segment = [];
    if (pcm.length < RATE * 2 * 0.12) return { ok: false, error: '录音过短' };
    this.showOverlay('recognizing', '正在识别…');
    try {
      const result = await this.transcribe(pcm);
      const text = this.normalizeTranscript(String(result.text || result.transcript || result.result || '').trim());
      // A visible but unfocused editor must never steal dictated text from the
      // foreground application. Only append while its actual text surface is
      // focused; otherwise inject into the target captured at recording start.
      if (text && this.editor.visible && this.editor.focused) {
        this.appendToEditor(text);
        this.showOverlay('done', '已追加', 900);
      } else if (text) {
        await this.inject(text);
        this.showOverlay('done', '已输入', 1200);
      } else {
        this.showOverlay('done', '未识别到内容', 3000);
      }
      return { ok: true, result };
    } catch (error) {
      this.showOverlay('error', String(error.message || error), 3000);
      throw error;
    }
  }
  async transcribe(pcm) {
    if (!this.config.url) throw new Error('未配置 OpenAI 兼容识别地址');
    if (/^wss?:\/\//i.test(this.config.url)) return this.transcribeQwenAsr(pcm);
    const form = new FormData();
    form.set('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'segment.wav');
    form.set('model', this.config.model);
    if (this.config.language) form.set('language', this.config.language);
    const context = this.asrContext();
    if (context) form.set('prompt', context);
    const response = await fetch(transcriptionUrl(this.config.url), { method: 'POST', headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}, body: form });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `ASR ${response.status}`);
    let result;
    try { result = JSON.parse(text); } catch { result = { text }; }
    return result;
  }
  async transcribeQwenAsr(pcm) {
    const url = this.config.url;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      let socket;
      try { socket = new WebSocket(url); } catch (error) { fail(error); return; }
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          mode: '2pass', is_speaking: true, wav_format: 'pcm',
          language: this.config.language || 'zh',
          // The compatible Qwen endpoint accepts the terminology context in
          // this field and applies it during transcription.
          context: this.asrContext(),
        }));
        socket.send(pcm);
        socket.send(JSON.stringify({ is_speaking: false }));
      });
      socket.addEventListener('message', async (event) => {
        try {
          const message = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
          if (message.mode !== '2pass-offline') return;
          const text = String(message.text || '');
          if (!settled) { settled = true; resolve({ text }); }
          socket.close();
        } catch (error) { fail(error); socket.close(); }
      });
      socket.addEventListener('error', () => fail(new Error(`无法连接 Qwen ASR：${url}`)));
      socket.addEventListener('close', () => { if (!settled) fail(new Error('Qwen ASR 在返回识别结果前断开连接')); });
    });
  }
  async inject(text) {
    if (this.nativeCoreUrl) {
      let response;
      try {
        response = await fetch(`${this.nativeCoreUrl}/v1/core/inject?hwnd=${encodeURIComponent(String(this.inputTarget || 0))}`, {
          method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: String(text || ''),
        });
      } catch (error) {
        throw new Error(`Zig 输入核心不可用（${this.nativeCoreUrl}）：${error.message || error}`);
      }
      if (!response.ok) throw new Error(`Zig 文字注入失败: ${await response.text()}`);
      return true;
    }
    return false;
  }
  async transcribeStream(pcm, res) {
    if (!this.config.url) throw new Error('未配置 OpenAI 兼容识别地址');
    if (/^wss?:\/\//i.test(this.config.url)) return json(res, 400, { error: 'Qwen ASR 使用非流式 WebSocket 协议；请关闭 SSE 流式响应。' });
    const form = new FormData();
    form.set('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'segment.wav');
    form.set('model', this.config.model); form.set('stream', 'true');
    if (this.config.language) form.set('language', this.config.language);
    const context = this.asrContext();
    if (context) form.set('prompt', context);
    const upstream = await fetch(transcriptionUrl(this.config.url), { method: 'POST', headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}, body: form });
    if (!upstream.ok || !upstream.body) throw new Error(await upstream.text());
    res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    const reader = upstream.body.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    res.end();
  }
  async route(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' }); return res.end(); }
    const route = new URL(req.url, `http://${req.headers.host}`).pathname;
    try {
      if (req.method === 'GET' && route === '/v1/voice/state') return json(res, 200, this.state());
      if (req.method === 'GET' && route === '/v1/voice/control') return json(res, 200, { enabled: this.enabled, generation: this.captureGeneration });
      if (req.method === 'POST' && route === '/v1/voice/capture') {
        this.enabled = !!JSON.parse((await body(req)).toString() || '{}').enabled;
        this.config.captureEnabled = this.enabled;
        this.resetCapture(this.enabled ? '正在重新初始化麦克风' : '麦克风已释放', this.enabled);
        this.save(); return json(res, 200, this.state());
      }
      if (req.method === 'POST' && route === '/v1/voice/record/start') {
        try { await this.startRecording(); return json(res, 200, this.state()); }
        catch (error) { this.showOverlay('error', String(error.message || error), 3000); throw error; }
      }
      if (req.method === 'POST' && route === '/v1/voice/record/stop') return json(res, 200, await this.stopRecording());
      if (req.method === 'POST' && route === '/v1/voice/record/cancel') { this.abortRecording(); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && route === '/v1/voice/ptt/toggle-editor') return json(res, 200, this.toggleEditor());
      if (req.method === 'POST' && route === '/v1/voice/editor/open') return json(res, 200, this.showEditor());
      if (req.method === 'POST' && route === '/v1/voice/editor/close') { this.hideEditor(); return json(res, 200, this.editor); }
      if (req.method === 'POST' && route === '/v1/voice/editor/center') return json(res, 200, this.requestEditorCenter());
      if (req.method === 'POST' && route === '/v1/voice/editor/focus') {
        this.setEditorFocus(Boolean(JSON.parse((await body(req)).toString() || '{}').focused));
        return json(res, 200, this.editor);
      }
      if (req.method === 'GET' && route === '/v1/voice/editor/document') return json(res, 200, { text: this.readDraft(), revision: this.editorRevision });
      if (req.method === 'GET' && route === '/v1/voice/editor/breakpoint') return json(res, 200, { line: this.breakpointLine });
      if (req.method === 'POST' && route === '/v1/voice/editor/breakpoint') {
        const value = JSON.parse((await body(req)).toString() || '{}').line;
        return json(res, 200, { line: this.setBreakpoint(value === null ? null : Number(value)) });
      }
      if (req.method === 'POST' && route === '/v1/voice/editor/toggle-task') {
        const line = JSON.parse((await body(req)).toString() || '{}').line;
        return json(res, 200, this.toggleDraftTask(line));
      }
      if (req.method === 'GET' && route === '/v1/voice/editor/updates') {
        const after = Number(new URL(req.url, `http://${req.headers.host}`).searchParams.get('after')) || 0;
        return json(res, 200, { revision: this.editorRevision, updates: this.editorUpdates.filter((entry) => entry.revision > after) });
      }
      if (req.method === 'POST' && route === '/v1/voice/overlay/test') { this.showOverlay('listening', '语音指示器测试', 20000); return json(res, 200, this.state()); }
      if (req.method === 'POST' && route === '/v1/voice/status') {
        const update = JSON.parse((await body(req)).toString() || '{}');
        Object.assign(this.capture, update);
        if (update.state === 'capturing') this.capture.startedAt = Date.now();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/v1/voice/chunk') { this.acceptAudio(await body(req)); return json(res, 202, { ok: true }); }
      if (req.method === 'GET' && route === '/v1/voice/config') return json(res, 200, { ...this.config, apiKey: this.config.apiKey ? 'configured' : '' });
      if (req.method === 'PUT' && route === '/v1/voice/config') {
        Object.assign(this.config, JSON.parse((await body(req)).toString() || '{}'));
        if (!['system', 'light', 'dark'].includes(this.config.editorTheme)) this.config.editorTheme = 'system';
        this.config.devTools = Boolean(this.config.devTools);
        if (this.config.apiKey === 'configured') delete this.config.apiKey;
        this.save(); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/v1/voice/transcribe') {
        const pcm = await body(req);
        return this.config.stream ? this.transcribeStream(pcm, res) : json(res, 200, await this.transcribe(pcm));
      }
      if (req.method === 'POST' && route === '/v1/voice/transcribe/stream') return this.transcribeStream(await body(req), res);
      if (req.method === 'POST' && route === '/v1/voice/inject') { await this.inject((await body(req)).toString('utf8')); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && route === '/v1/voice/editor/save') {
        const text = String(JSON.parse((await body(req)).toString() || '{}').text || '');
        this.saveDraft(text);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/v1/voice/cancel') { this.hideOverlay(); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found' });
    } catch (error) { this.capture.error = String(error.message || error); return json(res, 500, { error: this.capture.error }); }
  }
}

module.exports = { VoiceService, PORT };
