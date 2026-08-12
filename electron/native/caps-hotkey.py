"""Reliable CapsLock hold-to-record bridge for the Electron voice core.

The process deliberately contains no ASR or UI logic.  It listens to native
Windows events with pynput (the same mechanism used by CapsWriter) and sends
only serialized localhost HTTP commands to Electron's voice service.
"""

from __future__ import annotations

import sys
import threading
import os
import time
import ctypes
from concurrent.futures import ThreadPoolExecutor
from urllib.error import URLError
from urllib.request import Request, urlopen

from pynput import keyboard


WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105
VK_CAPITAL = 0x14
DOWN_MESSAGES = {WM_KEYDOWN, WM_SYSKEYDOWN}
UP_MESSAGES = {WM_KEYUP, WM_SYSKEYUP}
LLKHF_INJECTED = 0x10
KEYEVENTF_KEYUP = 0x0002
USER32 = ctypes.windll.user32


def diagnostic(message: str) -> None:
    """Small local-only trace for physical key-hook diagnosis."""
    try:
        app_name = os.environ.get("STAGE_SHELL_APP_NAME", "stage-shell")
        path = os.path.join(os.environ.get("APPDATA", "."), app_name, "caps-hotkey.log")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} pid={os.getpid()} {message}\n")
    except OSError:
        pass


def caps_is_locked() -> bool:
    return bool(USER32.GetKeyState(VK_CAPITAL) & 1)


def caps_is_physically_down() -> bool:
    return bool(USER32.GetAsyncKeyState(VK_CAPITAL) & 0x8000)


def force_caps_off() -> None:
    """Keep the repurposed key and its LED off outside a real PTT hold."""
    if caps_is_locked():
        USER32.keybd_event(VK_CAPITAL, 0, 0, 0)
        USER32.keybd_event(VK_CAPITAL, 0, KEYEVENTF_KEYUP, 0)
        diagnostic("caps lock reset")


class CapsHoldBridge:
    def __init__(self, api: str) -> None:
        self.api = api.rstrip("/")
        self.is_held = False
        self.lock = threading.Lock()
        # A single worker keeps start and stop in their original order while
        # the low-level hook itself always returns immediately.
        self.requests = ThreadPoolExecutor(max_workers=1, thread_name_prefix="caps-voice")
        self.listener: keyboard.Listener | None = None
        self.pressed_at = 0.0
        self.release_epoch = 0
        self.last_hook_event = time.monotonic()
        self.last_heartbeat = 0.0
        self.last_physical_down = caps_is_physically_down()
        self.missing_down_reported = False

    def _post(self, endpoint: str) -> None:
        request = Request(f"{self.api}{endpoint}", method="POST")
        for attempt in range(3):
            try:
                with urlopen(request, timeout=1.5):
                    return
            except (OSError, URLError):
                # The native hook can become ready slightly before Electron's
                # local voice service. Retry the same physical transition;
                # dropping it makes the first CapsLock hold look unhooked.
                if attempt < 2:
                    time.sleep(0.18)
        diagnostic(f"request failed {endpoint} after retries")

    def _queue(self, endpoint: str) -> None:
        self.requests.submit(self._post, endpoint)

    def filter(self, message, data):
        # Our LED/state reset must reach Windows.  It must never re-enter the
        # PTT state machine and create a synthetic start/stop loop.
        if getattr(data, "flags", 0) & LLKHF_INJECTED:
            return True
        if data.vkCode != VK_CAPITAL:
            return True

        self.last_hook_event = time.monotonic()

        if message in DOWN_MESSAGES:
            with self.lock:
                if not self.is_held:
                    self.is_held = True
                    self.pressed_at = time.monotonic()
                    self.release_epoch += 1
                    diagnostic("caps down")
                    self._queue("/v1/voice/record/start")
            # Suppress every repeat too: the target application and CapsLock
            # state never see this key while it is used as a push-to-talk key.
            self.listener.suppress_event()
        elif message in UP_MESSAGES:
            with self.lock:
                if self.is_held:
                    diagnostic("caps up")
                    epoch = self.release_epoch
                    threading.Thread(target=self._confirm_release, args=(epoch,), daemon=True).start()
            self.listener.suppress_event()

        return True

    def _confirm_release(self, epoch: int) -> None:
        # Some keyboard drivers briefly emit WM_KEYUP during auto-repeat.  Only
        # a stable physical release ends PTT, otherwise a long hold flashes the
        # recorder rapidly between start and stop.
        time.sleep(0.035)
        with self.lock:
            if epoch != self.release_epoch or not self.is_held or caps_is_physically_down():
                return
            self.is_held = False
            if time.monotonic() - self.pressed_at < 0.35:
                self._queue("/v1/voice/ptt/toggle-editor")
            else:
                self._queue("/v1/voice/record/stop")

    def _caps_guard(self) -> None:
        while True:
            # During a correctly suppressed physical hold the state is already
            # off.  This catches state left behind by shutdowns or hook loss.
            if not self.is_held:
                force_caps_off()
            now = time.monotonic()
            physical_down = caps_is_physically_down()
            # A normal low-level hook receives CapsLock down immediately. If
            # Windows reports the hardware key held but no callback arrived,
            # do not synthesize a recording (that could duplicate input); log
            # an actionable conflict suspicion instead. This catches drivers,
            # keyboard remappers and competing hooks that swallow the event.
            if physical_down and not self.is_held and now - self.last_hook_event > 0.18:
                if not self.missing_down_reported:
                    diagnostic("warning physical CapsLock is down but hook saw no event; possible key conflict or swallowed hook")
                    self.missing_down_reported = True
            elif not physical_down:
                self.missing_down_reported = False
            self.last_physical_down = physical_down
            if now - self.last_heartbeat >= 15:
                diagnostic(f"heartbeat listener={bool(self.listener and self.listener.is_alive())} held={self.is_held} physical={physical_down}")
                self.last_heartbeat = now
            time.sleep(0.25)

    def run(self) -> None:
        try:
            self.listener = keyboard.Listener(win32_event_filter=self.filter)
            self.listener.start()
            diagnostic(f"listener running={self.listener.is_alive()} api={self.api}")
            threading.Thread(target=self._caps_guard, daemon=True, name="caps-led-guard").start()
            self.listener.join()
        except BaseException as error:
            diagnostic(f"listener fatal {type(error).__name__}: {error}")
            raise


if __name__ == "__main__":
    if "--force-off" in sys.argv:
        force_caps_off()
    else:
        CapsHoldBridge(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7798").run()
