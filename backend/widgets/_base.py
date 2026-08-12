"""Widget 基类 — 继承后设置类变量，并在模块级暴露 WIDGET 实例即可自动注册。"""


class Widget:
    id: str = ""        # 唯一 slug，如 "sysmon"
    title: str = ""     # 显示名，如 "系统监控"
    icon: str = "widgets"  # Material Symbol 图标名

    # 引擎在 start_all 后注入：交互式 widget 状态变化时调用，请求立即推送一帧
    # （否则要等下一次 700ms tick）。用 staticmethod 让 self.notify() 不被绑成方法。
    notify = staticmethod(lambda: None)

    def start(self) -> None:
        """引擎启动时调用（可开后台线程）。"""

    def stop(self) -> None:
        """引擎关闭时调用。"""

    def get_state(self) -> dict:
        """每帧返回可 JSON 序列化的 dict，发送给前端。"""
        return {}

    def handle(self, cmd: str, **kw) -> None:
        """响应来自 JS 的命令（widgetCommand bridge 调用）。"""
