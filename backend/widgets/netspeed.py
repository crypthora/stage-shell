"""网速监控 Widget — 实时上传/下载速率（bytes/s），后台线程每秒采样。"""
import threading
import time
import psutil
from ._base import Widget


class NetspeedWidget(Widget):
    id = "netspeed"
    title = "网速"
    icon = "network_check"

    def __init__(self):
        self._up = 0.0      # bytes/s
        self._down = 0.0    # bytes/s
        self._lock = threading.Lock()
        self._stop = False

    def start(self) -> None:
        t = threading.Thread(target=self._loop, daemon=True, name="netspeed")
        t.start()

    def stop(self) -> None:
        self._stop = True

    def _loop(self):
        last = psutil.net_io_counters()
        last_t = time.monotonic()
        while not self._stop:
            time.sleep(1.0)
            now = psutil.net_io_counters()
            now_t = time.monotonic()
            dt = now_t - last_t
            if dt > 0:
                up   = (now.bytes_sent - last.bytes_sent) / dt
                down = (now.bytes_recv - last.bytes_recv) / dt
                with self._lock:
                    self._up   = max(0.0, up)
                    self._down = max(0.0, down)
            last, last_t = now, now_t

    @staticmethod
    def _fmt(bps: float) -> str:
        if bps < 1024:
            return "%.0f B/s" % bps
        if bps < 1024 ** 2:
            return "%.1f KB/s" % (bps / 1024)
        return "%.1f MB/s" % (bps / 1024 ** 2)

    def get_state(self) -> dict:
        with self._lock:
            up, down = self._up, self._down
        return {
            "up":     round(up, 1),
            "down":   round(down, 1),
            "upFmt":  self._fmt(up),
            "downFmt": self._fmt(down),
        }


WIDGET = NetspeedWidget()
