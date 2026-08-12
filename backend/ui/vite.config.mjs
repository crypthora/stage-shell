import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = fileURLToPath(new URL('.', import.meta.url));

// 构建产物输出到 ui/dist，由 Python 的 server.py 从 http://127.0.0.1:<port>/ 提供。
// base 用相对路径，这样 index.html 引用的 ./assets/* 能在服务器根下正确解析。
// 多页构建：侧栏主页、设置页、PTT 输入层与语音编辑器。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0, // 字体/图标不内联，便于浏览器缓存
    rollupOptions: {
      input: {
        main: resolve(__dir, 'index.html'),
        settings: resolve(__dir, 'settings.html'),
        voiceEditor: resolve(__dir, 'voice-editor.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
