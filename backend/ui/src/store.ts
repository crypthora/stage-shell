// store.ts —— 极简响应式存储。本地 WebSocket 推送整份状态，
// 订阅者（app-root）收到后重渲染；Lit 负责高效 diff。

import type { State } from './state';

type Listener = (s: State) => void;

let current: State | null = null;
const listeners = new Set<Listener>();

export function setState(s: State): void {
  current = s;
  listeners.forEach((l) => l(s));
}

export function getState(): State | null {
  return current;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  if (current) l(current);
  return () => {
    listeners.delete(l);
  };
}

declare global {
  interface Window {
    __setState: (s: State) => void;
  }
}

type CommandReply = { ok?: boolean; result?: unknown; error?: string };
let socket: WebSocket | null = null;
let socketReady = false;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function socketUrl(): string {
  const port = Number(window.location.port || (window.location.protocol === 'https:' ? 443 : 80));
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:${port + 100}`;
}

function connectSocket(): void {
  try {
    const next = new WebSocket(socketUrl());
    socket = next;
    next.onopen = () => { if (socket === next) socketReady = true; };
    next.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; state?: State; id?: number } & CommandReply;
      if (message.type === 'state' && message.state) setState(message.state);
      if (message.type === 'result' && typeof message.id === 'number') {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.ok) request.resolve(message.result ?? null);
        else request.reject(new Error(message.error || 'command failed'));
      }
    };
    next.onclose = () => {
      if (socket === next) { socket = null; socketReady = false; }
      window.setTimeout(connectSocket, 1000);
    };
    next.onerror = () => next.close();
  } catch { window.setTimeout(connectSocket, 1000); }
}

export function command(name: string, ...args: unknown[]): Promise<unknown> {
  if (socketReady && socket) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket!.send(JSON.stringify({ type: 'command', id, command: name, args }));
      window.setTimeout(() => {
        const request = pending.get(id);
        if (request) { pending.delete(id); request.reject(new Error('command timed out')); }
      }, 6000);
    });
  }
  return fetch('/api/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: name, args }),
  }).then(async (response) => {
    const data = await response.json() as CommandReply;
    if (!response.ok || !data.ok) throw new Error(data.error || 'command failed');
    return data.result ?? null;
  });
}

// WebSocket is the normal real-time channel. This low-frequency fallback only
// covers an old backend or a temporarily unavailable socket during startup.
let pollInFlight = false;
async function refreshFromBackend(): Promise<void> {
  if (socketReady) return;
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (response.ok) setState(await response.json() as State);
  } catch {
    // The host can be starting or shutting down. Keep the last good state.
  } finally {
    pollInFlight = false;
  }
}

void refreshFromBackend();
connectSocket();
window.setInterval(() => void refreshFromBackend(), 1500);
