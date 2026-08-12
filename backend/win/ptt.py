"""ptt.py —— 为 Electron 语音核心保留的 Windows 文本注入与剪贴板辅助。"""
import base64
import ctypes
import io
import os
import threading
import time
from ctypes import wintypes

import win32con
import win32clipboard

try:
    from PIL import ImageGrab
except Exception:  # pragma: no cover
    ImageGrab = None

from . import winver
from .winver import (user32, kernel32, VK_CAPITAL, VK_CONTROL, VK_V,
                     KEYEVENTF_KEYUP, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
                     WM_SYSKEYDOWN, WM_SYSKEYUP, LLKHF_INJECTED, LRESULT)

_ptt_inject_flag = False
_ptt_inject_ts = 0.0
_clip_watch_lock = threading.RLock()
_clip_watch_until = 0.0
_clip_watch_cutoff = 0


def _mark_injecting():
    global _ptt_inject_flag, _ptt_inject_ts
    _ptt_inject_flag = True
    _ptt_inject_ts = time.time()


def _self_injected():
    """二级防自捕获；主防线是事件自带的 LLKHF_INJECTED 位。"""
    global _ptt_inject_flag
    if _ptt_inject_flag and (time.time() - _ptt_inject_ts) < 0.5:
        _ptt_inject_flag = False
        return True
    _ptt_inject_flag = False
    return False


def caps_is_on():
    return (user32.GetKeyState(VK_CAPITAL) & 1) == 1


def emit_caps_tap():
    """合成一次 Caps 点按(切换一次状态/灯)。"""
    _mark_injecting()
    user32.keybd_event(VK_CAPITAL, 0, 0, 0)
    user32.keybd_event(VK_CAPITAL, 0, KEYEVENTF_KEYUP, 0)


def force_caps_off():
    """把 CapsLock 复位到关(灯灭)。幂等。"""
    try:
        if caps_is_on():
            emit_caps_tap()
        if caps_is_on():
            emit_caps_tap()
    except Exception:
        pass


def clipboard_sequence():
    """返回当前剪贴板序号；失败时返回 None。"""
    try:
        return int(win32clipboard.GetClipboardSequenceNumber())
    except Exception:
        return None


def _clip_watch_pause(seconds=0.8):
    """短暂忽略剪贴板变更，给内部粘贴/还原留出缓冲。"""
    if seconds <= 0:
        return
    until = time.time() + float(seconds)
    with _clip_watch_lock:
        global _clip_watch_until
        if until > _clip_watch_until:
            _clip_watch_until = until


def _clip_watch_skip_current():
    """把当前剪贴板序号纳入忽略区间，避免记录内部写入。"""
    seq = clipboard_sequence()
    if seq is None:
        return
    with _clip_watch_lock:
        global _clip_watch_cutoff
        if seq > _clip_watch_cutoff:
            _clip_watch_cutoff = seq


def clipboard_watch_suppressed():
    """当前是否处在内部写入缓冲期。"""
    with _clip_watch_lock:
        return time.time() < _clip_watch_until


def clipboard_watch_cutoff():
    """内部写入后应忽略到的剪贴板序号。"""
    with _clip_watch_lock:
        return _clip_watch_cutoff


def read_clipboard_snapshot():
    """读取当前剪贴板快照。

    返回：
    - {"kind":"text", "text":"..."}
    - {"kind":"file", "file_name":"...", "files":[...]}
    - {"kind":"image", "data_url":"data:image/png;base64,..."}
    读取失败或被内部写入抑制时返回 None。
    """
    if clipboard_watch_suppressed():
        return None
    text = _clip_get()
    if text is not None:
        return {"kind": "text", "text": text}
    if ImageGrab is None:
        return None
    try:
        grabbed = ImageGrab.grabclipboard()
    except Exception:
        return None
    if isinstance(grabbed, (list, tuple)) and grabbed:
        files = [str(p) for p in grabbed if p]
        if not files:
            return None
        names = [os.path.basename(p.rstrip("\\/")) or p for p in files]
        return {"kind": "file", "file_name": "、".join(names), "files": files}
    if grabbed is not None and hasattr(grabbed, "convert") and hasattr(grabbed, "save"):
        try:
            buf = io.BytesIO()
            img = grabbed.convert("RGBA")
            img.save(buf, format="PNG")
            data_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
            return {"kind": "image", "data_url": data_url}
        except Exception:
            return None
    return None


# ---------- 剪贴板粘贴插入（语音听写结果用） ----------
def _clip_get():
    for _ in range(3):
        try:
            win32clipboard.OpenClipboard()
            try:
                if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                    return win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
                return None
            finally:
                win32clipboard.CloseClipboard()
        except Exception:
            time.sleep(0.03)
    return None


def _clip_set(text):
    for _ in range(3):
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, text)
                return True
            finally:
                win32clipboard.CloseClipboard()
        except Exception:
            time.sleep(0.03)
    return False


def set_clipboard(text):
    """把文本放进剪贴板（不粘贴）。供 widget「复制」按钮用（侧栏无焦点，走 Win32 最稳）。"""
    return _clip_set(text or "")


def _send_ctrl_v():
    user32.keybd_event(VK_CONTROL, 0, 0, 0)
    user32.keybd_event(VK_V, 0, 0, 0)
    user32.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0)
    user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)


def insert_text(text, restore_clip=True, after=None):
    """把 text 通过剪贴板 Ctrl+V 粘贴到当前焦点处。after(fn, ms) 用于延迟还原剪贴板
    （传入上层的调度器，如 threading.Timer 包装）；为 None 时同步小睡还原。"""
    if not text:
        return
    _clip_watch_pause(0.9)
    old = _clip_get() if restore_clip else None
    if not _clip_set(text):
        return
    if not restore_clip or old is None:
        _clip_watch_skip_current()

    def _do_paste():
        _send_ctrl_v()
        if restore_clip and old is not None:
            def _restore():
                _clip_set(old)
                _clip_watch_skip_current()
            if after is not None:
                after(_restore, 150)
            else:
                time.sleep(0.15)
                _restore()

    if after is not None:
        after(_do_paste, 20)
    else:
        time.sleep(0.02)
        _do_paste()


# ---------- SendInput Unicode 直接打字（弹出/eject 用，绕开剪贴板，最稳） ----------
# 为什么换掉 剪贴板+Ctrl+V：鼠标点侧栏按钮触发注入时，剪贴板路径会和剪贴板管理器 /
# 目标读剪贴板的时机竞争 → 偶发失败（"似乎不可靠"）。SendInput 以 KEYEVENTF_UNICODE 把
# 每个字符当 Unicode 击键直接送进当前聚焦控件：不碰剪贴板、不依赖键盘布局、CJK 直接可用、
# 原子提交，且和「侧栏 NOACTIVATE 不抢前台」配合时直达真正的前台聚焦控件。
INPUT_KEYBOARD = 1
KEYEVENTF_UNICODE = 0x0004
VK_RETURN = 0x0D
_ULONG_PTR = ctypes.c_size_t          # 指针宽度无符号（x86/x64 通吃）


class _MOUSEINPUT(ctypes.Structure):  # 仅用于撑满 union 尺寸（cbSize 必须等于真 INPUT）
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", _ULONG_PTR)]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", _ULONG_PTR)]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUT_UNION)]


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(_INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT


def _kbd_event_struct(wVk, wScan, flags):
    e = _INPUT()
    e.type = INPUT_KEYBOARD
    e.ki = _KEYBDINPUT(wVk, wScan, flags, 0, 0)
    return e


def _utf16_units(ch):
    b = ch.encode("utf-16-le")            # 容 BMP 外字符（emoji 等）→ 代理对两单元
    return [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]


def send_text(text):
    """把 text 作为 Unicode 击键直接注入当前聚焦控件（不经剪贴板）。
    成功返回 True（注入事件数 == 期望数）；被 UIPI 拦截（如目标是管理员窗口）返回 False。"""
    if not text:
        return False
    seq = []
    for ch in text:
        if ch == "\n":
            seq.append(_kbd_event_struct(VK_RETURN, 0, 0))
            seq.append(_kbd_event_struct(VK_RETURN, 0, KEYEVENTF_KEYUP))
        elif ch == "\r":
            continue
        else:
            for unit in _utf16_units(ch):
                seq.append(_kbd_event_struct(0, unit, KEYEVENTF_UNICODE))
                seq.append(_kbd_event_struct(
                    0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    if not seq:
        return False
    n = len(seq)
    arr = (_INPUT * n)(*seq)
    sent = user32.SendInput(n, arr, ctypes.sizeof(_INPUT))
    return sent == n
