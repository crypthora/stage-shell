"""番茄钟 Widget — 包装已有的 pomodoro.Pomodoro 状态机。

get_state() 每帧调用 tick() 推进计时，snapshot() 产出前端所需数据。
handle() 响应 JS 的 toggle/reset 命令。
"""
from pomodoro import Pomodoro
from ._base import Widget


class PomoWidget(Widget):
    id = "pomo"
    title = "番茄钟"
    icon = "timer"

    def __init__(self):
        self._pomo = Pomodoro()

    def get_state(self) -> dict:
        self._pomo.tick()
        return self._pomo.snapshot()

    def handle(self, cmd: str, **kw) -> None:
        if cmd == "toggle":
            self._pomo.toggle()
        elif cmd == "reset":
            self._pomo.reset()


WIDGET = PomoWidget()
