"""server.py —— 本地 HTTP 服务（127.0.0.1）。

三类路由：
  /                       -> ui/dist/index.html（构建产物，Vite 打包）
  /assets/*  /*.js 等      -> ui/dist 下的静态资源
  /asset/<key>?v=<ver>    -> 引擎资源仓里的动态 PNG（缩略图/图标/封面/桌面）。
                             版本号在进程重启后会从头计数，故不可跨会话长缓存。
  /api/config  (GET/POST) -> 读取 / 写入 config.json
Electron 从本地 HTTP 服务加载页面，资源同源，无 CORS 顾虑。
"""
import os
import json
import threading
import http.server
import asyncio
import urllib.request
from collections import deque

import websockets

import config

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
}

_DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui", "dist")

# 请求诊断：把每个请求的「到达」与「完成」记到 srv.log。
_SRV_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "srv.log")
_HOST_ACTIONS = deque()
_HOST_ACTIONS_LOCK = threading.Lock()


def _rlog(msg):
    try:
        import time as _t
        with open(_SRV_LOG, "a", encoding="utf-8") as f:
            f.write("%s.%03d [%d] %s\n" % (
                _t.strftime("%H:%M:%S"), int((_t.time() % 1) * 1000), os.getpid(), msg))
    except Exception:
        pass


def _make_handler(engine):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        # ---------- 工具 ----------
        def _send(self, code, body=b"", ctype="text/plain; charset=utf-8",
                  cache=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            if cache:
                self.send_header("Cache-Control", cache)
            self.end_headers()
            if body:
                self.wfile.write(body)
            _rlog("  -> %d (%d B)" % (code, len(body)))

        def _serve_file(self, rel):
            rel = rel.lstrip("/")
            full = os.path.normpath(os.path.join(_DIST, rel))
            if not full.startswith(_DIST):           # 防目录穿越
                self._send(403); return
            if not os.path.isfile(full):
                # SPA 回退：未知路径回 index.html
                full = os.path.join(_DIST, "index.html")
                if not os.path.isfile(full):
                    self._send(404, b"build the UI first: cd ui && npm run build")
                    return
            ext = os.path.splitext(full)[1].lower()
            ctype = _MIME.get(ext, "application/octet-stream")
            with open(full, "rb") as f:
                data = f.read()
            # 带 hash 的构建资源可长缓存；index.html 不缓存
            cache = ("public, max-age=31536000, immutable"
                     if "/assets/" in ("/" + rel) else "no-cache")
            self._send(200, data, ctype, cache)

        # ---------- GET ----------
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            _rlog("GET " + path)
            if path == "/":
                self._serve_file("index.html"); return
            if path in ("/settings", "/settings/"):
                self._serve_file("settings.html"); return
            if path == "/api/config":
                body = json.dumps(config.all(), ensure_ascii=False).encode("utf-8")
                self._send(200, body, "application/json; charset=utf-8", "no-cache")
                return
            if path == "/api/state":
                try:
                    self._json(engine.build_state())
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
                return
            if path.startswith("/asset/"):
                key = path[len("/asset/"):]
                data = engine.get_asset(key)
                if data is None:
                    self._send(404); return
                # _asset_ver is process-local and starts over at 1 after the
                # Electron sidecar restarts.  Long caching would therefore
                # reuse yesterday's wallpaper for /asset/wallpaper?v=1.
                self._send(200, data, "image/png", "no-store")
                return
            if path == "/api/host-actions":
                with _HOST_ACTIONS_LOCK:
                    actions = list(_HOST_ACTIONS)
                    _HOST_ACTIONS.clear()
                self._json(actions)
                return
            self._serve_file(path)

        def _json(self, obj):
            self._send(200, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8", "no-cache")

        def _read_body(self):
            """读完整个请求体（HTTP/1.1 keep-alive 下必须读完，否则连接错位）。"""
            try:
                n = int(self.headers.get("Content-Length", 0))
            except Exception:
                n = 0
            return self.rfile.read(n) if n > 0 else b""

        def _command(self, name, args):
            """Version-neutral local Web API; never expose arbitrary methods."""
            if not isinstance(args, list):
                raise ValueError("args must be a list")
            if name == "ready": return True
            if name == "setOwnWindow":
                hwnd = int(args[0] if args else 0)
                with engine.lock:
                    engine.own_hwnd = hwnd
                return True
            if name == "setHostTheme":
                theme = str(args[0] if args else "")
                if theme not in ("light", "dark"):
                    raise ValueError("theme must be light or dark")
                with engine.lock:
                    engine.host_theme = theme
                return True
            if name == "restartDock":
                with _HOST_ACTIONS_LOCK:
                    _HOST_ACTIONS.append("recoverDock")
                return True
            if name == "recoverCapsHotkey":
                with _HOST_ACTIONS_LOCK:
                    _HOST_ACTIONS.append("recoverHotkey")
                return True
            if name == "getConfig": return config.all()
            if name == "saveConfig": return bool(config.save((args[0] if args else {}) or {}))
            if name == "desktopsForMenu": return engine.desktops_for_menu()
            if name == "widgetCommand":
                from widgets.registry import REGISTRY
                w = REGISTRY.get(str(args[0] if args else ""))
                result = w.handle(str(args[1] if len(args) > 1 else ""),
                                  **((args[2] if len(args) > 2 else {}) or {})) if w else None
                return {"ok": bool(w), "result": result}
            methods = {
                "focusCard": "focus_card", "closeWindow": "close_window",
                "moveToDesktop": "move_to_desktop",
                "pinAppHere": "pin_app_here", "unpinApp": "unpin_app",
                "stackCards": "stack_cards", "unstack": "unstack",
                "insertCard": "insert_card", "stageWindow": "stage_window",
                "unstageWindow": "unstage_window", "peekStaged": "peek_staged",
                "switchDesktop": "switch_desktop", "openApp": "open_app",
                "moveDesktop2d": "move_desktop_2d",
                "mediaPlayPause": "media_play_pause", "mediaNext": "media_next",
                "mediaPrev": "media_prev", "focusMediaApp": "focus_media_app",
                "setRole": "set_role",
                "insertText": "insert_external_text", "captureInputTarget": "capture_input_target",
            }
            method = methods.get(name)
            if method is None:
                raise ValueError("unsupported command: %s" % name)
            result = getattr(engine, method)(*args)
            return True if result is None else result

        # ---------- POST ----------
        def do_POST(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/command":
                try:
                    data = json.loads(self._read_body() or b"{}")
                    self._json({"ok": True, "result": self._command(
                        str(data.get("command") or ""), data.get("args") or [])})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
                return
            # 设置页上传自定义壁纸（请求体=图片原始字节）
            if path == "/api/wallpaper":
                raw = self._read_body()
                try:
                    if not raw or len(raw) > 40 * 1024 * 1024:    # 上限 40MB
                        self._json({"ok": False, "error": "bad size"}); return
                    ok, seed = engine.save_user_wallpaper(raw)
                    self._json({"ok": bool(ok), "seed": seed,
                                "path": config.get("WALLPAPER_PATH", "")})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
                return
            # 清除自定义壁纸 → 退回读一次 Windows 桌面壁纸
            if path == "/api/wallpaper/clear":
                self._read_body()
                try:
                    ok, seed = engine.clear_user_wallpaper()
                    self._json({"ok": bool(ok), "seed": seed,
                                "path": config.get("WALLPAPER_PATH", "")})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
                return
            if path == "/api/widget-command":
                try:
                    data = json.loads(self._read_body() or b"{}")
                    wid = str(data.get("wid") or "")
                    cmd = str(data.get("cmd") or "")
                    kwargs = data.get("kwargs") or {}
                    if not isinstance(kwargs, dict):
                        kwargs = {}
                    from widgets.registry import REGISTRY
                    w = REGISTRY.get(wid)
                    result = None
                    if w:
                        result = w.handle(cmd, **kwargs)
                    self._json({"ok": bool(w), "result": result})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
                return
            if path != "/api/config":
                self._send(404); return
            try:
                data = json.loads(self._read_body())
                ok = config.save(data)
                body = json.dumps({"ok": bool(ok)}).encode("utf-8")
            except Exception as exc:
                body = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8", "no-cache")

    return Handler


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # 关掉 SO_REUSEADDR：Windows 上它会让第二个实例照样绑定同一个 127.0.0.1:7799(端口劫持)，
    # 等于让端口失去"已占用就启动失败"的兜底作用。关掉后端口成为单实例锁之外的第二道防线；
    # 若旧端口偶处 TIME_WAIT，start_server 的端口扫描会自动退到下一个端口，无副作用。
    allow_reuse_address = False


def start_server(engine, port=7799):
    """在后台线程启动 HTTP 服务，返回 (server, actual_port)。port 占用则向上找。"""
    handler = _make_handler(engine)
    last_err = None
    for p in range(port, port + 20):
        try:
            srv = _Server(("127.0.0.1", p), handler)
        except OSError as e:
            last_err = e
            continue
        threading.Thread(target=srv.serve_forever, daemon=True,
                         name="http-server").start()
        return srv, p
    raise RuntimeError("no free port near %d: %s" % (port, last_err))


class StateSocket:
    """Local WebSocket transport for realtime state and API commands.

    HTTP remains the compatibility/static-assets transport. Electron and any
    remote renderer can use this socket for the latency-sensitive path without
    relying on a host-specific JS bridge or periodic full-state polling.
    """
    def __init__(self, engine, port, http_port):
        self.engine = engine
        self.port = port
        self.http_port = http_port
        self.loop = None
        self.clients = set()
        self.server = None
        self.thread = threading.Thread(target=self._run, daemon=True,
                                       name="state-websocket")
        self.thread.start()

    def _run(self):
        asyncio.run(self._serve())

    async def _serve(self):
        self.loop = asyncio.get_running_loop()
        self.server = await websockets.serve(self._client, "127.0.0.1", self.port)
        await self.server.wait_closed()

    async def _client(self, websocket):
        self.clients.add(websocket)
        try:
            await websocket.send(json.dumps({"type": "state", "state": self.engine.build_state()},
                                             ensure_ascii=False))
            async for raw in websocket:
                try:
                    message = json.loads(raw)
                    request_id = message.get("id")
                    if message.get("type") != "command":
                        raise ValueError("unsupported websocket message")
                    body = json.dumps({"command": message.get("command"),
                                       "args": message.get("args") or []}).encode("utf-8")
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{self.http_port}/api/command", body,
                        {"Content-Type": "application/json"}, method="POST")
                    with urllib.request.urlopen(request, timeout=5) as response:
                        result = json.loads(response.read())
                    await websocket.send(json.dumps({"type": "result", "id": request_id, **result},
                                                     ensure_ascii=False))
                except Exception as exc:
                    await websocket.send(json.dumps({"type": "result", "id": locals().get("request_id"),
                                                     "ok": False, "error": str(exc)}, ensure_ascii=False))
        finally:
            self.clients.discard(websocket)

    async def _broadcast(self, payload):
        stale = []
        for client in tuple(self.clients):
            try:
                await client.send(payload)
            except Exception:
                stale.append(client)
        for client in stale:
            self.clients.discard(client)

    def publish(self, state):
        if not self.loop or not self.clients:
            return
        payload = json.dumps({"type": "state", "state": state}, ensure_ascii=False)
        asyncio.run_coroutine_threadsafe(self._broadcast(payload), self.loop)


def start_state_socket(engine, http_port):
    """Use a deterministic sibling port so clients need no host bridge."""
    return StateSocket(engine, http_port + 100, http_port)
