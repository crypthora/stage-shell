"""desktops.py —— Windows 11 虚拟桌面：pyvda 优先，注册表 + 模拟快捷键回退。

依赖 winver 已先行打过版本补丁，否则 pyvda 的 _check_version() 会拒绝导入。
"""
import time
import struct
import winreg
import ctypes
import traceback

import win32gui

from . import winver
from .winver import user32, dwmapi, DWMWA_CLOAKED

# pyvda 必须在 winver 补丁之后导入
try:
    import pythoncom
except Exception:
    pythoncom = None

try:
    from pyvda import AppView, VirtualDesktop
    from pyvda import get_virtual_desktops as _pyvda_get_desktops
except Exception:
    AppView = None
    VirtualDesktop = None
    _pyvda_get_desktops = None
    try:
        with open("pyvda_import_error.log", "w", encoding="utf-8") as _ef:
            _ef.write(traceback.format_exc())
    except Exception:
        pass

VD_BASE = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops"
VD_SESS = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SessionInfo"

_pyvda_err_logged = False


def co_initialize():
    """主线程初始化 COM（pyvda 需要）。"""
    if pythoncom is not None:
        try:
            pythoncom.CoInitialize()
        except Exception:
            pass


# ---------- 注册表回退 ----------
def _reg_bytes(path, name):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            val, _ = winreg.QueryValueEx(k, name)
            return bytes(val)
    except Exception:
        return None


def _guid_str(b):
    if len(b) != 16:
        return ""
    d1, d2, d3 = struct.unpack("<IHH", b[:8])
    d4 = b[8:]
    return ("{%08X-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}"
            % (d1, d2, d3, d4[0], d4[1], d4[2], d4[3], d4[4], d4[5], d4[6], d4[7]))


def get_virtual_desktops():
    """返回 (guids, active_index, names)；读不到则 ([零GUID], 0, ['桌面 1'])。"""
    ids = _reg_bytes(VD_BASE, "VirtualDesktopIDs")
    cur = _reg_bytes(VD_BASE, "CurrentVirtualDesktop")
    if cur is None:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, VD_SESS) as sk:
                i = 0
                while cur is None:
                    sub = winreg.EnumKey(sk, i)
                    i += 1
                    cur = _reg_bytes(VD_SESS + "\\" + sub + "\\VirtualDesktops",
                                     "CurrentVirtualDesktop")
        except Exception:
            pass
    if not ids:
        return [b"\x00" * 16], 0, ["桌面 1"]
    guids = [ids[i:i + 16] for i in range(0, len(ids), 16)]
    active = 0
    if cur:
        for idx, g in enumerate(guids):
            if g == cur:
                active = idx
                break
    names = []
    for idx, g in enumerate(guids):
        nm = None
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                VD_BASE + r"\Desktops" + "\\" + _guid_str(g)) as dk:
                nm, _ = winreg.QueryValueEx(dk, "Name")
        except Exception:
            nm = None
        names.append(nm if nm else "桌面 %d" % (idx + 1))
    return guids, active, names


def switch_virtual_desktop(target, current):
    steps = target - current
    if steps == 0:
        return
    vk = 0x27 if steps > 0 else 0x25      # VK_RIGHT / VK_LEFT
    LWIN, CTRL, EXT, UP = 0x5B, 0x11, 0x0001, 0x0002
    for _ in range(abs(steps)):
        user32.keybd_event(LWIN, 0, 0, 0)
        user32.keybd_event(CTRL, 0, 0, 0)
        user32.keybd_event(vk, 0, EXT, 0)
        user32.keybd_event(vk, 0, EXT | UP, 0)
        user32.keybd_event(CTRL, 0, UP, 0)
        user32.keybd_event(LWIN, 0, UP, 0)
        time.sleep(0.06)


# ---------- pyvda（可用时优先） ----------
def _log_pyvda_error():
    global _pyvda_err_logged
    if _pyvda_err_logged:
        return
    _pyvda_err_logged = True
    try:
        with open("pyvda_error.log", "w", encoding="utf-8") as f:
            f.write(traceback.format_exc())
    except Exception:
        pass


def pyvda_desktop_info():
    """返回 (desktops, active_index, names, current_number)；不可用返回 None。"""
    if VirtualDesktop is None or _pyvda_get_desktops is None:
        return None
    try:
        desks = _pyvda_get_desktops()
        cur = VirtualDesktop.current().number
        active, names = 0, []
        for i, d in enumerate(desks):
            if d.number == cur:
                active = i
            try:
                nm = d.name
            except Exception:
                nm = ""
            names.append(nm or ("桌面 %d" % d.number))
        return desks, active, names, cur
    except Exception:
        _log_pyvda_error()
        return None


def window_desktop_number(hwnd):
    try:
        return AppView(hwnd=hwnd).desktop.number
    except Exception:
        return None


def move_window_to_desktop(hwnd, desk):
    if AppView is None:
        return False
    try:
        av = AppView(hwnd=hwnd)
        # pyvda 0.5.0 把方法从 move_to_desktop() 改名为 move()；兼容新旧两版。
        mv = getattr(av, "move", None) or getattr(av, "move_to_desktop", None)
        if mv is None:
            return False
        mv(desk)
        return True
    except Exception:
        return False


def pin_window(hwnd):
    """把窗口钉到所有虚拟桌面（切桌面时侧栏不跟着滑动）。"""
    if AppView is None:
        return False
    try:
        AppView(hwnd=hwnd).pin()
        return True
    except Exception:
        return False


def current_desktop_number():
    if VirtualDesktop is None:
        return None
    try:
        return VirtualDesktop.current().number
    except Exception:
        return None
