"""Read-only excerpt of the voice editor from its selected breakpoint."""
import json
import os
import re
import urllib.error
import urllib.request

from ._base import Widget


class VoiceNoteWidget(Widget):
    id = "voice-note"
    title = "语音便笺"
    icon = "bookmark"

    def __init__(self):
        root = os.path.join(os.environ.get("APPDATA", ""), os.environ.get("STAGE_SHELL_APP_NAME", "stage-shell"))
        self._draft = os.path.join(root, "voice-draft.txt")
        self._breakpoint = os.path.join(root, "voice-breakpoint.json")

    def get_state(self):
        try:
            with open(self._draft, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            text = ""
        try:
            with open(self._breakpoint, "r", encoding="utf-8") as f:
                line = int(json.load(f).get("line") or 1)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            line = 1
        lines = text.splitlines()
        line = max(1, min(line, len(lines) or 1))
        current = lines[line - 1] if lines else ""
        selected_heading = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$", current)
        # The selected heading is already shown in the breadcrumb. Do not
        # repeat it as the first body line, so L1 and L2 share the same body.
        start_line = line + 1 if selected_heading else line
        excerpt = "\n".join(lines[start_line - 1:])
        # Build only the heading ancestry that is valid at the breakpoint.
        # This is a small, static TOC: normal text edits never move the chosen
        # line, while selecting a new line gets the nearest enclosing heading.
        trail = []
        for candidate in lines[:line]:
            match = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$", candidate)
            if not match:
                continue
            level = len(match.group(1))
            while trail and trail[-1][0] >= level:
                trail.pop()
            trail.append((level, match.group(2)))
        return {"line": line, "startLine": start_line,
                "headings": [item[1] for item in trail],
                "text": excerpt[:900], "truncated": len(excerpt) > 900}

    def handle(self, cmd: str, **kw):
        if cmd == "open_editor":
            try:
                request = urllib.request.Request(
                    "http://127.0.0.1:7798/v1/voice/editor/open",
                    data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(request, timeout=2) as response:
                    return json.loads(response.read().decode("utf-8"))
            except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
                return {"ok": False, "error": str(exc)}
        if cmd != "toggle_task":
            return {"ok": False, "error": "unsupported command"}
        try:
            line = int(kw.get("line"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "invalid line"}
        try:
            request = urllib.request.Request(
                "http://127.0.0.1:7798/v1/voice/editor/toggle-task",
                data=json.dumps({"line": line}).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(request, timeout=2) as response:
                result = json.loads(response.read().decode("utf-8"))
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
            return {"ok": False, "error": str(exc)}
        if not result.get("ok"):
            return result
        self.notify()
        return result


WIDGET = VoiceNoteWidget()
