// drag.ts —— 跨组件指针拖拽控制器（功能1/2 + 卡片夹堆叠 共用）。
// 为什么不用 HTML5 原生 DnD：本侧边栏是无边框 + WS_EX_NOACTIVATE 不抢焦点的
// 无边框 Dock 窗口中，OS 级 DoDragDrop 拖拽循环行为不可靠（拖影/drop 易失灵）。
// 改用 window 级指针事件 + 目标矩形命中：clientX/Y 是视口坐标，可跨 Shadow DOM 命中。
//
// 用法：
//   拖拽源 @pointerdown 调 drag.start(ev, payload, onDrop)
//   落点组件用 drag.registerProvider(() => DropTarget[]) 登记"当前落点矩形"（返回注销函数）
//   落点组件 drag.subscribe(fn) 订阅以高亮（读 drag.dragging / drag.hoverTarget）
//   落点可多源并存：桌面格(kind:'desk') 与 窗口卡(kind:'card')；命中时卡片优先。
//   onDrop 收到命中的 target，由拖拽源决定动作（移到桌面 / 堆叠成夹）。

export interface DragPayload {
  hwnd: number;
  fromIdx: number | null; // 拖拽源所在桌面 idx；窗口卡来自当前桌面则为 null
  icon: string | null; // ghost 用图标 url
  title: string;
  stackId?: number | null; // 拖拽源是否为卡片夹（夹子正面）；null/缺省=普通单卡
}

export type DropKind = 'desk' | 'card' | 'stage';

export interface DropTarget {
  kind: DropKind;
  idx: number; // desk: 桌面 idx；card: -1
  number: number; // desk: pyvda 桌面号；card: 目标窗口 hwnd
  rect: DOMRect;
  // card 落点：按指针在卡内高度三等分 —— 上⅓插到上面 / 中⅓叠成夹 / 下⅓插到下面。
  mode?: 'stack' | 'before' | 'after';
}

type TargetProvider = () => DropTarget[];
// 落点把命中的 target 交回拖拽源，由源决定动作（moveToDesktop / stackCards）
type DropHandler = (payload: DragPayload, target: DropTarget) => void;

const THRESHOLD = 6; // 越过该位移(px)才算拖拽，用于区分点击/滚动

class DragController {
  /** 已越过阈值、真正在拖 */
  dragging = false;
  /** 当前悬停的落点（无则 null） */
  hoverTarget: DropTarget | null = null;

  private payload: DragPayload | null = null;
  private onDrop: DropHandler | null = null;
  private providers = new Set<TargetProvider>();
  private listeners = new Set<() => void>();
  private startX = 0;
  private startY = 0;
  private ghost: HTMLElement | null = null;

  /** 兼容旧用法：悬停的桌面格 idx（卡片落点时返回 null） */
  get hoverIdx(): number | null {
    return this.hoverTarget?.kind === 'desk' ? this.hoverTarget.idx : null;
  }

  /** 当前拖拽源窗口 hwnd（无拖拽则 null）；落点用于排除"拖到自己身上" */
  get sourceHwnd(): number | null {
    return this.payload?.hwnd ?? null;
  }

  /** 当前拖拽源所属卡片夹 id（普通单卡为 null）；落点用于禁止「夹子叠到夹子」 */
  get sourceStackId(): number | null {
    return this.payload?.stackId ?? null;
  }

  /** 落点组件登记"取当前落点矩形"的函数；返回注销函数。可多源并存。 */
  registerProvider(p: TargetProvider): () => void {
    this.providers.add(p);
    return () => this.providers.delete(p);
  }

  /** 订阅拖拽状态变化（用于落点高亮）；返回取消订阅函数 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** 拖拽源在 @pointerdown 调用 */
  start(e: PointerEvent, payload: DragPayload, onDrop: DropHandler) {
    if (e.button !== 0) return; // 仅左键
    if (this.payload) this._teardown(); // 上一次拖拽若没正常收尾（如在窗外松手），先清干净避免监听器叠加
    this.payload = payload;
    this.onDrop = onDrop;
    this.dragging = false;
    this.hoverTarget = null;
    this.startX = e.clientX;
    this.startY = e.clientY;
    window.addEventListener('pointermove', this._move, true);
    window.addEventListener('pointerup', this._up, true);
    window.addEventListener('pointercancel', this._cancel, true);
    // 关键：<img>/<a> 在 Chromium 里默认可原生拖拽，按住小图标一动就触发原生 DnD，
    // 会抢走指针并派发 pointercancel 打断我们的拖拽（表现为"无动效"或"动效闪一下没作用"）。
    // 在拖拽期间全局吞掉 dragstart 即可彻底禁用原生 DnD。
    window.addEventListener('dragstart', this._noNativeDrag, true);
  }

  private _noNativeDrag = (e: Event) => {
    e.preventDefault();
  };

  private _move = (e: PointerEvent) => {
    if (!this.payload) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (!this.dragging) {
      if (Math.abs(dx) + Math.abs(dy) < THRESHOLD) return;
      this.dragging = true;
      document.body.style.userSelect = 'none';
      this._makeGhost();
      this.emit();
    }
    this._moveGhost(e.clientX, e.clientY);
    const t = this._hit(e.clientX, e.clientY);
    if (!this._sameTarget(t, this.hoverTarget)) {
      this.hoverTarget = t;
      this.emit();
    }
  };

  private _sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
      a.kind === b.kind &&
      a.idx === b.idx &&
      a.number === b.number &&
      a.mode === b.mode
    );
  }

  private _up = (e: PointerEvent) => {
    const wasDragging = this.dragging;
    const target = wasDragging ? this._hit(e.clientX, e.clientY) : null;
    const payload = this.payload;
    const onDrop = this.onDrop;
    this._teardown();
    if (!wasDragging) return; // 纯点击：放行原生 click（focusCard/openApp/switchDesktop）
    this._suppressNextClick(); // 真拖过：吞掉拖拽尾随的那次 click
    if (target && payload && onDrop) {
      onDrop(payload, target); // 自落点/自身由各源在 onDrop 内判定
    }
  };

  private _cancel = () => {
    this._teardown();
  };

  private _hit(x: number, y: number): DropTarget | null {
    let deskHit: DropTarget | null = null;
    for (const provider of this.providers) {
      for (const t of provider()) {
        const r = t.rect;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          if (t.kind === 'card') {
            // 上⅓=插到上面、中⅓=叠成夹、下⅓=插到下面
            const f = r.height > 0 ? (y - r.top) / r.height : 0.5;
            t.mode = f < 1 / 3 ? 'before' : f > 2 / 3 ? 'after' : 'stack';
            return t; // 卡片落点优先于桌面格
          }
          if (t.kind === 'stage') return t; // 暂存落点优先于桌面格
          if (!deskHit) deskHit = t;
        }
      }
    }
    return deskHit;
  }

  private _teardown() {
    window.removeEventListener('pointermove', this._move, true);
    window.removeEventListener('pointerup', this._up, true);
    window.removeEventListener('pointercancel', this._cancel, true);
    window.removeEventListener('dragstart', this._noNativeDrag, true);
    document.body.style.userSelect = '';
    this._removeGhost();
    this.payload = null;
    this.onDrop = null;
    this.dragging = false;
    this.hoverTarget = null;
    this.emit();
  }

  private _makeGhost() {
    const p = this.payload;
    if (!p) return;
    const g = document.createElement('div');
    g.style.cssText =
      'position:fixed;z-index:99999;pointer-events:none;left:-999px;top:-999px;' +
      'width:64px;height:40px;border-radius:10px;overflow:hidden;' +
      'background:#2b2930;box-shadow:0 6px 18px rgba(0,0,0,.5);' +
      'display:flex;align-items:center;justify-content:center;' +
      'opacity:.92;transform:translate(-50%,-50%);';
    if (p.icon) {
      const img = document.createElement('img');
      img.src = p.icon;
      img.style.cssText = 'width:26px;height:26px;object-fit:contain;';
      g.appendChild(img);
    }
    document.body.appendChild(g);
    this.ghost = g;
  }

  private _moveGhost(x: number, y: number) {
    if (this.ghost) {
      this.ghost.style.left = x + 'px';
      this.ghost.style.top = y + 'px';
    }
  }

  private _removeGhost() {
    if (this.ghost) {
      this.ghost.remove();
      this.ghost = null;
    }
  }

  // 拖拽结束后，pointerup 往往尾随一次 click（落在原元素或公共祖先上）。
  // 用一次性捕获监听吞掉它，避免误触 focusCard/openApp/switchDesktop。
  private _suppressNextClick() {
    const onClick = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      window.removeEventListener('click', onClick, true);
    };
    window.addEventListener('click', onClick, true);
    // 若本次没有尾随 click，250ms 后自动撤掉，避免误吞后续点击
    setTimeout(() => window.removeEventListener('click', onClick, true), 250);
  }
}

export const drag = new DragController();
