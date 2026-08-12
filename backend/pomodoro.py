"""pomodoro.py —— 番茄钟状态机（基于挂钟时间）+ 提示音。

与旧实现的区别：不再每秒手动 -1，而是记录 end_time 并用 now 计算剩余，
这样推送节奏(700ms)与计时精度解耦，暂停/恢复也只是存取剩余秒数。
tick() 在引擎主循环里调用；跨越阶段边界时触发声音。
"""
import os
import time
import threading

import winsound

import config


class Pomodoro:
    def __init__(self):
        self.phase = "idle"          # idle / work / break / done
        self.running = False
        self._end = 0.0              # running 时的结束时刻(挂钟)
        self._left = self._work_sec()  # 暂停/待机时的权威剩余秒
        self._bg_timer = None

    # ---------- 配置 ----------
    @staticmethod
    def _work_sec():
        return max(1, int(config.get("WORK_SEC", 1500)))

    @staticmethod
    def _break_sec():
        return max(1, int(config.get("BREAK_SEC", 300)))

    # ---------- 交互 ----------
    def toggle(self):
        if self.phase == "done":              # 点"结束" -> 回待机
            self.reset()
        elif self.phase == "idle":            # 待机 -> 开始工作
            self.phase = "work"
            self.running = True
            self._left = self._work_sec()
            self._end = time.time() + self._left
        else:                                 # 工作/休息中 -> 暂停/继续
            if self.running:
                self._left = max(0, self._end - time.time())
                self.running = False
            else:
                self.running = True
                self._end = time.time() + self._left

    def reset(self):
        self.phase = "idle"
        self.running = False
        self._left = self._work_sec()
        self._stop_bg()

    # ---------- 每帧推进 ----------
    def tick(self):
        if not self.running or self.phase not in ("work", "break"):
            return
        remaining = self._end - time.time()
        if remaining > 0:
            self._left = remaining
            return
        if self.phase == "work":              # 工作结束 -> 进入休息
            self.phase = "break"
            self._left = self._break_sec()
            self._end = time.time() + self._left
            self._play("work_to_break")
        else:                                 # 休息结束 -> 提示待机
            self.phase = "done"
            self.running = False
            self._left = 0
            self._play("break_to_done")

    # ---------- 快照（供 build_state） ----------
    def snapshot(self):
        left = self._left
        if self.running and self.phase in ("work", "break"):
            left = max(0, self._end - time.time())
        if self.phase == "work":
            frac = left / self._work_sec()
        elif self.phase == "break":
            frac = left / self._break_sec()
        elif self.phase == "done":
            frac = 1.0
        else:
            frac = 0.0
        left_i = int(left + 0.999)            # 向上取整，避免显示 00:00 还在跑
        breathe = None
        if self.phase == "break":
            breathe = config.get("SIDEBAR_BREATHE_BREAK", "#5b8c6e")
        elif self.phase == "done":
            breathe = config.get("SIDEBAR_BREATHE_DONE", "#5b7a9c")
        return {
            "phase": self.phase,
            "running": self.running,
            "left": "%02d:%02d" % (left_i // 60, left_i % 60),
            "fraction": max(0.0, min(1.0, frac)),
            "breathe": breathe,
        }

    # ---------- 声音 ----------
    def _play(self, event):
        if not config.get("SOUND_ENABLED", True):
            return
        if event == "work_to_break":
            done = config.get("SOUND_WORK_DONE", "")
            if done and os.path.exists(done):
                self._play_file(done)
            bg = config.get("SOUND_BREAK_BG", "")
            if bg and os.path.exists(bg):
                # 3 秒后开始循环白噪音（让提示音先播完）
                self._stop_bg()
                self._bg_timer = threading.Timer(3.0, self._loop_file, args=(bg,))
                self._bg_timer.daemon = True
                self._bg_timer.start()
        elif event == "break_to_done":
            self._stop_bg()
            try:
                winsound.PlaySound(None, winsound.SND_PURGE)   # 停白噪音
            except Exception:
                pass
            done = config.get("SOUND_BREAK_DONE", "")
            if done and os.path.exists(done):
                t = threading.Timer(0.2, self._play_file, args=(done,))
                t.daemon = True
                t.start()

    @staticmethod
    def _play_file(path):
        try:
            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC
                               | winsound.SND_NOWAIT)
        except Exception:
            pass

    @staticmethod
    def _loop_file(path):
        try:
            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC
                               | winsound.SND_LOOP | winsound.SND_NOWAIT)
        except Exception:
            pass

    def _stop_bg(self):
        if self._bg_timer is not None:
            try:
                self._bg_timer.cancel()
            except Exception:
                pass
            self._bg_timer = None
        try:
            winsound.PlaySound(None, winsound.SND_PURGE)
        except Exception:
            pass
