// bridge.ts —— UI only speaks the local Web API/WebSocket protocol.
import { command } from './store';

function call(name: string, ...args: unknown[]): Promise<unknown> {
  return command(name, ...args);
}

export const ready = () => call('ready');

// 窗口卡片
export const focusCard = (hwnd: number) => call('focusCard', hwnd);
export const closeWindow = (hwnd: number) => call('closeWindow', hwnd);
export const moveToDesktop = (hwnd: number, number: number) =>
  call('moveToDesktop', hwnd, number);
export const desktopsForMenu = () =>
  call('desktopsForMenu') as Promise<{ number: number; name: string }[]>;
export const pinAppHere = (hwnd: number) => call('pinAppHere', hwnd);
export const unpinApp = (hwnd: number) => call('unpinApp', hwnd);

// 卡片夹（手动堆叠）：把 a 拖到 b 上合并；unstack 解散 hwnd 所属夹子
export const stackCards = (a: number, b: number) => call('stackCards', a, b);
export const unstack = (hwnd: number) => call('unstack', hwnd);

// 顶部暂存区：暂存/移出/peek（点击放前台高亮，再点恢复）
export const stageWindow = (hwnd: number) => call('stageWindow', hwnd);
export const unstageWindow = (hwnd: number) => call('unstageWindow', hwnd);
export const peekStaged = (hwnd: number) => call('peekStaged', hwnd);

// 把 src 卡插到 target 卡的前/后（手动排序；拖暂存卡进列表也走这个，引擎自动取消暂存）
export const insertCard = (src: number, target: number, before: boolean) =>
  call('insertCard', src, target, before);


// 桌面切换器
export const switchDesktop = (idx: number) => call('switchDesktop', idx);
export const openApp = (idx: number, hwnd: number) => call('openApp', idx, hwnd);

// 媒体
export const mediaPlayPause = () => call('mediaPlayPause');
export const mediaNext = () => call('mediaNext');
export const mediaPrev = () => call('mediaPrev');
export const focusMediaApp = () => call('focusMediaApp');

// Widget 命令
export const widgetCommand = (wid: string, cmd: string, kwargs: Record<string, unknown> = {}) => {
  return call('widgetCommand', wid, cmd, kwargs).catch(() => false);
};

// 写作中心窗口（已退役）
export const openPttDialog = (id?: number | null) => call('openPttDialog', id ?? null);
export const openNotesDialog = (id?: number | null) => openPttDialog(id); // 兼容旧入口
export const closeNotesDialog = () => call('closeNotesDialog');
export const closePttDialog = () => call('closePttDialog');
export const setPttWindowSize = (width: number, height: number) =>
  call('setPttWindowSize', width, height);
export interface PttWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PttStatePayload {
  version?: number;
  draft?: string;
  attachments?: Array<Record<string, unknown>>;
  commandTarget?: string | null;
  promptMode?: 'insert' | 'crud' | null;
  tagFilter?: string | null;
  focusNoteId?: number | null;
  searchQuery?: string | null;
  titleOnlyNotes?: boolean | null;
  window?: PttWindowBounds | null;
  updatedAt?: number;
}

export const getPttState = () => call('getPttState') as Promise<PttStatePayload | null>;
export const savePttState = (payload: PttStatePayload) =>
  call('savePttState', payload) as Promise<boolean>;
export const toggleSidebar = () => call('toggleSidebar');
// 窗口角色标记
export const setRole = (hwnd: number, roleIdx: number | null) =>
  call('setRole', hwnd, roleIdx);

// 配置
export const getConfig = () => call('getConfig') as Promise<Record<string, unknown>>;
export const saveConfig = (updates: Record<string, unknown>) =>
  call('saveConfig', updates) as Promise<boolean>;
