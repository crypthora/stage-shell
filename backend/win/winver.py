"""winver.py —— 进程级初始化：DPI 感知 + 谎报 Windows 版本补丁 + 共享 ctypes 句柄/常量。

import 本模块即触发两个副作用（必须在 import pyvda、创建窗口之前完成）：
  1. SetProcessDpiAwareness(2)：每显示器 DPI 感知，GetWindowRect 返回物理像素。
  2. _patch_winver()：有些 Python 进程清单把系统谎报成 Win8，pyvda 用 platform.release()
     检查会拒绝导入；这里用注册表真实版本覆盖 platform.release / sys.getwindowsversion。
"""
import sys
import ctypes
from ctypes import wintypes
import winreg

WINVER_BUILD = 0
WINVER_RELEASE = ""


def _patch_winver():
    global WINVER_BUILD, WINVER_RELEASE
    try:
        import collections
        import platform as _platform
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") as k:
            build = int(winreg.QueryValueEx(k, "CurrentBuildNumber")[0])
            try:
                major = int(winreg.QueryValueEx(k, "CurrentMajorVersionNumber")[0])
            except Exception:
                major = 10
        if major < 10:
            major = 10
        release = "11" if build >= 22000 else "10"
        WINVER_BUILD, WINVER_RELEASE = build, release
        _platform.release = lambda: release
        try:
            _platform._uname_cache = None
        except Exception:
            pass
        WV = collections.namedtuple(
            "WV", "major minor build platform service_pack platform_version")
        sys.getwindowsversion = lambda: WV(major, 0, build, 2, "", (major, 0, build))
    except Exception:
        pass


_patch_winver()

# DPI 感知：每显示器(2)。失败退回系统级。务必在创建任何窗口前调用。
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

# ---------- 共享 ctypes 句柄 ----------
user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
kernel32 = ctypes.windll.kernel32
shell32 = ctypes.windll.shell32
ole32 = ctypes.windll.ole32

# ---------- 常量 ----------
PW_RENDERFULLCONTENT = 0x00000002
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_NOACTIVATE = 0x08000000
GW_OWNER = 4
WM_GETICON = 0x7F
SMTO_ABORTIFHUNG = 0x0002
DWMWA_NCRENDERING_POLICY = 2
DWMRNCRP_DISABLED = 2
DWMWA_CLOAKED = 14
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_DONOTROUND = 1
DWMWA_BORDER_COLOR = 34
DWMWA_COLOR_NONE = 0xFFFFFFFE
SPI_GETWORKAREA = 0x0030
SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
SPIF_UPDATEINIFILE = 0x0001
SPIF_SENDCHANGE = 0x0002

# 键盘 / PTT
VK_CAPITAL = 0x14
VK_CONTROL = 0x11
VK_V = 0x56
KEYEVENTF_KEYUP = 0x0002
WH_KEYBOARD_LL = 13
WM_KEYDOWN, WM_KEYUP = 0x0100, 0x0101
WM_SYSKEYDOWN, WM_SYSKEYUP = 0x0104, 0x0105
LLKHF_INJECTED = 0x10
WM_QUIT = 0x0012

# AppBar
ABM_NEW, ABM_REMOVE, ABM_QUERYPOS, ABM_SETPOS = 0, 1, 2, 3
ABE_LEFT, ABE_RIGHT = 0, 2


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


# CallNextHookEx 的 argtypes 必须显式设为指针宽度类型，否则 64 位下 wParam/lParam
# 被按 c_int(32位) 截断，大地址溢出 → 钩子不传递事件。
LRESULT = ctypes.c_ssize_t
user32.CallNextHookEx.restype = LRESULT
user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                  ctypes.c_size_t, ctypes.c_ssize_t]


# ---------- 前台锁超时（防程序抢前台） ----------
def get_foreground_lock_timeout():
    """读取当前前台锁超时(ms)；失败返回 None。"""
    val = wintypes.DWORD(0)
    try:
        if user32.SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0,
                                        ctypes.byref(val), 0):
            return int(val.value)
    except Exception:
        pass
    return None


def set_foreground_lock_timeout(ms):
    """设前台锁超时(ms)。0=关闭(任何程序可抢前台)；大值=Windows 拒绝程序抢前台。
    pvParam 按"值塞进指针"传(同 SPI 文档)；仅改本会话不写 INI，注销/重启复位。成功返回 True。"""
    try:
        return bool(user32.SystemParametersInfoW(
            SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ctypes.c_void_p(int(ms)),
            SPIF_SENDCHANGE))
    except Exception:
        return False
