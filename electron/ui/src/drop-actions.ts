// drop-actions.ts —— 窗口卡 / 暂存卡 拖拽落点的统一动作（window-card 与 staging-area 共用）。
import { moveToDesktop, stageWindow, stackCards, insertCard } from './bridge';
import type { DragPayload, DropTarget } from './drag';

// 落点处理：桌面格 → 移动该窗口；暂存区 → 暂存；窗口卡按 target.mode：
//   上/下⅓ = 插入排序（insert before / after），中⅓ = 叠成卡片夹。
// 拖的若是暂存卡，引擎会在 insert / stack / move 时按 staged 身份自动取消暂存。
export function handleCardDrop(payload: DragPayload, target: DropTarget): void {
  if (target.kind === 'desk') {
    moveToDesktop(payload.hwnd, target.number);
  } else if (target.kind === 'stage') {
    stageWindow(payload.hwnd);
  } else if (target.kind === 'card') {
    if (target.mode === 'before' || target.mode === 'after') {
      insertCard(payload.hwnd, target.number, target.mode === 'before');
    } else if (target.number !== payload.hwnd) {
      stackCards(payload.hwnd, target.number);
    }
  }
}
