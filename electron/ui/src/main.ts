// main.ts —— 启动引导：M3 主题、字体、排版令牌、组件注册、就绪信号。

import './theme.css';
import 'material-symbols/outlined.css';

// @material/web 组件（仅引入实际用到的，保持包体精简）
import '@material/web/ripple/ripple.js';
import '@material/web/elevation/elevation.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/icon/icon.js';
import '@material/web/progress/linear-progress.js';
import '@material/web/labs/navigationbar/navigation-bar.js';
import '@material/web/labs/navigationtab/navigation-tab.js';

import { styles as typescaleStyles } from '@material/web/typography/md-typescale-styles.js';

import './store';
import './components/app-root';
import { ready } from './bridge';
import { subscribe } from './store';
import { initTheme, setThemeMode, setThemeSeed } from './app-theme';

// 注入 M3 排版令牌（md-typescale-* class）
if (typescaleStyles?.styleSheet) {
  document.adoptedStyleSheets.push(typescaleStyles.styleSheet);
}

// 初始主题：跟随 Windows 亮/暗色 + 固定种子色，确保首帧有颜色。
initTheme('#4aa3ff');

// 壁纸种子色到达时动态重新生成配色
subscribe((s) => {
  setThemeSeed(s.wallpaper?.seed ?? '#4aa3ff');
  setThemeMode(s.systemTheme);
});

// 抑制浏览器默认右键菜单（组件用自定义 context-menu）
window.addEventListener('contextmenu', (e) => e.preventDefault());

// The readiness signal uses the same HTTP contract as every other command.
void ready().catch(() => {});
