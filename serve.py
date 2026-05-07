#!/usr/bin/env python3
"""
Dev-сервер для отладки LAMPA-плагинов в локальной сети.

Что делает:
- GET /...           — отдает файлы из текущей директории (плагины и т.п.)
- POST /report       — принимает JSON-отчет от плагина и сохраняет в reports/<ts>.json
- GET  /reports      — JSON-список сохраненных отчетов
- GET  /reports/last — последний отчет

Запуск:
    python3 serve.py [port]
По умолчанию порт 8080. Слушает на всех интерфейсах (0.0.0.0).

URL для подключения в LAMPA (заменить IP на твой):
    http://192.168.1.129:8080/plugins/tizen-debug.js
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPORTS_DIR = ROOT / "reports"
REPORTS_DIR.mkdir(exist_ok=True)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, SOAPAction, Authorization, X-Requested-With")
        self.send_header("Access-Control-Expose-Headers", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def proxy_forward(self, method):
        """Префиксный прокси: /proxy/http://target/path → форвардит на target."""
        target = self.path[len("/proxy/"):]
        if not target.startswith("http://") and not target.startswith("https://"):
            self.send_error(400, "proxy target must be absolute http(s) URL")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        # Передаем заголовки запроса дальше (кроме hop-by-hop и Host)
        skip = {"host", "connection", "content-length", "origin", "referer"}
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
        # CORS уже добавляются в end_headers
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    def do_POST(self):
        if self.path.startswith("/proxy/"):
            self.proxy_forward("POST")
            return
        if self.path.rstrip("/") != "/report":
            self.send_error(404, "POST only on /report or /proxy/<url>")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception as exc:
            self.send_error(400, f"bad json: {exc}")
            return
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = REPORTS_DIR / f"{ts}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[report] saved {path.relative_to(ROOT)} ({length} bytes)")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"saved": str(path.name)}).encode())

    def do_GET(self):
        if self.path.startswith("/proxy/"):
            self.proxy_forward("GET")
            return
        if self.path.startswith("/ping"):
            print(f"[ping] from {self.client_address[0]}")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"pong")
            return
        if self.path.startswith("/report-img"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            data_raw = qs.get("d", [""])[0]
            try:
                data = json.loads(data_raw)
            except Exception:
                data = {"raw": data_raw}
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            path = REPORTS_DIR / f"{ts}-img.json"
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[report-img] saved {path.relative_to(ROOT)}")
            # 1x1 transparent gif
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.end_headers()
            self.wfile.write(bytes.fromhex("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b"))
            return
        if self.path == "/reports":
            files = sorted(p.name for p in REPORTS_DIR.glob("*.json"))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(files).encode())
            return
        if self.path == "/reports/last":
            files = sorted(REPORTS_DIR.glob("*.json"))
            if not files:
                self.send_error(404, "no reports yet")
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(files[-1].read_bytes())
            return
        super().do_GET()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"serving {ROOT} on http://0.0.0.0:{port}")
    print(f"plugin url:   http://<твой-ip>:{port}/plugins/tizen-debug.js")
    print(f"reports dir:  {REPORTS_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
