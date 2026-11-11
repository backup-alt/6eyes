#!/usr/bin/env python3
"""6eyes — persistent Laya decision server.

Keeps the Laya checkpoint hot in one long-lived process so per-prompt
classification costs ~1-2s instead of ~12-14s (which the CLI pays on every
call because it reloads the model each invocation).

Endpoints (localhost only):
  GET  /health           -> {"status":"ready"}
  POST /decide {"text"}  -> full Laya envelope (status/answers/...)

Run with the laya-router venv python. Binding the port is the singleton
guard: a second instance fails to bind and exits, so plugin reloads simply
reuse the already-running server.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
try:
    PORT = int(os.environ.get("LAYA_PORT", "7801"))
    if not 1 <= PORT <= 65535:
        raise ValueError(PORT)
except ValueError:
    print(f"laya-server: invalid LAYA_PORT={os.environ.get('LAYA_PORT')!r}; using 7801", file=sys.stderr, flush=True)
    PORT = 7801

# Loopback only, always. LAYA_HOST is honoured solely as a sanity check: this
# process classifies prompts locally, so it must never be reachable off-host.
_LOOPBACK = {"127.0.0.1", "::1", "localhost", ""}
_requested_host = os.environ.get("LAYA_HOST", "").strip()
if _requested_host not in _LOOPBACK:
    print(
        f"laya-server: LAYA_HOST={_requested_host!r} is not loopback; forcing 127.0.0.1",
        file=sys.stderr,
        flush=True,
    )

try:
    from laya_router.router import decide
except Exception as exc:  # pragma: no cover - import failure = server unusable
    print(f"laya-server: cannot import laya_router: {exc}", file=sys.stderr)
    raise SystemExit(1)

# The torch backend reuses one model instance; serialize predictions so
# concurrent requests never race inside it.
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"status": "ready"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/decide":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            text = str(req.get("text", ""))[:300]
            with LOCK:
                self._send(200, decide(text, source="daemon"))
        except Exception as exc:
            self._send(500, {"status": "unavailable", "advisory": True, "fail_open": True, "error": type(exc).__name__})

    def log_message(self, fmt: str, *args) -> None:
        pass


if __name__ == "__main__":
    # Warm the checkpoint before we start listening, so the first prompt is fast.
    try:
        decide("warm up", source="daemon")
    except Exception:
        pass
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        # Another instance already owns the port — nothing to do.
        raise SystemExit(0)
    server.daemon_threads = True
    print(f"laya-server listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
