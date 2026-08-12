// state.ts —— 本地 Shell 服务推送的 State Model 类型契约。
import type { RoleConfig } from './roles';

export type { RoleConfig };

export interface MediaState {
  active: boolean;
  title: string;
  artist: string;
  isPlaying: boolean;
  cover: string | null;   // /asset/cover?v=N
}

export interface StackTile {
  hwnd?: number;
  thumb: string | null;
  icon: string | null;
}

export interface CardState {
  hwnd: number;
  title: string;
  thumb: string | null;   // /asset/thumb/<hwnd>?v=N
  icon: string | null;    // /asset/icon/<hwnd>?v=N
  group: boolean;
  groupCount: number;     // 组内额外成员数（用于 +N 角标）
  visible: boolean;       // 当前桌面是否显示
  pinnedDesktop?: number | null;  // 该应用已钉到的桌面号；null/缺省=未钉
  role?: number | null;   // 角色索引（0-5）；null/缺省=无角色
  stackId?: number;       // 卡片夹 id；存在=本卡是一个夹子的正面
  stack?: {               // 夹子元信息（仅 stackId 存在时）
    count: number;        // 夹内在场窗口数（含正面）
    tiles: StackTile[];   // 夹内在场卡（最多 4 张，含正面；用于文件夹 2×2）
  };
}

export interface StagedWindow {
  hwnd: number;
  title: string;
  thumb: string | null;   // /asset/thumb/<hwnd>?v=N
  icon: string | null;    // /asset/icon/<hwnd>?v=N
  peeked: boolean;        // 当前被 peek 提到前台（侧栏卡高亮）
  role?: number | null;   // 角色索引（session-only）
}

export interface DeskApp {
  hwnd: number;
  icon: string | null;
  role?: number | null;   // 角色索引，供 pager 小图标颜色
}

export interface DeskItem {
  idx: number;
  number: number;         // pyvda 桌面号（拖拽落点 moveToDesktop 用）
  label: string;          // "1".."4"
  name: string;
  thumb: string | null;   // /asset/thumb/<hwnd>?v=N（该桌面前台应用缩略图）
  fgHwnd: number | null;
  fgIcon: string | null;  // 前台软件图标（左上角徽标）
  fgRole?: number | null; // 前台软件的角色索引
  apps: DeskApp[];        // 底部图标行
}

export interface DesktopsState {
  active: number;
  cols: number;
  items: DeskItem[];
}

export interface VoiceState {
  visible: boolean;
  mode: 'listening' | 'recognizing' | 'error';
  text: string;
}

export interface WallpaperState {
  url: string | null;     // /asset/wallpaper?v=N  (null = 无壁纸/已禁用)
  seed: string | null;    // #rrggbb M3 You 种子色 (null = 用默认)
  alpha: number;          // 壁纸层透明度 0~1
}

export interface WidgetCfg {
  id: string;
  enabled?: boolean;
  cfg?: Record<string, unknown>;
}

export interface WidgetMeta {
  id: string;
  title: string;
  icon: string;
}

export interface State {
  clock: string;          // "HH:MM"
  media: MediaState;
  cards: CardState[];
  staged: StagedWindow[]; // 顶部暂存区窗口
  desktops: DesktopsState;
  desktopPagerMode?: 'preview' | 'icons'; // 桌面切换器显示模式（默认预览）
  voice: VoiceState;
  wallpaper: WallpaperState;
  widgets: Record<string, unknown>;   // 外部 widget 状态（sysmon、weather 等）
  widgetOrder: WidgetCfg[];           // 排布顺序（来自 config.json WIDGETS）
  widgetsEnabled: boolean;            // false = hide the complete widget strip permanently
  allWidgets: WidgetMeta[];           // 所有已注册 widget 的元信息（供「添加」面板）
  roles: RoleConfig[];                // 可配置角色列表（来自 config.json ROLES）
  mouseLeaveReset: boolean;           // 鼠标移出侧栏是否自动回到窗口列表（config 热更新，随帧推送）
  systemTheme?: 'light' | 'dark' | null; // 宿主通过本地 Web API 上报的系统深浅色模式
}
