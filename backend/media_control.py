"""
media_control.py — Windows SMTC 媒体信息读取 / 控制封装
依赖: pip install winsdk
"""
import asyncio
import io
import threading

_AVAILABLE = False
try:
    from winsdk.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as _MediaManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as _PlayStatus,
    )
    from winsdk.windows.storage.streams import DataReader as _DataReader
    _AVAILABLE = True
except Exception:
    pass

try:
    from PIL import Image as _PilImage
except Exception:
    _PilImage = None


class MediaController:
    """线程安全的 SMTC 媒体信息读取 + 控制。

    Windows 系统媒体传输控件(SMTC)接口，与任务栏/锁屏媒体控件同源。
    Spotify、网易云、QQ 音乐等主流播放器均会向系统注册 SMTC 会话。
    """

    def __init__(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop, daemon=True, name="smtc-loop")
        self._thread.start()
        self._manager = None
        self._thumb_cache: dict = {}   # (title, artist) -> PIL Image

    @staticmethod
    def available() -> bool:
        return _AVAILABLE and _PilImage is not None

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _run(self, coro, timeout: float = 2.0):
        if not _AVAILABLE:
            return None
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return fut.result(timeout=timeout)
        except Exception:
            return None

    async def _get_manager(self):
        if self._manager is None:
            self._manager = await _MediaManager.request_async()
        return self._manager

    async def _fetch(self):
        try:
            mgr = await self._get_manager()
        except Exception:
            self._manager = None
            return None
        session = mgr.get_current_session()
        if session is None:
            return None
        try:
            props = await session.try_get_media_properties_async()
        except Exception:
            return None

        pb = session.get_playback_info()
        is_playing = bool(pb and pb.playback_status == _PlayStatus.PLAYING)

        title  = props.title  or ''
        artist = props.artist or ''
        key = (title, artist)
        thumb = self._thumb_cache.get(key)

        if thumb is None and props.thumbnail and _PilImage:
            try:
                stream = await props.thumbnail.open_read_async()
                size   = stream.size
                reader = _DataReader(stream)
                await reader.load_async(size)
                buf   = reader.read_buffer(size)
                thumb = _PilImage.open(io.BytesIO(bytes(buf))).convert("RGBA")
                self._thumb_cache[key] = thumb
                if len(self._thumb_cache) > 10:
                    del self._thumb_cache[next(iter(self._thumb_cache))]
            except Exception:
                thumb = None

        return {'title': title, 'artist': artist,
                'thumbnail': thumb, 'is_playing': is_playing}

    def get_info(self):
        """同步获取当前媒体信息；无媒体返回 None。"""
        return self._run(self._fetch())

    async def _get_source(self):
        try:
            mgr = await self._get_manager()
            session = mgr.get_current_session()
            return session.source_app_user_model_id if session else None
        except Exception:
            return None

    def get_source(self) -> 'str | None':
        """返回当前媒体会话的源 App AUMID，如 'Spotify.exe'；无会话返回 None。"""
        return self._run(self._get_source())

    # ---------- 控制 ----------
    def _ctrl(self, coro):
        self._run(coro, timeout=1.0)

    def play_pause(self):
        async def _():
            mgr = await self._get_manager()
            s = mgr.get_current_session()
            if not s:
                return
            pb = s.get_playback_info()
            if pb and pb.playback_status == _PlayStatus.PLAYING:
                await s.try_pause_async()
            else:
                await s.try_play_async()
        self._ctrl(_())

    def next_track(self):
        async def _():
            mgr = await self._get_manager()
            s = mgr.get_current_session()
            if s:
                await s.try_skip_next_async()
        self._ctrl(_())

    def prev_track(self):
        async def _():
            mgr = await self._get_manager()
            s = mgr.get_current_session()
            if s:
                await s.try_skip_previous_async()
        self._ctrl(_())
