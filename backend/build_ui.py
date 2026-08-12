"""build_ui.py —— 构建前端到 ui/dist。

为什么不直接在 ui/ 里 `npm run build`：本项目所在的会话目录路径极深(>230 字符)，
加上 node_modules 内部路径会超过 Windows 260 字符上限，Node 的 ESM 解析器读不到
包作用域(报 #module-sync-enabled 未定义)。解决办法是在一个【短真实路径】下构建，
再把 dist 拷回来。本脚本自动完成：同步源码 → (首次)装依赖 → vite 构建 → 回拷 dist。

用法:  python build_ui.py          # 增量构建(复用短目录的 node_modules)
       python build_ui.py --clean  # 删掉短构建目录后全新构建
"""
import os
import sys
import shutil
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "ui")
# 短真实路径(家目录下)，避免长路径触发 Node 解析失败
BUILD = os.path.join(os.path.expanduser("~"), "sbuild")

_CONFIG_FILES = ["package.json", "tsconfig.json", "vite.config.mjs",
                 "index.html", "settings.html", "voice-editor.html"]


def _sync_sources():
    os.makedirs(BUILD, exist_ok=True)
    for f in _CONFIG_FILES:
        shutil.copy2(os.path.join(UI, f), os.path.join(BUILD, f))
    # 源码目录整体镜像
    dst_src = os.path.join(BUILD, "src")
    if os.path.isdir(dst_src):
        shutil.rmtree(dst_src, ignore_errors=True)
    shutil.copytree(os.path.join(UI, "src"), dst_src)


def _npm_install():
    print("[build_ui] 安装依赖(短目录, 首次较慢)…")
    # --ignore-scripts 跳过 esbuild 等的 postinstall(本环境 cmd.exe 派生受限)；
    # 平台二进制走 optionalDependencies 解压，运行时仍可用。
    npm = shutil.which("npm") or "npm"
    subprocess.run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"],
                   cwd=BUILD, check=True, shell=True)


def _vite_build():
    vite = os.path.join(BUILD, "node_modules", "vite", "bin", "vite.js")
    if not os.path.isfile(vite):
        raise SystemExit("vite 未安装，先删 %s 重跑" % BUILD)
    node = shutil.which("node") or "node"
    print("[build_ui] vite 构建…")
    subprocess.run([node, vite, "build", BUILD], check=True)


def _copy_dist_back():
    src = os.path.join(BUILD, "dist")
    dst = os.path.join(UI, "dist")
    if not os.path.isdir(src):
        raise SystemExit("构建未产出 dist")
    if os.path.isdir(dst):
        shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
    print("[build_ui] 完成 → %s" % dst)


def main():
    if "--clean" in sys.argv and os.path.isdir(BUILD):
        print("[build_ui] 清除 %s" % BUILD)
        shutil.rmtree(BUILD, ignore_errors=True)
    _sync_sources()
    if not os.path.isdir(os.path.join(BUILD, "node_modules")):
        _npm_install()
    _vite_build()
    _copy_dist_back()


if __name__ == "__main__":
    main()
