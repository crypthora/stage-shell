"""win —— Win32 引擎层。所有平台相关逻辑都在这里，对上层只暴露可序列化的数据。

导入顺序要点：winver 必须最先导入（DPI 感知 + 谎报版本补丁），desktops 依赖它
才能成功 import pyvda。本包的其它模块顶部都先 `from . import winver`。
"""
from . import winver  # noqa: F401  （副作用：DPI + 版本补丁，必须最先执行）
