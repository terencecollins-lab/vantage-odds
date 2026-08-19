#!/usr/bin/env python3
"""Local dev server for Vantage: serves the static frontend and proxies
odds requests to SportsGameOdds, keeping the API key server-side only.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 5173))
UPSTREAM_BASE = "https://api.sportsgameodds.com/v2"
CACHE_TTL_SECONDS = 20

_cache = {}  # query string -> (expires_at, status_code, body_bytes)


def load_env_file(path=None):
    path = path or os.path.join(SCRIPT_DIR, ".env")
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


load_env_file()
API_KEY = os.environ.get("SPORTSGAMEODDS_API_KEY", "")

ALLOWED_PROXY_PATHS = {"/api/events"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[vantage] {self.address_string()} - {fmt % args}")

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path in ALLOWED_PROXY_PATHS:
            self.handle_proxy(parsed)
        else:
            self.handle_static(parsed)

    def handle_proxy(self, parsed):
        if not API_KEY:
            self.send_json(500, {"error": "SPORTSGAMEODDS_API_KEY is not set on the server"})
            return

        cache_key = parsed.query
        cached = _cache.get(cache_key)
        if cached and cached[0] > time.time():
            self.send_json_bytes(cached[1], cached[2])
            return

        upstream_url = f"{UPSTREAM_BASE}/events"
        if parsed.query:
            upstream_url += f"?{parsed.query}"

        req = urllib.request.Request(
            upstream_url,
            headers={
                "x-api-key": API_KEY,
                "User-Agent": "Mozilla/5.0 (compatible; VantageDemo/1.0)",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                status = resp.status
                body = resp.read()
        except urllib.error.HTTPError as e:
            status = e.code
            body = e.read()
        except urllib.error.URLError as e:
            self.send_json(502, {"error": f"Could not reach SportsGameOdds: {e.reason}"})
            return

        if status == 200:
            _cache[cache_key] = (time.time() + CACHE_TTL_SECONDS, status, body)
        self.send_json_bytes(status, body)

    def handle_static(self, parsed):
        path = parsed.path
        if path == "/":
            path = "/index.html"
        safe_path = os.path.normpath(path).lstrip("/")
        full_path = os.path.join(SCRIPT_DIR, safe_path)
        if not full_path.startswith(SCRIPT_DIR) or not os.path.isfile(full_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
        }
        ext = os.path.splitext(full_path)[1]
        content_type = content_types.get(ext, "application/octet-stream")

        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, obj):
        self.send_json_bytes(status, json.dumps(obj).encode("utf-8"))

    def send_json_bytes(self, status, body_bytes):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)


if __name__ == "__main__":
    if not API_KEY:
        print("[vantage] WARNING: SPORTSGAMEODDS_API_KEY not found in environment or .env file.")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[vantage] Serving on http://localhost:{PORT}")
    server.serve_forever()
