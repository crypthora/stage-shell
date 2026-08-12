// settings-main.ts —— 设置页入口：MD3 主题 + 组件注册。
import './theme.css';
import 'material-symbols/outlined.css';

import '@material/web/icon/icon.js';
import '@material/web/switch/switch.js';
import '@material/web/slider/slider.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';

import { styles as typescaleStyles } from '@material/web/typography/md-typescale-styles.js';

import './components/settings-root';
import { initTheme, setThemeMode, setThemeSeed } from './app-theme';

if (typescaleStyles?.styleSheet) {
  document.adoptedStyleSheets.push(typescaleStyles.styleSheet);
}

// 同侧栏：跟随 Windows 亮/暗色与固定种子色
initTheme('#4aa3ff');

// Settings is its own Electron window, so it does not share the Dock's JS
// state.  Read the same local Web API and follow the host-reported system
// mode here as well.
async function syncTheme() {
  try {
    const state = await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json());
    setThemeSeed(state.wallpaper?.seed ?? '#4aa3ff');
    setThemeMode(state.systemTheme);
  } catch {
    // Keep the initial safe theme while the local backend starts.
  }
}
void syncTheme();
window.setInterval(() => void syncTheme(), 1000);

// theme.css 给侧栏设了 overflow:hidden，设置页需要滚动
document.body.style.overflow = 'auto';
document.documentElement.style.overflow = 'auto';
document.documentElement.style.height = 'auto';
document.body.style.height = 'auto';
