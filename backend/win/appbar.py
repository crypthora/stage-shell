"""appbar.py —— AppBar 屏幕边缘占位（让侧栏和任务栏/其它 AppBar 共存）。

参数化 bar_w / dock_right，不再依赖模块级全局。两条侧栏会自动堆叠
（第二条注册到已存在那条的内侧）。
"""
import ctypes
from ctypes import wintypes

from . import winver
from .winver import (user32, RECT, ABM_NEW, ABM_REMOVE, ABM_QUERYPOS,
                     ABM_SETPOS, ABE_LEFT, ABE_RIGHT, SPI_GETWORKAREA)


class APPBARDATA(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND),
                ("uCallbackMessage", wintypes.UINT), ("uEdge", wintypes.UINT),
                ("rc", RECT), ("lParam", wintypes.LPARAM)]


_SHAppBarMessage = ctypes.windll.shell32.SHAppBarMessage
MONITOR_DEFAULTTONEAREST = 2


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD),
                ("rcMonitor", RECT),
                ("rcWork", RECT),
                ("dwFlags", wintypes.DWORD)]


try:
    user32.MonitorFromWindow.restype = wintypes.HANDLE
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.GetMonitorInfoW.restype = wintypes.BOOL
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]
except Exception:
    pass


def get_monitor_rect(hwnd=None):
    """返回窗口所在显示器的完整边界 (left, top, right, bottom)。"""
    if hwnd:
        try:
            mon = user32.MonitorFromWindow(wintypes.HWND(int(hwnd)),
                                           MONITOR_DEFAULTTONEAREST)
            if mon:
                info = MONITORINFO()
                info.cbSize = ctypes.sizeof(MONITORINFO)
                if user32.GetMonitorInfoW(mon, ctypes.byref(info)):
                    r = info.rcMonitor
                    if r.right > r.left and r.bottom > r.top:
                        return (r.left, r.top, r.right, r.bottom)
        except Exception:
            pass
    try:
        left = int(user32.GetSystemMetrics(76))   # SM_XVIRTUALSCREEN
        top = int(user32.GetSystemMetrics(77))    # SM_YVIRTUALSCREEN
        width = int(user32.GetSystemMetrics(78))   # SM_CXVIRTUALSCREEN
        height = int(user32.GetSystemMetrics(79))  # SM_CYVIRTUALSCREEN
        if width > 0 and height > 0:
            return (left, top, left + width, top + height)
    except Exception:
        pass
    return (0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))


def get_work_area(hwnd=None):
    """返回当前工作区 (left, top, right, bottom)。"""
    if hwnd:
        try:
            mon = user32.MonitorFromWindow(wintypes.HWND(int(hwnd)),
                                           MONITOR_DEFAULTTONEAREST)
            if mon:
                info = MONITORINFO()
                info.cbSize = ctypes.sizeof(MONITORINFO)
                if user32.GetMonitorInfoW(mon, ctypes.byref(info)):
                    r = info.rcWork
                    if r.right > r.left and r.bottom > r.top:
                        return (r.left, r.top, r.right, r.bottom)
        except Exception:
            pass
    r = RECT()
    try:
        if user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(r), 0):
            if r.right > r.left and r.bottom > r.top:
                return (r.left, r.top, r.right, r.bottom)
    except Exception:
        pass
    return (0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))


def appbar_register(hwnd, bar_w, dock_right=True):
    """注册 AppBar 并返回 (abd, (x, y, w, h))。abd 需保存以便退出时 remove。"""
    abd = APPBARDATA()
    abd.cbSize = ctypes.sizeof(APPBARDATA)
    abd.hWnd = hwnd
    abd.uEdge = ABE_RIGHT if dock_right else ABE_LEFT
    _SHAppBarMessage(ABM_NEW, ctypes.byref(abd))
    mon_left, mon_top, mon_right, mon_bottom = get_monitor_rect(hwnd)
    mon_w = max(1, mon_right - mon_left)
    bar_w = max(1, min(int(bar_w), mon_w))
    abd.rc.top, abd.rc.bottom = mon_top, mon_bottom
    if dock_right:
        abd.rc.left, abd.rc.right = mon_right - bar_w, mon_right
    else:
        abd.rc.left, abd.rc.right = mon_left, mon_left + bar_w
    _SHAppBarMessage(ABM_QUERYPOS, ctypes.byref(abd))
    abd.rc.top, abd.rc.bottom = mon_top, mon_bottom
    if dock_right:
        abd.rc.left = abd.rc.right - bar_w
    else:
        abd.rc.right = abd.rc.left + bar_w
    _SHAppBarMessage(ABM_SETPOS, ctypes.byref(abd))
    return abd, (abd.rc.left, abd.rc.top,
                 abd.rc.right - abd.rc.left, abd.rc.bottom - abd.rc.top)


def appbar_remove(abd):
    try:
        _SHAppBarMessage(ABM_REMOVE, ctypes.byref(abd))
    except Exception:
        pass
