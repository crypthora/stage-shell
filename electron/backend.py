"""Minimal non-pywebview sidecar for the Electron host prototype."""
import os
import json
import signal
import sys
import threading

if len(sys.argv) != 2:
    raise SystemExit("usage: backend.py <outputs-root>")

outputs_root = os.path.abspath(sys.argv[1])
os.chdir(outputs_root)
sys.path.insert(0, outputs_root)

from engine import Engine
from server import start_server, start_state_socket

stopping = threading.Event()
engine = Engine()
server, port = start_server(engine)
state_socket = start_state_socket(engine, port)

def publish_state():
    """Engine notifications become immediate WebSocket state pushes."""
    try:
        state_socket.publish(engine.build_state())
    except Exception as exc:
        print(f"STATE PUSH FAILED: {exc!r}", file=sys.stderr, flush=True)

engine.notify = publish_state
ready_file = os.environ.get("STAGE_SHELL_READY_FILE")
if ready_file:
    with open(ready_file, "w", encoding="utf-8") as f:
        json.dump({"port": port}, f)
print(f"READY http://127.0.0.1:{port}", flush=True)
publish_state()

def start_engine():
    """COM and global-input initialization must never delay the UI host."""
    try:
        engine.start()
    except Exception as exc:
        print(f"ENGINE START FAILED: {exc!r}", file=sys.stderr, flush=True)

threading.Thread(target=start_engine, daemon=True, name="outputs-engine").start()

def stop(*_):
    stopping.set()

signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    stopping.wait()
finally:
    engine.shutdown()
    server.shutdown()
    server.server_close()
