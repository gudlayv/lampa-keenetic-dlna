#!/usr/bin/env python3
"""
HTTPS-CORS-прокси для DLNA-сервера Кинетика.

LAMPA-плагин шлёт SOAP-запросы через этот прокси:
  POST /proxy/http://<dlna-host>/<path>
Прокси форвардит запрос на DLNA, добавляет CORS-заголовки в ответ.

Безопасность:
- ALLOWED_HOSTS — whitelist хостов, на которые можно проксировать
  (дефолт: только адрес DLNA-сервера). Запросы на админку Кинетика
  и другие сервисы LAN отвергаются.
- Никакой статики, никаких /reports — только /proxy + /ping + /ffprobe.

GET /ffprobe?url=<media-url> — раскладка дорожек медиафайла (ffprobe JSON)
для релейблинга аудиодорожек в плеере LAMPA. url проверяется тем же
allowlist. Требует ffprobe в PATH (opkg install ffprobe); нет — 503.

Запуск:
    python3 serve.py [port] [--allow host:port,host:port]

Через переменные окружения:
    DLNA_PROXY_PORT=8780
    DLNA_PROXY_ALLOW="192.168.1.1:8200,192.168.1.1:80"
"""

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse


def _parse_allow(s):
    """'host:port,host:port' → set of normalized 'host:port' strings."""
    out = set()
    for chunk in (s or "").split(","):
        chunk = chunk.strip().lower()
        if chunk:
            out.add(chunk)
    return out


# Дефолт: MiniDLNA + встроенный Transmission Кинетика. Через DLNA_PROXY_ALLOW
# пользователь может изменить порты (например если Transmission на :8091).
ALLOWED_HOSTS = _parse_allow(os.environ.get("DLNA_PROXY_ALLOW", "192.168.1.1:8200,192.168.1.1:8090"))


def host_allowed(target_url):
    try:
        u = urlparse(target_url)
    except Exception:
        return False
    if u.scheme not in ("http", "https"):
        return False
    if not u.hostname:
        return False
    port = u.port or (443 if u.scheme == "https" else 80)
    key = f"{u.hostname.lower()}:{port}"
    return key in ALLOWED_HOSTS


# ffprobe-метаданные дорожек — кэш на время жизни процесса (файлы не меняются).
_FFPROBE_CACHE = {}
_FFPROBE_CACHE_MAX = 200


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("%s %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, SOAPAction, Authorization, X-Transmission-Session-Id")
        self.send_header("Access-Control-Expose-Headers", "X-Transmission-Session-Id")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def proxy_forward(self, method):
        target = self.path[len("/proxy/"):]
        if not target.startswith("http://") and not target.startswith("https://"):
            self.send_error(400, "proxy target must be absolute http(s) URL")
            return
        if not host_allowed(target):
            print(f"[deny] {method} {target} (not in allowlist)")
            self.send_error(403, "host not in allowlist")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        # cookie скипаем явно — иначе LAMPA-домен мог бы случайно
        # пробросить свои сессионки на upstream DLNA/Transmission.
        skip = {"host", "connection", "content-length", "origin", "referer", "cookie"}
        forward_headers = {}
        for k, v in self.headers.items():
            if k.lower() in skip:
                continue
            forward_headers[k] = v
        req = urllib.request.Request(target, data=body, method=method, headers=forward_headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = resp.status
                resp_body = resp.read()
                resp_headers = dict(resp.headers.items())
        except urllib.error.HTTPError as e:
            status = e.code
            resp_body = e.read() if e.fp else b""
            resp_headers = dict(e.headers.items()) if e.headers else {}
        except Exception as e:
            self.send_error(502, f"upstream error: {e}")
            return
        print(f"[proxy] {method} {target} -> {status} ({len(resp_body)} bytes)")
        self.send_response(status)
        for k, v in resp_headers.items():
            if k.lower() in {"transfer-encoding", "connection", "content-length"}:
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    def ffprobe(self):
        # GET /ffprobe?url=<media-url> — раскладка дорожек медиафайла для
        # релейблинга в плеере LAMPA (плагин показывает Title дорожек вместо
        # "Неизвестно"). ffprobe для MKV читает только заголовок → быстро.
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        target = (qs.get("url") or [""])[0]
        target = unquote(target)
        if not target.startswith("http://") and not target.startswith("https://"):
            self.send_error(400, "url must be absolute http(s) URL")
            return
        if not host_allowed(target):
            print(f"[deny] ffprobe {target} (not in allowlist)")
            self.send_error(403, "host not in allowlist")
            return

        if target in _FFPROBE_CACHE:
            self._send_json(200, _FFPROBE_CACHE[target])
            return

        ffprobe_bin = shutil.which("ffprobe")
        if not ffprobe_bin:
            print("[ffprobe] binary not found (opkg install ffprobe)")
            self.send_error(503, "ffprobe not installed")
            return

        try:
            out = subprocess.run(
                [ffprobe_bin, "-v", "quiet", "-print_format", "json",
                 "-show_streams", target],
                capture_output=True, timeout=20,
            )
        except subprocess.TimeoutExpired:
            print(f"[ffprobe] timeout {target}")
            self.send_error(502, "ffprobe timeout")
            return
        except Exception as e:
            self.send_error(502, f"ffprobe error: {e}")
            return

        if out.returncode != 0 or not out.stdout:
            print(f"[ffprobe] rc={out.returncode} {target}")
            self.send_error(502, "ffprobe failed")
            return

        try:
            data = json.loads(out.stdout)
        except Exception:
            self.send_error(502, "ffprobe returned non-json")
            return

        body = json.dumps({"streams": data.get("streams", [])}).encode("utf-8")
        if len(_FFPROBE_CACHE) >= _FFPROBE_CACHE_MAX:
            _FFPROBE_CACHE.clear()
        _FFPROBE_CACHE[target] = body
        n = len(data.get("streams", []))
        print(f"[ffprobe] {target} -> {n} streams ({len(body)} bytes)")
        self._send_json(200, body)

    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/proxy/"):
            self.proxy_forward("GET")
            return
        if self.path.startswith("/ffprobe"):
            self.ffprobe()
            return
        if self.path.startswith("/ping"):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"pong")
            return
        # Корень — короткая 200-OK подсказка вместо 404, чтобы health-checks были
        # понятны, но НИКАКОЙ статики и листинга директорий.
        if self.path in ("/", ""):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"lampa-keenetic-dlna proxy. POST /proxy/<dlna-url>. "
                b"Allowlisted hosts: " + ", ".join(sorted(ALLOWED_HOSTS)).encode()
            )
            return
        self.send_error(404, "not found")

    def do_POST(self):
        if self.path.startswith("/proxy/"):
            self.proxy_forward("POST")
            return
        self.send_error(404, "POST allowed only on /proxy/<url>")


def main():
    args = sys.argv[1:]
    port = int(os.environ.get("DLNA_PROXY_PORT") or "8780")
    if args and args[0].isdigit():
        port = int(args[0])
        args = args[1:]
    if "--allow" in args:
        i = args.index("--allow")
        if i + 1 < len(args):
            ALLOWED_HOSTS.update(_parse_allow(args[i + 1]))

    print(f"serving on http://0.0.0.0:{port}")
    print(f"allowlist: {sorted(ALLOWED_HOSTS)}")
    print(f"plugin endpoint: POST /proxy/<dlna-url>")
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
