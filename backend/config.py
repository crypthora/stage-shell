"""config.py —— config.json 读取 / 热更新 / 保存（取代旧的模块级全局变量方案）。

源真相仍是 config.json；UI 通过 /api/config 读写。get() 永远返回有效值
（缺字段回退默认值），所以引擎其余部分不必判空。
"""
import json
import os

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# 所有可配置项的硬编码默认值（与当前侧栏实现对齐）
_DEFAULTS = {
    # 外观
    "ROOT_BG": "#1b1b1b",
    "CARD_BG": "#2a2a2a",
    "POMO_FG": "#ff8c42",
    "SIDEBAR_BREATHE_BREAK": "#5b8c6e",
    "SIDEBAR_BREATHE_DONE": "#5b7a9c",
    "ICON_OPACITY": 0.8,
    "SHOW_THUMBNAIL": True,
    "UI_SCALE": 1.0,            # 额外缩放微调（默认 1.0）；UI 已按 BAR_W 自动适配，<1 让内容再小些
    # 布局
    "BAR_W": 300,
    "MAX_CARDS": 5,
    "CARD_W": 240,
    "GAP": 14,
    "INNER_PAD": 12,
    "PAGER_MAX": 4,
    "REFRESH_MS": 700,
    "DOCK_SIDE": "right",
    "RESERVE_SPACE": True,
    # 番茄钟
    "WORK_SEC": 1500,
    "BREAK_SEC": 300,
    "SOUND_ENABLED": True,
    "SOUND_WORK_DONE": "",
    "SOUND_BREAK_BG": "",
    "SOUND_BREAK_DONE": "",
    # 虚拟桌面规则：把匹配窗口自动钉到指定桌面。每条规则字段：
    #   app     —— 应用标识(=engine app_key，进程名或 PWA 的 AUMID，小写)，按"应用"钉
    #   title   —— 窗口标题子串(可选，兼容旧规则)
    #   cls     —— 窗口类名子串(可选，兼容旧规则)
    #   desktop —— 目标桌面号(1 起)
    # app/title/cls 同时给出为 AND；右键"钉在此桌面"写入的是 app 形式。
    "DESKTOP_RULES": [],
    # 前台锁超时(ms)：0=不动 Windows 默认(侧栏点卡片切窗口最可靠)；
    # 设大值(如 200000)→ Windows 拒绝程序抢前台(改为任务栏闪烁)，全局生效。
    "FOREGROUND_LOCK_MS": 0,
    # 语音（FunASR 2pass 后端，见 funasr_server.py）
    "VOICE_ENABLED": True,
    "VOICE_ADDR": "127.0.0.1",
    "VOICE_PORT": "10095",
    "INSERT_RESTORE_CLIP": True,
    "CONNECT_TIMEOUT": 2.0,
    "RESULT_TIMEOUT": 15.0,
    "PTT_MODE": "hold",
    "MIN_HOLD_S": 0.15,
    "VOICE_CONTEXT": "",        # 用户自定义 ASR 上下文（专有名词、容易误识别的词、缩写、应用名等）；
                                # 便签 widget 会在此基础上追加从便签内容 LLM 提炼的上下文（运行时动态）
    "VOICE_LANGUAGE": "zh",    # 识别语言（zh/en/auto 等，auto=服务端自动检测）
    "VOICE_GAIN_ADAPTIVE": True,  # 自适应增益(AGC/动态压缩)：按实时电平把音量拉到目标，
                                # 自动适配麦克风远近（放桌上/拿手里都行），无需固定倍数。
    "VOICE_GAIN": 3.0,         # 固定增益倍数：仅当 VOICE_GAIN_ADAPTIVE=False 时用（峰值×此值后限幅）
    # 壁纸背景
    "WALLPAPER_ENABLED": True,
    "WALLPAPER_ALPHA": 0.15,    # 壁纸层透明度(0~1)；0.15 = 仅隐约可见
    "WALLPAPER_PATH": "",       # 用户在设置页选择的壁纸；空/失效=纯黑背景
    # 桌面切换器：preview=显示各桌面的前台窗口缩略图；icons=仅显示快捷图标
    "DESKTOP_PAGER_MODE": "preview",
    # 交互
    "MOUSE_LEAVE_RESET_TAB": False,
    "SIDEBAR_HIDE_MODE": "handle",  # handle=折叠成几像素把手，hover 自动展开；always=永远展示
    # Widget 插件排布（None = 由 registry 自动生成默认顺序）
    "WIDGETS": None,
    # Independent from WIDGETS: an empty list is a valid saved layout, while
    # this switch permanently removes the entire widget strip from the Dock.
    "WIDGETS_ENABLED": True,
    # 角色定义（6 条，可自定义 label 和 color）：索引即角色编号（0-5）
    "ROLES": [
        {"label": "个人", "color": "#10D479"},
        {"label": "工作", "color": "#1B73FF"},
        {"label": "隐私", "color": "#FF2525"},
        {"label": "专注", "color": "#FFB300"},
        {"label": "创意", "color": "#A033FF"},
        {"label": "社交", "color": "#FF2D92"},
    ],
    # 窗口角色标记：{app_key_lower: role_index}，role_index 为 ROLES 的整数下标
    "WINDOW_ROLES": {},
}

_cfg = dict(_DEFAULTS)


def reload():
    """从磁盘重新加载；缺文件/坏字段时回退默认值。返回当前配置 dict 副本。"""
    global _cfg
    merged = dict(_DEFAULTS)
    try:
        with open(_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k in _DEFAULTS:
                if k in data and data[k] is not None:
                    merged[k] = data[k]
    except Exception:
        pass
    _cfg = merged
    return dict(_cfg)


def get(key, default=None):
    if key in _cfg:
        return _cfg[key]
    return default if default is not None else _DEFAULTS.get(key)


def all():
    return dict(_cfg)


def save(updates: dict) -> bool:
    """把 updates 合并写回 config.json 并热加载；成功返回 True。"""
    try:
        try:
            with open(_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}
        data.update(updates)
        with open(_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        reload()
        return True
    except Exception:
        return False


# ---------- 派生布局常量（依赖配置，需在 reload 后取） ----------
def bar_w():
    return int(get("BAR_W", 300))


def card_w():
    return int(get("CARD_W", 240))


def thumb_h():
    """缩略图高度：锁定 16:9。"""
    return card_w() * 9 // 16


def dock_right():
    return get("DOCK_SIDE", "right") == "right"


reload()
