"""engine.py —— 侧栏引擎（大脑）。

持有 dock/stage 模型、贴靠分组、虚拟桌面切换器、番茄钟、媒体、语音/PTT；
每帧产出可序列化的 State Model（dict），并把缩略图/图标/封面渲染成 PNG 存入
资源仓（由 server 通过 /asset/<key>?v=<ver> 提供，URL 带版本号让浏览器自然缓存）。

所有 Win32 副作用集中在 win/ 子包；本模块只编排数据。线程安全：模型变更都在
self.lock 下进行；Win32 调用本身可跨线程。
"""
import io
import hashlib
import json
import os
import colorsys
import time
import threading
import traceback

import win32gui

import config
import widgets.registry as _wr

from win import windows as W
from win import desktops as D
from win.ptt import insert_text
try:
    from media_control import MediaController
except Exception:
    MediaController = None

from PIL import Image


def _log(msg):
    try:
        with open("engine.log", "a", encoding="utf-8") as f:
            f.write("%s  %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


# 用户上传的自定义壁纸落地处（稳定可写）。
_USER_WP_DIR = os.path.join(os.path.expanduser("~"), "AppData", "Local", "stage-shell")
_USER_WP_FILE = os.path.join(_USER_WP_DIR, "user_wallpaper")

# 窗口缩略图最长缓存时长：避免同一 hwnd 长期停留在旧截图上。
_THUMB_STALE_S = 10.0


def _extract_wallpaper_seed(img):
    """从壁纸的主色群提取 M3 种子色。

    不能只挑最饱和的单个色块：小面积图标/花朵会把整套主题带偏。
    因此按量化色在图中的像素数加权，并偏好中等亮度、适度饱和的主色。
    """
    small = img.resize((128, 72), Image.LANCZOS).convert("RGB")
    try:
        method = getattr(getattr(Image, "Quantize", None), "MEDIANCUT", 0)
        pq = small.quantize(colors=24, method=method)
        pal = pq.getpalette()
        colors = pq.getcolors() or []
    except Exception:
        return "#4aa3ff"

    best, result = -1.0, "#4aa3ff"
    for count, i in colors:
        if i * 3 + 2 >= len(pal):
            continue
        r, g, b = pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]
        _, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        if s < 0.16 or v < 0.18 or v > 0.90:
            continue
        balance = 1.0 - abs(v - 0.58)           # 避免极暗/极亮色压过主色
        score = count * (0.25 + s) * max(0.15, balance)
        if score > best:
            best, result = score, "#%02x%02x%02x" % (r, g, b)
    return result


class Engine:
    def __init__(self):
        self.lock = threading.RLock()
        self._stop = False
        self.notify = lambda: None
        self.own_hwnd = 0
        self.host_theme = None                  # Electron 等宿主通过本地 Web API 上报 light/dark
        self.render_scale = 1.0

        # ---- 模型 ----
        self.stage = win32gui.GetForegroundWindow()   # 启动前的真实前台
        self.dock = []
        self.displayed = []
        self._prev_stage = None
        self._card_cache = {}               # hwnd -> 卡片数据字典（已生成）
        self._pending_cards = None          # SWR：切桌面时的乐观卡片覆盖；reconcile 后清空
        self._base_cache = {}               # hwnd -> PIL 最近缩略图
        self._icons = {}                    # hwnd -> PIL 图标(40px)
        self._group_members = {}            # rep -> [(hwnd, zone), ...]
        self._member_to_rep = {}
        self._group_base = {}               # rep -> (members 签名, PIL 合成图)
        # ---- 卡片夹（手动堆叠）：与贴靠组正交，仅本次会话有效 ----
        self.stacks = {}                    # sid -> [rep, ...]  MRU/顶在前（存当前 rep）
        self._stack_of = {}                 # rep -> sid
        self._stack_piles = {}              # sid -> [rep, ...]  dock 在场成员，顶在前（每帧填）
        self._next_stack_id = 1
        # ---- 顶部暂存区（peek/restore）：仅本次会话有效 ----
        self.staged = []                    # [rep, ...]  收进暂存区的窗口（从主列表移除）
        self._staged_here = []              # staged 中在当前桌面的子集（每帧填；暂存区只显示这些）
        # 暂存卡高亮 = 它是否就是当前前台(self.stage)，直接派生，不再单独存 peek 状态
        # （旧的 _peek_hwnd/_peek_saved 双份状态会和真实前台漂移失步 → 高亮错乱/随机结果，已删）
        self._appkey_cache = {}             # hwnd -> app_key(小写)；进程不变→可长缓存
        self._pin_cooldown = {}             # hwnd -> 上次自动落位时刻；防 move 抖动
        self._hwnd_roles = {}               # hwnd -> role_idx (int)；仅本次会话有效，窗口关闭即消失

        # ---- 资源仓: key -> (version, png_bytes) ----
        self._assets = {}
        self._asset_lock = threading.Lock()
        self._thumb_ver = {}                # hwnd -> 缩略图内容版本（用于组卡失效）
        self._thumb_at = {}                 # hwnd -> 最近成功抓图的 monotonic time
        self._icon_done = set()             # 已生成图标资源的 hwnd

        # ---- 桌面切换器 ----
        self._desks = []
        self._wdn_cache = {}
        self._pager_last = 0.0
        self._pager_sig = None
        self._pager_items = []              # 给 build_state 的现成列表
        self._pager_active = 0
        self._active_idx = -1               # 乐观高亮
        # ---- 壁纸（仅用户选择的文件） ----
        self._wallpaper_path = None     # 上次处理的源路径（去重用）
        self._wallpaper_mtime = 0       # 上次处理的 mtime_ns（去重用）
        self._wallpaper_size = -1       # 上次处理的文件大小（去重用）
        self._wallpaper_seed = None     # 提取的十六进制 M3 种子色
        self._wallpaper_token = None    # 本次读取内容的指纹；只用于拒绝浏览器复用旧图
        self._wp_apply_lock = threading.Lock()

        # ---- 媒体 ----
        self.media = None
        if MediaController is not None and MediaController.available():
            try:
                self.media = MediaController()
            except Exception:
                self.media = None
        self._media_info = None
        self._media_key = None
        self._media_last = 0.0

        # ---- Widget 注册表 ----
        _wr.load_all()

    # ===================================================================
    # 生命周期
    # ===================================================================
    def start(self):
        D.co_initialize()
        _wr.set_notify(self.notify)              # 交互式 widget 可请求立即推送
        _wr.set_get_open_apps(self._open_app_names)  # 供便签 widget 获取当前打开的应用名
        _wr.start_all()
        # 启动时只读取用户已选择的壁纸；不跟随 Windows 桌面壁纸。
        threading.Thread(target=self.apply_wallpaper, daemon=True, name="wallpaper").start()
        threading.Thread(target=self._tick_loop, daemon=True, name="engine-tick").start()
        threading.Thread(target=self._hotkey_loop, daemon=True, name="engine-hotkey").start()
        threading.Thread(target=self._input_loop, daemon=True, name="engine-input").start()

    def shutdown(self):
        self._stop = True
        _wr.stop_all()

    def _after(self, fn, secs):
        t = threading.Timer(secs, fn)
        t.daemon = True
        t.start()
        return t

    # ===================================================================
    # 资源仓
    # ===================================================================
    def _set_asset(self, key, img):
        """把 PIL 图编码成 PNG 存仓，版本号 +1；返回新版本号。"""
        try:
            buf = io.BytesIO()
            img.convert("RGBA").save(buf, "PNG")
            data = buf.getvalue()
        except Exception:
            return 0
        return self._set_asset_bytes(key, data)

    def _set_asset_bytes(self, key, data):
        """存预先编码好的 PNG 字节，版本号 +1；返回新版本号。
        命中缓存复用时用，免去重新编码。"""
        if not data:
            return 0
        with self._asset_lock:
            old = self._assets.get(key)
            ver = (old[0] + 1) if old else 1
            self._assets[key] = (ver, data)
        return ver

    def get_asset(self, key):
        with self._asset_lock:
            e = self._assets.get(key)
        return e[1] if e else None

    def _asset_ver(self, key):
        with self._asset_lock:
            e = self._assets.get(key)
        return e[0] if e else 0

    def _clear_asset(self, key):
        """删除资源仓中的一个条目；返回是否真的删掉了旧值。"""
        with self._asset_lock:
            return self._assets.pop(key, None) is not None

    def _thumb_is_stale(self, hwnd):
        """窗口缩略图是否已过期。"""
        at = self._thumb_at.get(hwnd, 0.0)
        return (not at) or ((time.monotonic() - at) >= _THUMB_STALE_S)

    def _store_thumb(self, hwnd, base, cache_base=True):
        """把抓到的单窗缩略图写入缓存和资源仓，尽量避免相同像素反复抬版本。"""
        if base is None:
            return 0
        key = "thumb/%d" % hwnd
        try:
            buf = io.BytesIO()
            base.convert("RGBA").save(buf, "PNG")
            data = buf.getvalue()
        except Exception:
            return 0
        with self._asset_lock:
            old = self._assets.get(key)
            if old and old[1] == data:
                ver = old[0]
                changed = False
            else:
                ver = (old[0] + 1) if old else 1
                self._assets[key] = (ver, data)
                changed = True
        if cache_base:
            self._base_cache[hwnd] = base
            self._thumb_at[hwnd] = time.monotonic()
            if changed:
                self._thumb_ver[hwnd] = self._thumb_ver.get(hwnd, 0) + 1
        return ver

    def _evict_dead_assets(self):
        """回收已关闭窗口的 thumb/<hwnd>、icon/<hwnd> PNG 资源。

        资源仓按 hwnd 建键、活窗会被同键覆盖（有界），但窗口关闭后这些 PNG 字节
        从不删除 → 进程跑越久越涨（数十~数百 MB 级泄漏）。这里按 IsWindow 全局判活，
        而非用"当前桌面窗口集"，避免误删其它虚拟桌面上仍存活窗口的图标资源。
        """
        with self._asset_lock:
            keys = [k for k in self._assets
                    if k.startswith("thumb/") or k.startswith("icon/")]
        dead = []
        for k in keys:
            try:
                h = int(k.split("/", 1)[1])
            except (ValueError, IndexError):
                continue
            try:
                alive = bool(win32gui.IsWindow(h))
            except Exception:
                alive = False
            if not alive:
                dead.append((k, h))
        if not dead:
            return
        with self._asset_lock:
            for k, _ in dead:
                self._assets.pop(k, None)
        for k, h in dead:
            if k.startswith("icon/"):
                self._icon_done.discard(h)
            elif k.startswith("thumb/"):
                self._thumb_at.pop(h, None)
                self._thumb_ver.pop(h, None)

    def _icon_for(self, hwnd):
        if hwnd not in self._icons:
            self._icons[hwnd] = W.icon_image(hwnd, 40)
        return self._icons.get(hwnd)

    def _icon_url(self, hwnd):
        """确保该窗口图标 PNG 资源存在并返回 url；无图标返回 None。"""
        key = "icon/%d" % hwnd
        if hwnd not in self._icon_done:
            ic = self._icon_for(hwnd)
            if ic is None:
                return None
            self._set_asset(key, ic)
            self._icon_done.add(hwnd)
        ver = self._asset_ver(key)
        return "/asset/%s?v=%d" % (key, ver) if ver else None

    def _thumb_url(self, hwnd):
        """该窗口缩略图 url（资源由 _build_card_assets 生成）；无则返回 None。"""
        ver = self._asset_ver("thumb/%d" % hwnd)
        return "/asset/thumb/%d?v=%d" % (hwnd, ver) if ver else None

    # ===================================================================
    # 模型：reconcile / displayed / 点击换牌
    # ===================================================================
    def _place_demoted(self, new, old, member_set):
        """把被激活的 new(及其贴靠组 member_set)移出 dock，再放置被降级的旧前台 old。
        核心原则同旧版 set_stage 的 `dock[i] = old`——原地交换，切换前后除被点卡片
        就地换内容外，其余卡片网格位置一律不动（这是"组内切换不抖动"的根本）：
          - 激活独立窗/整组(其在 dock 的槽位随之空出) → old 原地接管这个空出的槽位；
          - 激活的是夹子成员、且夹子还有别的成员在场(夹子槽位不空，不归 old) → old
            追加到 dock 末尾，绝不插在夹子后面挤动其后所有卡片；
          - new 根本不在 dock(新窗抢前台 / 外部 Alt-Tab) → 同样追加末尾，不挤现有卡。
        old 若本身是 new 同夹的成员(夹内循环)，追加末尾后由 _rebuild_displayed 折叠
        自然归队回该夹。"""
        valid_old = (old and win32gui.IsWindow(old) and old != self.own_hwnd)
        old_in_group = bool(valid_old and old in member_set)
        idx = self.dock.index(new) if new in self.dock else None
        removed_before = (sum(1 for h in self.dock[:idx] if h in member_set)
                          if idx is not None else 0)
        self.dock = [h for h in self.dock if h not in member_set]
        if not (valid_old and not old_in_group):
            return
        rep = self._member_to_rep.get(new, new)
        sid = self._stack_of.get(rep)
        stack_survives = (
            sid is not None
            and any(self._stack_of.get(self._member_to_rep.get(h, h)) == sid
                    for h in self.dock)
        )
        if not stack_survives and idx is not None:
            pos = idx - removed_before       # 槽位空出 → old 原地接管(旧版 dock[i]=old)
        else:
            pos = len(self.dock)             # 夹子仍占原槽位 / new 不在 dock → 追加末尾，不挤动在场卡
        self.dock.insert(min(pos, len(self.dock)), old)

    def _set_stage(self, new):
        old = self.stage
        self._place_demoted(new, old, {new})
        if old and old != new and old != self.own_hwnd:
            self._prev_stage = old
        self.stage = new
        self._stack_mru_bump(new)            # alt-tab/真前台变化路径也需顶 MRU

    def reconcile(self):
        wins = W.list_windows(self.own_hwnd)
        valid = {h for h, _ in wins}
        groups, m2r = W.compute_snap_groups(wins)
        self._group_members = groups
        self._member_to_rep = m2r
        # 卡片夹：贴靠组 rep 由几何决定、会随重排翻转；每帧把夹子成员归一到当前 rep，
        # 顺带剔除已关闭窗口（IsWindow 为假），成员<2 则自动解散。
        if self.stacks:
            new_stack_of = {}
            for sid, reps in list(self.stacks.items()):
                norm, seen = [], set()
                for r in reps:
                    cur = m2r.get(r, r)           # 跟随成员 → 当前 rep
                    if cur in seen or not win32gui.IsWindow(cur):
                        continue
                    seen.add(cur)
                    norm.append(cur)
                    new_stack_of[cur] = sid
                if len(norm) >= 2:
                    self.stacks[sid] = norm
                else:
                    self.stacks.pop(sid, None)
                    self._stack_piles.pop(sid, None)
            self._stack_of = new_stack_of
        self._group_base = {r: v for r, v in self._group_base.items() if r in groups}
        self.dock = [h for h in self.dock if h in valid]
        self._base_cache = {h: v for h, v in self._base_cache.items() if h in valid}
        self._thumb_at = {h: v for h, v in self._thumb_at.items() if h in valid}
        self._thumb_ver = {h: v for h, v in self._thumb_ver.items() if h in valid}
        for h in list(self._icons):
            if h not in valid:
                self._icons.pop(h, None)
                self._icon_done.discard(h)
        if self.stage not in valid:
            self.stage = None
        fg = win32gui.GetForegroundWindow()
        if fg in valid and fg != self.own_hwnd:
            target = fg
        elif W.is_desktop_window(fg):
            target = None
        elif wins:
            target = wins[0][0]
        else:
            target = None
        if target is None:
            self.stage = None
        elif target != self.stage:
            self._snapshot(self.stage)
            self._set_stage(target)
        for h, _ in wins:
            # 前台窗口由桌面预览承载；窗口卡片区只保留未处于前台的软件。
            if h != self.stage and h not in self.dock:
                self.dock.insert(0, h)
        # 暂存区维护（须在 _rebuild_displayed 前）：归一 rep、剔除已关窗口
        if self.staged:
            seen_st, norm_st = set(), []
            for r in self.staged:
                cur = m2r.get(r, r)
                if cur in seen_st or not win32gui.IsWindow(cur):
                    continue
                seen_st.add(cur)
                norm_st.append(cur)
            self.staged = norm_st
        # 暂存区只显示当前桌面的窗口（窗口只属于一个桌面 → 按 valid 过滤显示子集）
        self._staged_here = [r for r in self.staged if r in valid]
        self._rebuild_displayed()
        # 校验钉住窗口
        # 清理已关闭窗口的卡片缓存
        self._card_cache = {h: v for h, v in self._card_cache.items() if h in valid}
        # 回收已关闭窗口的缩略图/图标 PNG 资源（资源仓本身从不随窗口关闭收缩）
        self._evict_dead_assets()

    def _rebuild_displayed(self):
        # 当前前台窗口（以及与其贴靠的同组窗口）不进入窗口卡片区；它们在
        # 桌面切换器的前台预览中呈现，避免同一窗口重复出现。
        self.dock = [h for h in self.dock if h != self.stage]
        m2r = self._member_to_rep
        stage_rep = m2r.get(self.stage)
        stage_group = ({h for h, _ in self._group_members.get(stage_rep, ())}
                       if stage_rep is not None else set())
        staged_set = set(self.staged)
        seen, disp, piles = set(), [], {}
        for h in self.dock:
            if h in stage_group:
                continue
            rep = m2r.get(h, h)
            if rep in staged_set:            # 暂存窗口从主列表移除，只在顶部暂存区显示
                continue
            sid = self._stack_of.get(rep)
            if sid is not None:                 # 夹子成员 → 折叠成单个 ('stack', sid) 槽位
                p = piles.setdefault(sid, [])
                if rep not in p:
                    p.append(rep)
                key = ("stack", sid)
            else:
                key = rep
            if key in seen:
                continue
            seen.add(key)
            disp.append(key)
        # 每个夹子按 stacks[sid] 的 MRU 排序，仅保留 dock 在场成员（舞台成员已被排除）
        for sid, present in piles.items():
            pset = set(present)
            ordered = [r for r in self.stacks.get(sid, []) if r in pset]
            piles[sid] = ordered or present
        self._stack_piles = piles
        self.displayed = disp[:int(config.get("MAX_CARDS", 5))]

    def _snapshot(self, hwnd):
        if not hwnd or hwnd == self.own_hwnd or not config.get("SHOW_THUMBNAIL", True):
            return
        try:
            if not win32gui.IsWindow(hwnd) or win32gui.IsIconic(hwnd):
                return
        except Exception:
            return
        base = self._thumb_base(hwnd)
        if base is not None:
            self._store_thumb(hwnd, base)

    def _ensure_base_thumb(self, hwnd, allow_grab):
        """确保 hwnd 的单窗缩略图缓存可用。

        不处理贴靠组逻辑，供组卡合成时复用，避免 rep 递归调回组卡。
        """
        try:
            minimized = bool(win32gui.IsIconic(hwnd))
        except Exception:
            minimized = False
        cached = self._base_cache.get(hwnd)
        if cached is not None and not self._thumb_is_stale(hwnd):
            return cached
        if allow_grab and (not minimized or cached is not None):
            base = self._thumb_base(hwnd)
            if base is not None:
                self._store_thumb(hwnd, base)
                return self._base_cache.get(hwnd)
        # 抓新帧失败时，不继续沿用一张已经过期的旧截图；直接退回图标占位。
        self._store_thumb(hwnd, self._icon_card(hwnd))
        return self._base_cache.get(hwnd)

    def _tw(self):
        """缩略图渲染宽度(物理像素)：按窗口 DPI 倍率放大，避免高分屏下放大模糊。"""
        return max(160, round(280 * self.render_scale))

    def _th(self):
        return round(self._tw() * 9 / 16)

    # ---- 缩略图合成 ----
    def _thumb_base(self, hwnd):
        if not config.get("SHOW_THUMBNAIL", True):
            return None
        return W.grab_thumbnail(hwnd, self._tw(), self._th())

    def _icon_card(self, hwnd):
        cw, th = self._tw(), self._th()
        base = Image.new("RGBA", (cw, th), (28, 28, 28, 255))
        icon = self._icon_for(hwnd)
        if icon:
            big = icon.resize((56, 56), Image.LANCZOS)
            base.alpha_composite(big, ((cw - 56) // 2, (th - 56) // 2))
        return base

    def _compose_group_thumb(self, members):
        cw, th = self._tw(), self._th()
        canvas = Image.new("RGBA", (cw, th), (24, 24, 24, 255))
        show = config.get("SHOW_THUMBNAIL", True)
        for hwnd, zone in members:
            x, y, w, h = W.zone_subrect(zone, cw, th)
            if w <= 0 or h <= 0:
                continue
            piece = None
            if show:
                try:
                    self._ensure_base_thumb(hwnd, allow_grab=True)
                except Exception:
                    pass
                cached = self._base_cache.get(hwnd)
                if cached is not None:
                    piece = W.cover_fit(cached, w, h)
            if piece is not None:
                canvas.alpha_composite(piece.convert("RGBA"), (x, y))
        return canvas

    def _ensure_card_asset(self, hwnd, allow_grab):
        """确保该卡片(hwnd)的缩略图 PNG 资源是最新的。"""
        members = self._group_members.get(hwnd)
        if members:
            sig = tuple((h, zone, self._thumb_ver.get(h, 0)) for h, zone in members)
            cached = self._group_base.get(hwnd)
            if cached is None or cached[0] != sig:
                base = self._compose_group_thumb(members)
                self._group_base[hwnd] = (sig, base)
                self._store_thumb(hwnd, base, cache_base=False)
            return
        self._ensure_base_thumb(hwnd, allow_grab)

    def _build_card_assets(self):
        for entry in self.displayed:
            if isinstance(entry, tuple):        # 夹子：文件夹 2×2 最多 4 张瓦片（含正面）
                for rep in self._stack_piles.get(entry[1], ())[:4]:
                    self._ensure_card_asset(rep, allow_grab=True)
            else:
                self._ensure_card_asset(entry, allow_grab=True)
        for rep in self._staged_here:        # 暂存窗口也需缩略图（不在 displayed 里；仅当前桌面）
            self._ensure_card_asset(rep, allow_grab=True)

    # ===================================================================
    # 交互（来自 UI 桥）
    # ===================================================================
    def _activate(self, hwnd):
        """把 hwnd（含其贴靠组）提到前台，旧前台按「扑克换牌」降级回 dock。调用方须持 self.lock。"""
        members = self._group_members.get(hwnd)
        old = self.stage
        self._snapshot(old)
        if members:
            for h, _ in members:
                if h != hwnd:
                    W.focus_window(h)
            W.focus_window(hwnd)
        else:
            W.focus_window(hwnd)
        valid_old = (old and win32gui.IsWindow(old) and old != self.own_hwnd)
        member_set = {h for h, _ in members} if members else {hwnd}
        old_in_group = bool(valid_old and old in member_set)
        self._place_demoted(hwnd, old, member_set)
        if old and not old_in_group and old != self.own_hwnd:
            self._prev_stage = old
        self.stage = hwnd
        self._stack_mru_bump(hwnd)
        self._rebuild_displayed()

    def focus_card(self, hwnd):
        with self.lock:
            self._activate(hwnd)
        self.notify()

    # ---- 卡片夹（手动堆叠） ----
    def _stack_resolve(self, hwnd):
        """hwnd -> 当前显示用 rep（属于贴靠组则取组 rep）。"""
        return self._member_to_rep.get(hwnd, hwnd)

    def _stack_mru_bump(self, hwnd):
        """该 hwnd 成为舞台时：把其 rep 顶到所属夹子最前，离开后回夹即在顶部。"""
        rep = self._member_to_rep.get(hwnd, hwnd)
        sid = self._stack_of.get(rep)
        if sid is None:
            return
        lst = self.stacks.get(sid)
        if lst and rep in lst and lst[0] != rep:
            lst.remove(rep)
            lst.insert(0, rep)

    def stack_cards(self, a_hwnd, b_hwnd):
        """把卡片 a 拖到卡片 b 上：合并成一个夹子（b 为落点→顶部/正面）。"""
        with self.lock:
            a = self._stack_resolve(int(a_hwnd))
            b = self._stack_resolve(int(b_hwnd))
            if a == b:
                return
            if a in self.staged:                 # 从暂存区拖出来叠夹 → 取消暂存
                self.staged.remove(a)
            sa = self._stack_of.get(a)
            sb = self._stack_of.get(b)
            if sa is None and sb is None:
                sid = self._next_stack_id
                self._next_stack_id += 1
                self.stacks[sid] = [b, a]
                self._stack_of[a] = sid
                self._stack_of[b] = sid
            elif sa is not None and sb is None:
                self.stacks[sa].insert(0, b)
                self._stack_of[b] = sa
            elif sa is None and sb is not None:
                self.stacks[sb].insert(0, a)
                self._stack_of[a] = sb
            # 两端都已在夹子里 → 「组叠到组」：忽略，不合并（避免夹子互吞）
            self._rebuild_displayed()
        self.notify()

    def unstack(self, hwnd):
        """右键「取消堆叠」：解散 hwnd 所属的整个夹子。"""
        with self.lock:
            rep = self._stack_resolve(int(hwnd))
            sid = self._stack_of.get(rep)
            if sid is not None:
                for r in self.stacks.pop(sid, []):
                    self._stack_of.pop(r, None)
                self._stack_piles.pop(sid, None)
                self._rebuild_displayed()
        self.notify()

    def insert_card(self, src, target, before):
        """把 src 卡插到 target 卡的前/后（手动排序）。src 若在暂存区则先取消暂存。
        靠重排 self.dock 实现（displayed 跟随 dock 顺序）；属 nudge —— 焦点切换/开关窗/切桌面会自然重排。"""
        with self.lock:
            s = self._stack_resolve(int(src))
            t = self._stack_resolve(int(target))
            if s == t:
                return
            if s in self.staged:                 # 从暂存区自然拖回列表 → 取消暂存
                self.staged.remove(s)
            if s in self.dock:
                self.dock.remove(s)
            if t in self.dock:
                idx = self.dock.index(t) + (0 if before else 1)
                self.dock.insert(idx, s)
            else:
                self.dock.insert(0, s)
            self._rebuild_displayed()
        self.notify()

    # ---- 顶部暂存区（点击聚焦/高亮，高亮派生自 self.stage） ----
    def stage_window(self, hwnd):
        """把一个窗口卡收进顶部暂存区：从主列表移除，仅在暂存区显示。"""
        with self.lock:
            rep = self._stack_resolve(int(hwnd))
            if rep and rep != self.stage and rep not in self.staged:
                self.staged.append(rep)
                self._rebuild_displayed()
        self.notify()

    def unstage_window(self, hwnd):
        """把暂存窗口移出暂存区，回到主列表。"""
        with self.lock:
            rep = self._stack_resolve(int(hwnd))
            if rep in self.staged:
                self.staged.remove(rep)
                self._rebuild_displayed()
        self.notify()

    def peek_staged(self, hwnd):
        """点击暂存卡：聚焦该窗口（暂存卡始终留在暂存区不变，高亮 = 它就是当前前台）。
        若它已经是当前前台 → 什么都不做（不再有「再点恢复先前布局」的切换）。
        目标窗口在别的虚拟桌面时自动切过去（复用 _goto_window）。"""
        with self.lock:
            rep = self._stack_resolve(int(hwnd))
            if rep not in self.staged:
                return
            if rep == self.stage:                    # 已聚焦该暂存窗口 → 什么也不发生
                return
        if rep and win32gui.IsWindow(rep):
            self._goto_window(rep)                   # 跨桌面自动切换 + 聚焦；降级换牌由 reconcile 完成
        self._after(self._post_switch, 0.25)         # 尽快校正主列表与高亮

    def close_window(self, hwnd):
        W.close_window(hwnd)
        self._after(self._post_switch, 0.2)

    def move_to_desktop(self, hwnd, desk_number):
        with self.lock:                              # 从暂存区拖到桌面格 → 取消暂存
            rep = self._stack_resolve(int(hwnd))
            if rep in self.staged:
                self.staged.remove(rep)
        for d in self._desks:
            try:
                if d.number == desk_number:
                    D.move_window_to_desktop(hwnd, d)
                    break
            except Exception:
                pass
        self._wdn_cache.pop(hwnd, None)
        self._after(self._post_switch, 0.15)

    def desktops_for_menu(self):
        """供右键"移到桌面"子菜单：[{number, name}]。"""
        info = D.pyvda_desktop_info()
        if info is None:
            return []
        desks, active, names, cur = info
        return [{"number": d.number, "name": names[i]} for i, d in enumerate(desks)]

    def pin_app_here(self, hwnd):
        """把该窗口所属应用钉到当前桌面（右键"钉在此桌面"）。"""
        info = D.pyvda_desktop_info()
        if info is None:
            return
        self.pin_app_to_desktop(hwnd, info[3])      # info[3] = 当前桌面号

    def pin_app_to_desktop(self, hwnd, number):
        """写一条按应用(app_key)匹配的规则到 DESKTOP_RULES 并立即落位。同 app 旧规则先去重。"""
        ak = self._app_key(hwnd)
        if not ak:
            return
        rules = [r for r in config.get("DESKTOP_RULES", [])
                 if (r.get("app") or "").lower() != ak]
        rules.append({"app": ak, "desktop": int(number)})
        config.save({"DESKTOP_RULES": rules})
        self._pin_cooldown.pop(hwnd, None)          # 允许立即移动
        self.move_to_desktop(hwnd, int(number))

    def unpin_app(self, hwnd):
        """移除该应用的钉桌面规则（按 app_key 匹配；不影响旧的 title/cls 规则）。"""
        ak = self._app_key(hwnd)
        if not ak:
            return
        rules = [r for r in config.get("DESKTOP_RULES", [])
                 if (r.get("app") or "").lower() != ak]
        config.save({"DESKTOP_RULES": rules})
        self.notify()

    # ---- 媒体控制 ----
    def media_play_pause(self):
        if self.media:
            self.media.play_pause()
            self._media_last = 0.0
            self._after(self._poll_media, 0.15)

    def media_next(self):
        if self.media:
            self.media.next_track()
            self._media_last = 0.0

    def media_prev(self):
        if self.media:
            self.media.prev_track()
            self._media_last = 0.0

    def focus_media_app(self):
        """切换到当前正在播放媒体的应用窗口。"""
        if self.media is None:
            _log("focus_media_app: no media controller")
            return
        source = self.media.get_source()
        _log("focus_media_app: source=%r" % source)
        if not source:
            return
        # 从 AUMID 提取 exe 名称
        # Win32 形式: "Spotify.exe"
        # UWP 形式:  "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"
        exe_lower = source.lower()
        if not exe_lower.endswith('.exe'):
            if '!' in exe_lower:
                exe_lower = exe_lower.split('!')[-1] + '.exe'
            else:
                # 取第一段作为 exe 名：如 "Chrome._crx_..." → "chrome"
                exe_lower = exe_lower.split('.')[0] + '.exe'
        _log("focus_media_app: exe=%r" % exe_lower)

        best = None
        try:
            import win32process, psutil
            def _cb(hwnd, _):
                nonlocal best
                if best:
                    return True
                if not win32gui.IsWindowVisible(hwnd):
                    return True
                if not win32gui.GetWindowText(hwnd):
                    return True
                try:
                    _, pid = win32process.GetWindowThreadProcessId(hwnd)
                    name = psutil.Process(pid).name().lower()
                    if name == exe_lower:
                        best = hwnd
                except Exception:
                    pass
                return True
            win32gui.EnumWindows(_cb, None)
        except Exception as e:
            _log("focus_media_app: enum error %r" % e)
        _log("focus_media_app: best hwnd=%r" % best)
        if best:
            W.focus_window(best)

    # ===================================================================
    # 虚拟桌面切换
    # ===================================================================
    def _current_idx(self):
        if not self._desks or D.VirtualDesktop is None:
            return None
        try:
            cur = D.VirtualDesktop.current().number
        except Exception:
            return None
        for i, d in enumerate(self._desks):
            try:
                if d.number == cur:
                    return i
            except Exception:
                pass
        return None

    def _paint_active(self, idx):
        if idx is None or idx == self._active_idx:
            return
        self._active_idx = idx
        self.notify()

    def switch_desktop(self, idx):
        with self.lock:
            self._pending_cards = self._optimistic_cards(idx)   # SWR：先备好乐观卡片
        self._paint_active(idx)        # 高亮 + 乐观卡片同帧推送（build_state 读 _pending_cards）
        self.notify()
        prev = frozenset(h for h, _ in W.list_windows(self.own_hwnd))
        desks = self._desks
        ok = False
        if desks and 0 <= idx < len(desks):
            try:
                desks[idx].go()
                ok = True
            except Exception:
                ok = False
        if not ok:        # pyvda 不可用或 .go() 失败 → 退回模拟 Win+Ctrl+方向键
            try:
                _, active, _ = D.get_virtual_desktops()
                D.switch_virtual_desktop(idx, active)
            except Exception:
                pass
        # 自适应等待切换落地后立刻刷新卡片，取代固定 0.36s 延迟
        self._settle_switch(idx, prev)

    def _settle_switch(self, target_idx, prev, waited=0.0):
        """轮询等待桌面切换真正落地：一旦 OS 已切到目标桌面、且窗口枚举反映了
        新桌面（旧桌面窗口被 cloak、新桌面窗口出现），就立刻刷新卡片，而不是死等
        固定延迟。STEP 为轮询步进，CAP 为兜底上限（≈旧的 0.36s，保证不退化）。"""
        STEP, CAP = 0.03, 0.36
        try:
            cur = self._current_idx()
            now = frozenset(h for h, _ in W.list_windows(self.own_hwnd))
            settled = (cur == target_idx and now != prev)
        except Exception:
            settled = True  # 查询出错就别卡着，直接刷新
        if settled or waited >= CAP:
            self._post_switch()
        else:
            self._after(lambda: self._settle_switch(target_idx, prev, waited + STEP),
                        STEP)

    def _optimistic_cards(self, idx):
        """SWR：用已缓存的 _pager_items[idx] 即时构建目标桌面的乐观卡片。
        apps[] 已排除前台、按 app 去重；图标恒有缓存、标题即时取，缩略图有缓存就用、
        没有先 None（前端按 thumb=null 显示图标占位），稍后 _post_switch 校正补全。
        夹子（stack）信息从 _stack_of/stacks 直接带入，避免切桌面时夹子短暂解散闪烁。"""
        items = self._pager_items
        if not (0 <= idx < len(items)):
            return []
        limit = int(config.get("MAX_CARDS", 5))
        cards = []
        seen_stacks = set()
        staged_set = set(self.staged)        # 暂存窗口只在 shelf 显示，乐观卡也须排除（与 _rebuild_displayed 一致，免切桌面时主列表/shelf 双现）
        # apps[] 是 Z 序（前台往下）；真实 displayed 由 dock 的 insert(0) 构建成反 Z 序，
        # 故这里反转以对齐，避免校正时整列表翻转闪烁。先反转再截断，子集也一致。
        for a in reversed(items[idx].get("apps", [])):
            hwnd = a.get("hwnd")
            if not hwnd:
                continue
            # 查询此 hwnd 是否属于某个夹子
            rep = self._member_to_rep.get(hwnd, hwnd)
            if rep in staged_set or hwnd in staged_set:
                continue
            sid = self._stack_of.get(rep)
            if sid is None:
                sid = self._stack_of.get(hwnd)
            if sid is not None:
                if sid in seen_stacks:
                    continue        # 已为该夹子输出过正面卡片，跳过其余成员
                seen_stacks.add(sid)
                pile = self.stacks.get(sid, [])
                top_rep = pile[0] if pile else rep
                try:
                    title = win32gui.GetWindowText(top_rep) or ""
                except Exception:
                    title = ""
                ver = self._asset_ver("thumb/%d" % top_rep)
                cards.append({
                    "hwnd": int(top_rep),
                    "title": title,
                    "thumb": "/asset/thumb/%d?v=%d" % (top_rep, ver) if ver else None,
                    "icon": self._icon_url(top_rep),
                    "group": False,
                    "groupCount": 0,
                    "visible": True,
                    "stackId": sid,
                    "stack": {
                        "count": len(pile),
                        "tiles": [
                            {"hwnd": int(r), "thumb": self._thumb_url(r), "icon": self._icon_url(r)}
                            for r in pile[:4]
                        ],
                    },
                })
            else:
                try:
                    title = win32gui.GetWindowText(hwnd) or ""
                except Exception:
                    title = ""
                ver = self._asset_ver("thumb/%d" % hwnd)
                cards.append({
                    "hwnd": int(hwnd),
                    "title": title,
                    "thumb": "/asset/thumb/%d?v=%d" % (hwnd, ver) if ver else None,
                    "icon": a.get("icon"),
                    "group": False,
                    "groupCount": 0,
                    "visible": True,
                })
            if len(cards) >= limit:
                break
        return cards

    def open_app(self, idx, hwnd):
        with self.lock:
            self._pending_cards = self._optimistic_cards(idx)   # SWR 乐观卡片
        self._paint_active(idx)
        self.notify()

        def _do_focus():
            rep = self._member_to_rep.get(hwnd, hwnd)
            members = self._group_members.get(rep)
            if members:
                for h, _ in members:
                    if h != rep:
                        W.focus_window(h)
                W.focus_window(rep)
            else:
                W.focus_window(hwnd)

        if self._desks and 0 <= idx < len(self._desks):
            try:
                self._desks[idx].go()
            except Exception:
                pass
            self._after(_do_focus, 0.16)
        else:
            self._after(_do_focus, 0.06)
        self._after(self._post_switch, 0.44)

    def _goto_window(self, hwnd):
        def _do_focus():
            W.focus_window(hwnd)
        dn = self._win_desktop_number(hwnd)
        idx = None
        if dn is not None and self._desks:
            for i, d in enumerate(self._desks):
                try:
                    if d.number == dn:
                        idx = i
                        break
                except Exception:
                    pass
        if idx is not None and idx != self._current_idx():
            with self.lock:
                self._pending_cards = self._optimistic_cards(idx)   # SWR 乐观卡片
            self._paint_active(idx)
            self.notify()
            try:
                self._desks[idx].go()
            except Exception:
                pass
            self._after(_do_focus, 0.16)
            self._after(self._post_switch, 0.44)
        else:
            _do_focus()

    def _post_switch(self):
        idx = self._current_idx()
        if idx is not None:
            self._active_idx = idx
        with self.lock:
            self.reconcile()
            self._build_card_assets()
            self._pending_cards = None     # 校正：恢复用真实 displayed
        self.refresh_pager(force=True)
        self.notify()

    def _win_desktop_number(self, hwnd, ttl=6.0):
        ent = self._wdn_cache.get(hwnd)
        now = time.time()
        if ent is not None and now - ent[1] < ttl:
            return ent[0]
        dn = D.window_desktop_number(hwnd)
        if dn is not None:
            self._wdn_cache[hwnd] = (dn, now)
        return dn

    def _open_app_names(self):
        """返回当前 dock 中所有应用的去重名称列表，供 widget 构建 ASR 上下文。
        只读 _appkey_cache（compute=False）保证在非 COM 线程安全调用。"""
        seen, names = set(), []
        for hwnd in list(self.dock):
            ak = self._app_key(hwnd, compute=False)
            if ak and ak not in seen:
                seen.add(ak)
                names.append(ak.replace(".exe", ""))
        return names

    def _app_key(self, hwnd, compute=True):
        """缓存版 app_key：进程名(或 PWA 的 AUMID)，小写。进程不变→可长缓存。
        compute=False 时只读缓存、不触发 W.app_key(它对浏览器窗口会走 COM)，供未
        CoInitialize 的推送线程(build_state)安全调用，避免把 app_key 误缓存成空串。"""
        ak = self._appkey_cache.get(hwnd)
        if ak is None:
            if not compute:
                return ""
            try:
                ak = (W.app_key(hwnd) or "").lower()
            except Exception:
                ak = ""
            self._appkey_cache[hwnd] = ak
        return ak

    def _role_for(self, hwnd, compute=False):
        """返回窗口角色索引（int）；无则返回 None。
        角色按 hwnd 存储，仅本次会话有效。compute 参数保留供兼容。"""
        return self._hwnd_roles.get(int(hwnd))

    def set_role(self, hwnd: int, role_idx):
        """为该窗口实例设置或清除角色索引；仅本次会话有效，窗口关闭标记消失。"""
        hwnd = int(hwnd)
        if role_idx is not None:
            try:
                self._hwnd_roles[hwnd] = int(role_idx)
            except (TypeError, ValueError):
                self._hwnd_roles.pop(hwnd, None)
        else:
            self._hwnd_roles.pop(hwnd, None)
        self._dirty.set()

    def _rule_target_for(self, hwnd, allow_compute=True):
        """按 DESKTOP_RULES 求窗口"应在"的桌面号；无匹配返回 None。
        字段 app(按应用) / title / cls(子串，兼容旧规则)，三者同时给出为 AND。
        allow_compute=False 时不为算 app_key 触发 COM(供 build_state)。"""
        rules = config.get("DESKTOP_RULES", [])
        if D.AppView is None or not rules:
            return None
        ak = None
        title = cls = None
        for rule in rules:
            app = (rule.get("app") or "").lower()
            t = (rule.get("title") or "").lower()
            c = rule.get("cls") or ""
            if not app and not t and not c:
                continue
            if app:
                if ak is None:
                    ak = self._app_key(hwnd, compute=allow_compute)
                if ak != app:
                    continue
            if t or c:
                if title is None:
                    try:
                        title = win32gui.GetWindowText(hwnd).lower()
                        cls = win32gui.GetClassName(hwnd)
                    except Exception:
                        title, cls = "", ""
                if t and t not in title:
                    continue
                if c and c not in cls:
                    continue
            try:
                return int(rule.get("desktop", 1))
            except Exception:
                return None
        return None

    def _maybe_move(self, hwnd, number, desks):
        """带防抖把窗口移到 number 桌面；真正发起移动返回 True。"""
        if not (1 <= number <= len(desks)):
            return False
        now = time.time()
        if now - self._pin_cooldown.get(hwnd, 0.0) < 1.0:
            return False
        self._pin_cooldown[hwnd] = now
        try:
            if D.move_window_to_desktop(hwnd, desks[number - 1]):
                self._wdn_cache.pop(hwnd, None)
                return True
        except Exception:
            pass
        return False

    def _apply_desktop_rules(self, hwnd, dnum, desks):
        """供 refresh_pager：返回窗口"应在"的桌面号(命中规则则为目标)，并顺带落位。"""
        tgt = self._rule_target_for(hwnd)
        if tgt is None or not (1 <= tgt <= len(desks)):
            return dnum
        if tgt != dnum:
            self._maybe_move(hwnd, tgt, desks)
        return tgt

    def _enforce_pins(self):
        """每 tick：把"出现在非目标桌面"的被钉应用搬回目标。
        只扫当前桌面窗口(list_windows)——应用总在当前活动桌面建窗，故启动落位必被这里捕获；
        手动拖到别桌的情况由 refresh_pager 的全桌面扫描兜底。"""
        if not config.get("DESKTOP_RULES") or D.AppView is None:
            return
        desks = self._desks
        if not desks:
            return
        try:
            wins = W.list_windows(self.own_hwnd)
        except Exception:
            return
        moved = False
        for h, _ in wins:
            tgt = self._rule_target_for(h)
            if tgt is None or not (1 <= tgt <= len(desks)):
                continue
            dn = self._win_desktop_number(h)
            if dn is None or dn == tgt:
                continue
            if self._maybe_move(h, tgt, desks):
                moved = True
        if moved:
            self._after(self._post_switch, 0.15)

    def refresh_pager(self, force=False):
        now = time.time()
        if not force and self._pager_items and now - self._pager_last < 1.8:
            return
        self._pager_last = now

        info = D.pyvda_desktop_info()
        per = {}
        if info is not None:
            desks, active, names, cur_num = info
            self._desks = desks
            count = len(desks)
            desk_nums = [d.number for d in desks]
            num_to_idx = {d.number: i for i, d in enumerate(desks)}
            live = []
            for h, _ in W.list_all_windows(self.own_hwnd):
                live.append(h)
                dn = self._win_desktop_number(h)
                if dn is None:
                    continue
                dn = self._apply_desktop_rules(h, dn, desks)
                idx = num_to_idx.get(dn)
                if idx is None:
                    continue
                lst = per.setdefault(idx, [])
                e = self._app_key(h)  # 走缓存路径：填充 _appkey_cache，供 _ptt_context 无 COM 读取
                if not e:
                    continue
                if h == self.stage:
                    for pos, (ke, kh) in enumerate(lst):
                        if ke == e:
                            lst.pop(pos)
                            break
                    lst.insert(0, (e, h))
                elif e not in [x[0] for x in lst]:
                    lst.append((e, h))
            liveset = set(live)
            if self._wdn_cache:
                self._wdn_cache = {k: v for k, v in self._wdn_cache.items()
                                   if k in liveset}
            if self._appkey_cache:
                self._appkey_cache = {k: v for k, v in self._appkey_cache.items()
                                      if k in liveset}
            if self._pin_cooldown:
                self._pin_cooldown = {k: v for k, v in self._pin_cooldown.items()
                                      if k in liveset}
            cur_idx = num_to_idx.get(cur_num, active)
        else:
            self._desks = []
            try:
                guids, active, names = D.get_virtual_desktops()
            except Exception:
                guids, active, names = [b""], 0, ["桌面 1"]
            count = len(guids)
            desk_nums = list(range(count))
            cur_idx = active
            lst = per.setdefault(active, [])
            for h, _ in W.list_windows(self.own_hwnd):
                e = self._app_key(h)
                if not e:
                    continue
                if h == self.stage:
                    for pos, (ke, kh) in enumerate(lst):
                        if ke == e:
                            lst.pop(pos)
                            break
                    lst.insert(0, (e, h))
                elif e not in [x[0] for x in lst]:
                    lst.append((e, h))

        shown = min(count, int(config.get("PAGER_MAX", 4)))
        cur_stage = self.stage if (self.stage and win32gui.IsWindow(self.stage)) else 0
        rows = []
        for i in range(shown):
            apps = per.get(i, [])
            # 当前桌面优先用真实前台窗口 stage；其他桌面用各自列表里最靠前的窗口。
            fg_hwnd = apps[0][1] if apps else 0
            if i == cur_idx and cur_stage:
                fg_hwnd = cur_stage
            thumb_hwnd = self._member_to_rep.get(fg_hwnd, fg_hwnd) if fg_hwnd else 0
            thumb_ver = 0
            thumb_url = None
            if thumb_hwnd:
                self._ensure_card_asset(thumb_hwnd, allow_grab=True)
                thumb_ver = self._asset_ver("thumb/%d" % thumb_hwnd)
                thumb_url = self._thumb_url(thumb_hwnd)
            rows.append((i, fg_hwnd, thumb_hwnd, thumb_ver, thumb_url, apps))

        sig = (cur_idx, tuple((str(names[i]) if i < len(names) else "",
                               int(desk_nums[i]), fg_hwnd, thumb_hwnd,
                               thumb_ver, tuple((e, h) for e, h in apps))
                              for i, fg_hwnd, thumb_hwnd, thumb_ver, _thumb_url, apps in rows))
        dirty = sig != self._pager_sig

        if dirty:
            self._pager_sig = sig
            items = []
            for i, fg_hwnd, thumb_hwnd, thumb_ver, thumb_url, apps in rows:
                fg_icon = self._icon_url(fg_hwnd) if fg_hwnd else None
                app_list = []
                for e_key, h in apps:
                    if h == fg_hwnd:
                        continue
                    url = self._icon_url(h)
                    if url:
                        app_list.append({
                            "hwnd": int(h),
                            "icon": url,
                            "role": self._hwnd_roles.get(int(h)),
                        })
                items.append({
                    "idx": i,
                    "number": int(desk_nums[i]),   # pyvda 桌面号，供拖拽落点 moveToDesktop
                    "label": str(i + 1),
                    "name": names[i] if i < len(names) else "桌面 %d" % (i + 1),
                    "thumb": thumb_url,
                    "fgHwnd": int(fg_hwnd) if fg_hwnd else None,
                    "fgIcon": fg_icon,
                    "fgRole": self._hwnd_roles.get(int(fg_hwnd)) if fg_hwnd else None,
                    "apps": app_list,
                })
            self._pager_items = items
        self._pager_active = cur_idx
        if self._active_idx < 0:
            self._active_idx = cur_idx

    # ===================================================================
    # 壁纸取色（M3 You）
    # ===================================================================
    def apply_wallpaper(self, force=False):
        """只读取用户在设置页选择的壁纸，取 M3 种子色并生成侧栏背景图。
        路径为空、失效或无法读取时清除资源，前端显示纯黑背景。"""
        if not config.get("WALLPAPER_ENABLED", True):
            cleared = self._clear_asset("wallpaper")
            if cleared or self._wallpaper_path is not None or self._wallpaper_seed is not None:
                self._wallpaper_path = None
                self._wallpaper_mtime = 0
                self._wallpaper_size = -1
                self._wallpaper_seed = None
                self._wallpaper_token = None
                self.notify()
            return None
        custom = str(config.get("WALLPAPER_PATH", "") or "").strip()
        path = custom if (custom and os.path.isfile(custom)) else ""
        if not path or not os.path.isfile(path):
            cleared = self._clear_asset("wallpaper")
            if cleared or self._wallpaper_path is not None or self._wallpaper_seed is not None:
                self._wallpaper_path = None
                self._wallpaper_mtime = 0
                self._wallpaper_size = -1
                self._wallpaper_seed = None
                self._wallpaper_token = None
                self.notify()
            return None
        try:
            st = os.stat(path)
            mtime = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000)))
            size = int(st.st_size)
        except Exception:
            mtime = 0
            size = -1
        with self._wp_apply_lock:
            if (not force and path == self._wallpaper_path
                    and mtime == self._wallpaper_mtime
                    and size == self._wallpaper_size):
                return self._wallpaper_seed     # 同一张、非强制 → 免重做
            try:
                with Image.open(path) as img:
                    seed = _extract_wallpaper_seed(img)
                    # 缩放到长边 ≤800px（够侧栏显示，不传大图）
                    w, h = img.size
                    scale = min(1.0, 800 / max(w, h, 1))
                    tw, th = max(1, round(w * scale)), max(1, round(h * scale))
                    img_small = img.resize((tw, th), Image.LANCZOS).convert("RGBA")
                buf = io.BytesIO()
                img_small.save(buf, "PNG")
                image_bytes = buf.getvalue()
                self._set_asset_bytes("wallpaper", image_bytes)
                self._wallpaper_path = path
                self._wallpaper_mtime = mtime
                self._wallpaper_size = size
                self._wallpaper_seed = seed
                self._wallpaper_token = hashlib.sha256(image_bytes).hexdigest()[:16]
                self.notify()
                _log("wallpaper seed=%s size=%dx%d from %s%s"
                     % (seed, tw, th, path, " (custom)" if custom else ""))
                return seed
            except Exception:
                _log("wallpaper error\n" + traceback.format_exc())
                return None

    def save_user_wallpaper(self, raw):
        """保存设置页上传的壁纸字节到固定文件，写入 config WALLPAPER_PATH，立刻重取色。
        返回 (ok, seed)。"""
        try:
            Image.open(io.BytesIO(raw)).verify()    # 校验确为合法图片
        except Exception:
            return False, None
        try:
            os.makedirs(_USER_WP_DIR, exist_ok=True)
            with open(_USER_WP_FILE, "wb") as f:
                f.write(raw)
        except Exception:
            _log("save_user_wallpaper write error\n" + traceback.format_exc())
            return False, None
        config.save({"WALLPAPER_PATH": _USER_WP_FILE})
        return True, self.apply_wallpaper(force=True)

    def clear_user_wallpaper(self):
        """清除用户壁纸并回到纯黑背景。返回 (ok, seed)。"""
        config.save({"WALLPAPER_PATH": ""})
        return True, self.apply_wallpaper(force=True)

    # ===================================================================
    # 媒体轮询
    # ===================================================================
    def _poll_media(self):
        if self.media is None:
            return
        now = time.time()
        if now - self._media_last < 1.8:
            return
        self._media_last = now
        try:
            info = self.media.get_info()
        except Exception:
            info = None
        self._media_info = info
        if info is None:
            self._media_key = None
            return
        key = (info.get("title", ""), info.get("artist", ""))
        if key != self._media_key and info.get("thumbnail") is not None:
            self._media_key = key
            try:
                self._set_asset("cover", info["thumbnail"])
            except Exception:
                pass

    def capture_input_target(self):
        """Freeze the real target before Electron starts showing voice UI."""
        try:
            hwnd = int(win32gui.GetForegroundWindow() or 0)
            return hwnd if hwnd and hwnd != self.own_hwnd else 0
        except Exception:
            return 0

    def insert_external_text(self, text, target_hwnd=0):
        """供 Electron/远端语音核心调用的最小文字注入边界。

        Python 不再采集或识别音频；它只复用既有 SendInput/剪贴板回退逻辑把
        已识别文字写入当前目标窗口。
        """
        text = str(text or "")
        if not text:
            return False
        try:
            target = int(target_hwnd or 0)
            if target and win32gui.IsWindow(target):
                W.focus_window(target)
        except Exception:
            pass
        insert_text(text, restore_clip=config.get("INSERT_RESTORE_CLIP", True))
        return True

    # ===================================================================
    # 线程循环
    # ===================================================================
    def _tick_loop(self):
        D.co_initialize()
        while not self._stop:
            t0 = time.time()
            try:
                with self.lock:
                    self.reconcile()
                    self._build_card_assets()
                self.refresh_pager()
                self._enforce_pins()
                self._poll_media()
                self.notify()
            except Exception:
                _log("tick error\n" + traceback.format_exc())
            dt = time.time() - t0
            time.sleep(max(0.05, config.get("REFRESH_MS", 700) / 1000.0 - dt))

    def _hotkey_loop(self):
        """Alt+HJKL 2D 桌面移动（触摸板手势绑定用）。

        全局热键同一时刻只能被一个进程注册。托盘"重启"/重复启动会让新实例在旧实例
        尚未退出（仍占着热键）时启动；若一次注册失败就放弃，旧实例退出释放热键后便
        再没人接管 → Alt+HJKL 整体失效。这里重试注册直到抢全四个键，避免该回归。
        """
        import ctypes
        from ctypes import wintypes
        from win.winver import user32
        D.co_initialize()
        MOD_ALT, MOD_NOREPEAT, WM_HOTKEY = 0x0001, 0x4000, 0x0312
        specs = ((21, 0x48), (22, 0x4A), (23, 0x4B), (24, 0x4C))   # H J K L
        registered = []
        for _ in range(40):              # 最多重试 ~20s，覆盖旧实例关闭释放热键的窗口期
            for hk_id, vk in specs:
                if hk_id not in registered and user32.RegisterHotKey(
                        None, hk_id, MOD_ALT | MOD_NOREPEAT, vk):
                    registered.append(hk_id)
            if len(registered) == len(specs) or self._stop:
                break
            time.sleep(0.5)
        if not registered:
            _log("desktop hotkeys unavailable: Alt+HJKL registration failed")
            return
        if len(registered) != len(specs):
            _log("desktop hotkeys partial registration: %r" % registered)
        else:
            _log("desktop hotkeys ready: Alt+HJKL")
        _hjkl = {21: (-1, 0), 22: (0, 1), 23: (0, -1), 24: (1, 0)}
        msg = wintypes.MSG()
        try:
            while not self._stop and user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                if msg.message == WM_HOTKEY:
                    hid = int(msg.wParam)
                    try:
                        if hid in _hjkl:
                            dr, dc = _hjkl[hid][1], _hjkl[hid][0]
                            self._move_desktop_2d(dr, dc)
                    except Exception:
                        _log("hotkey %d error\n%s" % (hid, traceback.format_exc()))
        except Exception:
            pass
        finally:
            for hk_id in registered:
                user32.UnregisterHotKey(None, hk_id)

    def _move_desktop_2d(self, dr, dc):
        cur = self._current_idx()
        if cur is None:
            try:
                _, cur, _ = D.get_virtual_desktops()
            except Exception:
                return
        n = len(self._desks) if self._desks else 0
        if n == 0:
            try:
                n = len(D.get_virtual_desktops()[0])
            except Exception:
                return
        if n <= 1:
            return
        cols = 2
        rows = (n + cols - 1) // cols
        row, col = cur // cols, cur % cols
        new_idx = ((row + dr) % rows) * cols + ((col + dc) % cols)
        if new_idx != cur and new_idx < n:
            self.switch_desktop(new_idx)

    def move_desktop_2d(self, dr, dc):
        """Host-owned global shortcuts request relative desktop movement."""
        self._move_desktop_2d(int(dr), int(dc))
        return True

    # ===================================================================
    # State Model
    # ===================================================================
    def _update_card(self, hwnd):
        """更新卡片数据（标题、缩略图版本等）."""
        card = self._card_cache[hwnd]
        members = self._group_members.get(hwnd)
        ver = self._asset_ver("thumb/%d" % hwnd)
        title = win32gui.GetWindowText(hwnd) or ""
        card["hwnd"] = int(hwnd)
        card["title"] = title
        card["thumb"] = "/asset/thumb/%d?v=%d" % (hwnd, ver) if ver else None
        card["icon"] = self._icon_url(hwnd)
        card["group"] = bool(members)
        card["groupCount"] = (len(members) - 1) if members else 0
        card["pinnedDesktop"] = self._rule_target_for(hwnd, allow_compute=False)
        card["role"] = self._role_for(hwnd, compute=False)

    def build_state(self):
        with self.lock:
            # SWR：切桌面期间用乐观卡片覆盖，_post_switch 校正后会清空
            if self._pending_cards is not None:
                cards = list(self._pending_cards)
            else:
                # displayed 可能含 ('stack', sid) 元组：先解析每个槽位的正面 rep
                slots = []                       # [(entry, front_rep 或 None)]
                for entry in self.displayed:
                    if isinstance(entry, tuple):
                        pile = self._stack_piles.get(entry[1], [])
                        slots.append((entry, pile[0] if pile else None))
                    else:
                        slots.append((entry, entry))

                # 更新需展示卡片的缓存（仅 hwnd 正面；空夹子跳过）
                for _, front in slots:
                    if front is None:
                        continue
                    if front not in self._card_cache:
                        self._card_cache[front] = {}
                    self._update_card(front)

                # 卡片列表：严格按 displayed 槽位顺序。夹子发"正面卡 + stack 元信息"，
                # 正面卡的 hwnd 即点击切换目标（focusCard 无需改动）。
                cards = []
                for entry, front in slots:
                    if front is None:
                        continue
                    card = dict(self._card_cache.get(front, {}))
                    card["visible"] = True
                    if isinstance(entry, tuple):
                        pile = self._stack_piles.get(entry[1], [])
                        card["stackId"] = entry[1]
                        card["stack"] = {
                            "count": len(pile),
                            "tiles": [
                                {"hwnd": int(r), "thumb": self._thumb_url(r), "icon": self._icon_url(r)}
                                for r in pile[:4]
                            ],
                        }
                    cards.append(card)
            staged_list = []
            for r in self._staged_here:
                if not win32gui.IsWindow(r):
                    continue
                try:
                    st_title = win32gui.GetWindowText(r) or ""
                except Exception:
                    st_title = ""
                staged_list.append({
                    "hwnd": int(r),
                    "title": st_title,
                    "thumb": self._thumb_url(r),
                    "icon": self._icon_url(r),
                    "peeked": (r == self.stage),
                    "role": self._hwnd_roles.get(int(r)),
                })
            desktops = {
                "active": self._active_idx if self._active_idx >= 0 else self._pager_active,
                "cols": 2,
                "items": list(self._pager_items),
            }

        media = {"active": False, "title": "", "artist": "",
                 "isPlaying": False, "cover": None}
        if self._media_info is not None:
            ver = self._asset_ver("cover")
            media = {
                "active": True,
                "title": self._media_info.get("title", ""),
                "artist": self._media_info.get("artist", ""),
                "isPlaying": bool(self._media_info.get("is_playing")),
                "cover": "/asset/cover?v=%d" % ver if ver else None,
            }

        wp_enabled = config.get("WALLPAPER_ENABLED", True)
        wp_ver = self._asset_ver("wallpaper")
        wallpaper = {
            "url": ("/asset/wallpaper?v=%s" % self._wallpaper_token
                    if wp_ver and wp_enabled and self._wallpaper_token else None),
            "seed": self._wallpaper_seed if (wp_enabled and wp_ver) else None,
            "alpha": float(config.get("WALLPAPER_ALPHA", 0.15)),
        }

        # Widget 系统：从 config 读取排布顺序，采集外部 widget 状态
        # [] is an intentional user layout, not a request to restore defaults.
        saved_widget_order = config.get("WIDGETS")
        widget_order = _wr.default_widget_order() if saved_widget_order is None else saved_widget_order
        widgets_enabled = bool(config.get("WIDGETS_ENABLED", True))
        _BUILTIN_IDS = {"clock", "media"}
        active_ext = [
            w["id"] for w in widget_order
            if widgets_enabled and w.get("enabled", True) and w["id"] not in _BUILTIN_IDS
        ]

        return {
            "clock": time.strftime("%H:%M"),
            "media": media,
            "cards": cards,
            "staged": staged_list,
            "desktops": desktops,
            "desktopPagerMode": ("icons" if config.get("DESKTOP_PAGER_MODE") == "icons"
                                  else "preview"),
            "wallpaper": wallpaper,
            "widgets": _wr.get_states(active_ext),
            "widgetOrder": widget_order,
            "widgetsEnabled": widgets_enabled,
            "allWidgets": _wr.all_meta(),
            "roles": config.get("ROLES", []),
            "systemTheme": self.host_theme,
            # 随帧推送，让设置页「保存并应用」后无需重启即可生效（前端原先只在启动 fetch 一次）
            "mouseLeaveReset": bool(config.get("MOUSE_LEAVE_RESET_TAB", False)),
        }
