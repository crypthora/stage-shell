"""系统监控 Widget — 实时 CPU / RAM 用量。"""
import psutil
from ._base import Widget


class SysmonWidget(Widget):
    id = "sysmon"
    title = "系统监控"
    icon = "monitoring"

    def start(self) -> None:
        psutil.cpu_percent(interval=None)  # 预热，首次调用 interval=None 返回 0

    def get_state(self) -> dict:
        mem = psutil.virtual_memory()
        return {
            "cpu":      round(psutil.cpu_percent(interval=None), 1),
            "ram":      round(mem.percent, 1),
            "ramUsed":  round(mem.used  / 1024 ** 3, 1),
            "ramTotal": round(mem.total / 1024 ** 3, 1),
        }


WIDGET = SysmonWidget()
