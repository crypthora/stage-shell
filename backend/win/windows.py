"""windows.py —— 窗口枚举 / 图标 / 缩略图 / 贴靠分组 / 聚焦。

共享的纯 Win32 逻辑；尺寸相关函数改为接收参数（tw/th），
不再依赖模块级全局，便于上层用 config 注入。
"""
import ctypes
from ctypes import wintypes

import win32gui
import win32con
import win32process
import win32ui
import psutil
from PIL import Image, ImageEnhance

from . import winver
from .winver import (user32, dwmapi, kernel32, shell32, ole32,
                     PW_RENDERFULLCONTENT, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW,
                     GW_OWNER, WM_GETICON, SMTO_ABORTIFHUNG, DWMWA_CLOAKED,
                     SPI_GETWORKAREA, RECT)


# ============================ 可见性 ============================
def is_cloaked(hwnd):
    val = ctypes.c_int(0)
    try:
        dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED,
                                     ctypes.byref(val), ctypes.sizeof(val))
    except Exception:
        return False
    return val.value != 0


def cloaked_value(hwnd):
    val = ctypes.c_int(0)
    try:
        dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED,
                                     ctypes.byref(val), ctypes.sizeof(val))
    except Exception:
        return 0
    return val.value


def is_desktop_window(hwnd):
    """前台是否为桌面(显示桌面/Win+D 时 fg 变成 Progman 或 WorkerW)。"""
    if not hwnd:
        return False


def is_outputs_auxiliary_window(title):
    """Electron 的无焦点捕获/提示窗口不是用户应用，绝不参与桌面卡片。"""
    return (title or "").casefold() in {
        "outputs electron voice overlay",
        "outputs voice capture",
    }
    try:
        return win32gui.GetClassName(hwnd) in ("Progman", "WorkerW")
    except Exception:
        return False


def list_windows(own_hwnd):
    """当前桌面上的真实应用窗口 [(hwnd, title), ...]。"""
    out = []

    def cb(hwnd, _):
        if hwnd == own_hwnd or not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        if not title:
            return
        if is_outputs_auxiliary_window(title):
            return
        ex = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
        if ex & WS_EX_TOOLWINDOW:
            return
        owner = win32gui.GetWindow(hwnd, GW_OWNER)
        if owner and not (ex & WS_EX_APPWINDOW):
            return
        if is_cloaked(hwnd):
            return
        out.append((hwnd, title))

    win32gui.EnumWindows(cb, None)
    return out


def list_all_windows(own_hwnd):
    """枚举所有桌面上的真实应用窗口(含其它桌面)。排除挂起的 UWP(cloak=1/4)。"""
    out = []

    def cb(hwnd, _):
        if hwnd == own_hwnd or not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        if not title:
            return
        if is_outputs_auxiliary_window(title):
            return
        ex = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
        if ex & WS_EX_TOOLWINDOW:
            return
        owner = win32gui.GetWindow(hwnd, GW_OWNER)
        if owner and not (ex & WS_EX_APPWINDOW):
            return
        if cloaked_value(hwnd) not in (0, 2):   # 0=可见, 2=在其它桌面
            return
        out.append((hwnd, title))

    win32gui.EnumWindows(cb, None)
    return out


def exe_of(hwnd):
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return psutil.Process(pid).name().lower()
    except Exception:
        return ""


# ---------- 浏览器 PWA/应用窗口识别：按 AppUserModelID 独立分组 ----------
BROWSER_EXES = {"chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe"}


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]


class _PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", _GUID), ("pid", wintypes.DWORD)]


class _PROPVARIANT(ctypes.Structure):           # 仅需读 VT_LPWSTR; val 在偏移 8 处
    _fields_ = [("vt", wintypes.USHORT), ("_r1", wintypes.USHORT),
                ("_r2", wintypes.USHORT), ("_r3", wintypes.USHORT),
                ("val", ctypes.c_void_p), ("_pad", ctypes.c_void_p)]


def _make_guid(s):
    g = _GUID()
    ole32.CLSIDFromString(ctypes.c_wchar_p(s), ctypes.byref(g))
    return g


_IID_IPropertyStore = _make_guid("{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}")
_PKEY_AppUserModel_ID = _PROPERTYKEY(
    _make_guid("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}"), 5)
_VT_LPWSTR = 31
_GetValueFn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                 ctypes.POINTER(_PROPERTYKEY),
                                 ctypes.POINTER(_PROPVARIANT))
_ReleaseFn = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
shell32.SHGetPropertyStoreForWindow.argtypes = [
    wintypes.HWND, ctypes.POINTER(_GUID), ctypes.POINTER(ctypes.c_void_p)]
shell32.SHGetPropertyStoreForWindow.restype = ctypes.c_long


def window_app_id(hwnd):
    """窗口的 AppUserModelID(任务栏据此分组)；PWA/应用窗口各有独立 ID。失败返回 ''。"""
    store = ctypes.c_void_p()
    try:
        if shell32.SHGetPropertyStoreForWindow(
                hwnd, ctypes.byref(_IID_IPropertyStore),
                ctypes.byref(store)) != 0 or not store.value:
            return ""
        vtbl = ctypes.cast(store, ctypes.POINTER(ctypes.c_void_p))[0]
        funcs = ctypes.cast(vtbl, ctypes.POINTER(ctypes.c_void_p))
        get_value, release = _GetValueFn(funcs[5]), _ReleaseFn(funcs[2])
        pv = _PROPVARIANT()
        try:
            if get_value(store, ctypes.byref(_PKEY_AppUserModel_ID),
                         ctypes.byref(pv)) == 0 and pv.vt == _VT_LPWSTR and pv.val:
                return ctypes.cast(pv.val, ctypes.c_wchar_p).value or ""
        finally:
            ole32.PropVariantClear(ctypes.byref(pv))
            release(store)
    except Exception:
        pass
    return ""


def app_key(hwnd):
    """窗口分组键：浏览器 PWA/应用窗口用各自 AppUserModelID 独立成项，其余按进程名归并。"""
    e = exe_of(hwnd)
    if e in BROWSER_EXES:
        aid = window_app_id(hwnd)
        if aid and "_crx_" in aid:
            return aid
    return e


# ============================ 图标 ============================
def get_hicon(hwnd):
    for t in (1, 2, 0):
        try:
            rc, res = win32gui.SendMessageTimeout(hwnd, WM_GETICON, t, 0,
                                                  SMTO_ABORTIFHUNG, 200)
            if res:
                return res
        except Exception:
            pass
    for idx in (-14, -34):
        try:
            h = win32gui.GetClassLong(hwnd, idx)
            if h:
                return h
        except Exception:
            pass
    return None


def hicon_to_image(hicon, size):
    # GDI 对象/DC 的释放放进 finally：任何中途异常（DrawIconEx/GetBitmapBits 等）
    # 都不会泄漏位图与 DC（图标位图较小但累积同样致命）。
    screen = hdc = mdc = bmp = None
    try:
        screen = win32gui.GetDC(0)
        hdc = win32ui.CreateDCFromHandle(screen)
        mdc = hdc.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(hdc, size, size)
        mdc.SelectObject(bmp)
        try:
            win32gui.DrawIconEx(mdc.GetSafeHdc(), 0, 0, hicon, size, size,
                                0, None, win32con.DI_NORMAL)
        except Exception:
            pass
        info = bmp.GetInfo()
        bits = bmp.GetBitmapBits(True)
        img = Image.frombuffer("RGBA", (info["bmWidth"], info["bmHeight"]),
                               bits, "raw", "BGRA", 0, 1)
        if img.getchannel("A").getextrema() == (0, 0):
            img.putalpha(255)
        return img
    finally:
        try:
            if bmp is not None:
                win32gui.DeleteObject(bmp.GetHandle())
        except Exception:
            pass
        try:
            if mdc is not None:
                mdc.DeleteDC()
        except Exception:
            pass
        try:
            if hdc is not None:
                hdc.DeleteDC()
        except Exception:
            pass
        try:
            if screen is not None:
                win32gui.ReleaseDC(0, screen)
        except Exception:
            pass


def icon_image(hwnd, size=40):
    """便捷：取窗口图标并缩放到 size×size 的 PIL(RGBA)；无图标返回 None。"""
    hic = get_hicon(hwnd)
    if not hic:
        return None
    try:
        img = hicon_to_image(hic, max(size, 40))
        if img.size != (size, size):
            img = img.resize((size, size), Image.LANCZOS)
        return img
    except Exception:
        return None


def mono_icon(icon_img, size, opacity=0.50):
    """固定尺寸的半透明降饱和图标（快捷区提示用）。"""
    img = icon_img.resize((size, size), Image.LANCZOS).convert("RGBA")
    r, g, b, a = img.split()
    rgb = ImageEnhance.Color(Image.merge("RGB", (r, g, b))).enhance(0.5)
    r2, g2, b2 = rgb.split()
    return Image.merge("RGBA", (r2, g2, b2, a.point(lambda v: int(v * opacity))))


# ============================ 缩略图 ============================
def cover_fit(img, tw, th):
    """按比例放大裁剪填满 (tw,th)，不留黑边。"""
    iw, ih = img.size
    if iw <= 0 or ih <= 0:
        return Image.new("RGBA", (tw, th), (28, 28, 28, 255))
    scale = max(tw / iw, th / ih)
    nw, nh = max(1, int(iw * scale + 0.5)), max(1, int(ih * scale + 0.5))
    img = img.resize((nw, nh), Image.LANCZOS)
    x, y = (nw - tw) // 2, (nh - th) // 2
    return img.crop((x, y, x + tw, y + th))


def grab_raw(hwnd):
    """抓取窗口原始画面 PIL(RGBA)；失败返回 None。

    位图按窗口实际尺寸创建（最大化窗口在 4K 下 ~33MB/张）。原实现把 DeleteObject/
    DeleteDC/ReleaseDC 排在 happy-path 末尾，PrintWindow/GetBitmapBits 一旦中途抛异常
    就整套泄漏 → 漏百来张即数 GB。这里把释放全部移进 finally，保证每条路径都回收。
    """
    hwnd_dc = mfc_dc = save_dc = bmp = None
    try:
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        w, h = r - l, b - t
        if w <= 0 or h <= 0:
            return None
        hwnd_dc = win32gui.GetWindowDC(hwnd)
        mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
        save_dc = mfc_dc.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(mfc_dc, w, h)
        save_dc.SelectObject(bmp)
        user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), PW_RENDERFULLCONTENT)
        info = bmp.GetInfo()
        bits = bmp.GetBitmapBits(True)
        img = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]),
                               bits, "raw", "BGRX", 0, 1)
        return img.convert("RGBA")
    except Exception:
        return None
    finally:
        try:
            if bmp is not None:
                win32gui.DeleteObject(bmp.GetHandle())
        except Exception:
            pass
        try:
            if save_dc is not None:
                save_dc.DeleteDC()
        except Exception:
            pass
        try:
            if mfc_dc is not None:
                mfc_dc.DeleteDC()
        except Exception:
            pass
        try:
            if hwnd_dc is not None:
                win32gui.ReleaseDC(hwnd, hwnd_dc)
        except Exception:
            pass


def grab_thumbnail(hwnd, tw, th):
    raw = grab_raw(hwnd)
    return cover_fit(raw, tw, th) if raw is not None else None


# ============================ 贴靠分组(Snap groups) ============================
ZONE_ORDER = {"TL": 0, "T": 1, "L": 2, "TR": 3, "R": 4, "BL": 5, "B": 6, "BR": 7}
SNAP_TOL = 40
SNAP_COVER = 0.80


def get_work_area():
    r = RECT()
    try:
        user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(r), 0)
        if r.right > r.left and r.bottom > r.top:
            return (r.left, r.top, r.right, r.bottom)
    except Exception:
        pass
    return (0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))


def _overlap_xy(a, b):
    return (min(a[2], b[2]) - max(a[0], b[0]),
            min(a[3], b[3]) - max(a[1], b[1]))


def _snap_adjacent(a, b, tol=SNAP_TOL):
    """两窗是否"贴靠相邻"：共享一条有长度的边、内部不实质重叠。只比较窗与窗，不参照工作区。"""
    ov_x, ov_y = _overlap_xy(a, b)
    if ov_x > tol and ov_y > tol:
        return False
    al, at, ar, ab = a
    bl, bt, br, bb = b
    touch_v = (abs(ar - bl) <= tol or abs(br - al) <= tol) and ov_y > tol
    touch_h = (abs(ab - bt) <= tol or abs(bb - at) <= tol) and ov_x > tol
    return touch_v or touch_h


def _zone_in_bbox(r, bbox, tol=SNAP_TOL):
    bl, bt, br, bb = bbox
    full_h = abs(r[1] - bt) <= tol and abs(r[3] - bb) <= tol
    full_w = abs(r[0] - bl) <= tol and abs(r[2] - br) <= tol
    left = (r[0] + r[2]) / 2 < (bl + br) / 2
    top = (r[1] + r[3]) / 2 < (bt + bb) / 2
    if full_h and not full_w:
        return "L" if left else "R"
    if full_w and not full_h:
        return "T" if top else "B"
    return ("TL" if top else "BL") if left else ("TR" if top else "BR")


def compute_snap_groups(wins):
    """识别 Windows 贴靠分组：基于窗与窗几何关系，并查集连成组。
    返回 (groups, member_to_rep)；groups: rep_hwnd -> [(hwnd, zone), ...]。"""
    cand = []
    for hwnd, _ in wins:
        try:
            if win32gui.IsIconic(hwnd):
                continue
            r = tuple(win32gui.GetWindowRect(hwnd))
        except Exception:
            continue
        if r[2] - r[0] > 0 and r[3] - r[1] > 0:
            cand.append((hwnd, r))
    n = len(cand)
    if n < 2:
        return {}, {}
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if _snap_adjacent(cand[i][1], cand[j][1]):
                parent[find(i)] = find(j)
    comps = {}
    for i in range(n):
        comps.setdefault(find(i), []).append(i)
    groups, m2r = {}, {}
    for idxs in comps.values():
        if len(idxs) < 2:
            continue
        rects = [cand[k][1] for k in idxs]
        bl = min(r[0] for r in rects); bt = min(r[1] for r in rects)
        br = max(r[2] for r in rects); bb = max(r[3] for r in rects)
        if (br - bl) < 200 or (bb - bt) < 200:
            continue
        overlap = any((lambda o: o[0] > SNAP_TOL and o[1] > SNAP_TOL)(
                          _overlap_xy(rects[a], rects[b]))
                      for a in range(len(rects)) for b in range(a + 1, len(rects)))
        area_sum = sum((r[2] - r[0]) * (r[3] - r[1]) for r in rects)
        if overlap or area_sum < SNAP_COVER * (br - bl) * (bb - bt):
            continue
        members = [(cand[k][0], _zone_in_bbox(cand[k][1], (bl, bt, br, bb)))
                   for k in idxs]
        members.sort(key=lambda hz: ZONE_ORDER.get(hz[1], 9))
        rep = members[0][0]
        groups[rep] = members
        for h, _ in members:
            m2r[h] = rep
    return groups, m2r


def zone_subrect(zone, W, H):
    mw, mh = W // 2, H // 2
    return {
        "L": (0, 0, mw, H), "R": (mw, 0, W - mw, H),
        "T": (0, 0, W, mh), "B": (0, mh, W, H - mh),
        "TL": (0, 0, mw, mh), "TR": (mw, 0, W - mw, mh),
        "BL": (0, mh, mw, H - mh), "BR": (mw, mh, W - mw, H - mh),
    }.get(zone, (0, 0, W, H))


# ============================ 聚焦 / 关闭 ============================
def focus_window(hwnd):
    """把窗口提到前台。用 AttachThreadInput 抢前台，而非注入 Alt 键。"""
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        else:
            win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
    except Exception:
        pass
    cur = kernel32.GetCurrentThreadId()
    threads = set()
    try:
        fg = win32gui.GetForegroundWindow()
        if fg:
            threads.add(win32process.GetWindowThreadProcessId(fg)[0])
        threads.add(win32process.GetWindowThreadProcessId(hwnd)[0])
    except Exception:
        pass
    attached = []
    for th in threads:
        if th and th != cur:
            try:
                if user32.AttachThreadInput(cur, th, True):
                    attached.append(th)
            except Exception:
                pass
    try:
        win32gui.BringWindowToTop(hwnd)
        win32gui.SetForegroundWindow(hwnd)
        try:
            user32.SetFocus(hwnd)
        except Exception:
            pass
    except Exception:
        try:
            win32gui.BringWindowToTop(hwnd)
        except Exception:
            pass
    finally:
        for th in attached:
            try:
                user32.AttachThreadInput(cur, th, False)
            except Exception:
                pass


def close_window(hwnd):
    try:
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    except Exception:
        pass


def short(t, n=16):
    return t if len(t) <= n else t[:n - 1] + "…"
