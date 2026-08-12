// external-drop.ts —— 外部 OS 拖入内容的通用解析。具体的落点行为由使用方决定。
// 与内部指针拖拽(drag.ts)互不干扰：内部拖拽走指针事件、不产生 HTML5 dragstart/dataTransfer；
// 这里走 HTML5 dragover/drop，并统一在 drag.dragging 时让行（避免内部重排途中误触）。
import { drag } from './drag';

export interface DropContent {
  kind: 'text' | 'image' | 'file';
  text?: string;
  dataUrl?: string;
  fileName?: string;
}

// 外部拖放预览的最长边。
const MAX_PX = 240;

/** dragover 阶段判断：这次外部拖拽是否带可用内容（用于高亮 + preventDefault 接收）。 */
export function externalDragHasContent(e: DragEvent): boolean {
  if (drag.dragging) return false;
  const t = e.dataTransfer?.types;
  if (!t) return false;
  const has = (k: string) => Array.prototype.indexOf.call(t, k) !== -1;
  return has('Files') || has('text/plain') || has('text/uri-list');
}

function downscaleImage(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/**
 * 解析 drop 事件为通用内容。**必须在 drop 处理器里同步调用**（dataTransfer 读取要趁早）：
 * 同步读取 files/text 后再异步降采样图片。无可用内容返回 null。
 */
export function parseExternalDrop(e: DragEvent): Promise<DropContent | null> {
  if (drag.dragging) return Promise.resolve(null);
  const dt = e.dataTransfer;
  if (!dt) return Promise.resolve(null);
  // 1) 文件：图片→缩略图；其它任意类型→只取文件名
  const files = dt.files;
  if (files && files.length) {
    const f = files[0];
    if (f.type.startsWith('image/')) {
      return downscaleImage(f).then((dataUrl) =>
        dataUrl ? { kind: 'image', dataUrl } : { kind: 'file', fileName: f.name }
      );
    }
    return Promise.resolve({ kind: 'file', fileName: f.name });
  }
  // 2) 文本 / 链接（网页拖来的图片通常只给 URL，按文本处理）
  const text = (dt.getData('text/plain') || dt.getData('text/uri-list') || '').trim();
  return Promise.resolve(text ? { kind: 'text', text } : null);
}

/** Legacy note drop target has been retired. */
export function sendDrop(_content: DropContent, _hwnd?: number): void {}
