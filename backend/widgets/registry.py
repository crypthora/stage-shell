"""Widget 注册表 — 自动扫描 widgets/ 目录加载所有外部 Widget。

内置 Widget（clock / media）状态由 engine.py 直接产出，不在此列，
但 meta 信息在 _BUILTIN_META 中声明，供前端「添加组件」面板展示。
"""
import importlib
import pkgutil
import traceback
import widgets

from ._base import Widget

# 内置 widget 元信息（数据来自 engine 现有字段，不需要 Python Widget 类）
_BUILTIN_META: list[dict] = [
    {"id": "clock",  "title": "时钟",   "icon": "schedule"},
    {"id": "media",  "title": "媒体播放", "icon": "music_note"},
]

# 外部 widget 注册表：id -> Widget 实例
REGISTRY: dict[str, Widget] = {}


def load_all() -> None:
    """扫描 widgets/ 目录，将所有暴露 WIDGET 变量的模块注册。"""
    for _, name, _ in pkgutil.iter_modules(widgets.__path__):
        if name.startswith("_"):
            continue
        try:
            mod = importlib.import_module(f"widgets.{name}")
            w = getattr(mod, "WIDGET", None)
            if isinstance(w, Widget) and w.id:
                REGISTRY[w.id] = w
        except Exception:
            traceback.print_exc()


def set_notify(fn) -> None:
    """把引擎的状态推送回调注入每个外部 widget，供交互式 widget 立即刷新 UI。"""
    for w in REGISTRY.values():
        try:
            w.notify = fn
        except Exception:
            pass


def set_get_open_apps(fn) -> None:
    """把引擎的「当前打开应用列表」回调注入每个外部 widget。"""
    for w in REGISTRY.values():
        try:
            w.get_open_apps = fn
        except Exception:
            pass


def start_all() -> None:
    for w in REGISTRY.values():
        try:
            w.start()
        except Exception:
            pass


def stop_all() -> None:
    for w in REGISTRY.values():
        try:
            w.stop()
        except Exception:
            pass


def get_states(active_ids: list) -> dict:
    """只对 active_ids 中存在于 REGISTRY 的外部 widget 采集状态。"""
    result = {}
    for wid in active_ids:
        w = REGISTRY.get(wid)
        if w is None:
            continue
        try:
            result[wid] = w.get_state()
        except Exception:
            result[wid] = {}
    return result


def all_meta() -> list:
    """返回所有 widget（内置 + 外部）的元信息列表。"""
    # 只取真正的 Widget 实例，避免辅助对象没有 id/title/icon 时影响状态构建。
    ext = [{"id": w.id, "title": w.title, "icon": w.icon}
           for w in REGISTRY.values() if isinstance(w, Widget)]
    return _BUILTIN_META + ext


def default_widget_order() -> list:
    """首次运行时的默认排布：内置在前，外部在后，全部启用。"""
    base = [{"id": m["id"], "enabled": True} for m in _BUILTIN_META]
    ext  = [{"id": w.id,    "enabled": True}
            for w in REGISTRY.values() if isinstance(w, Widget)]
    return base + ext
