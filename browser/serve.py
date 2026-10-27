#!/usr/bin/env python3
"""Tiny static server for the pdfharvest browser app.

ES modules and web workers are blocked under file:// URLs, so the page needs to
be served over http. This uses only the standard library, so it runs anywhere
Python does.

    python3 serve.py            # serve on http://localhost:8000 and open it
    python3 serve.py 8080       # pick a port
    python3 serve.py --no-open  # do not launch a browser
"""

from __future__ import annotations

import http.server
import socketserver
import sys
import threading
import webbrowser
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        # Never cache during development, so edits show up on reload.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"  {self.address_string()} — {fmt % args}\n")


def main(argv: list[str]) -> int:
    port = 8000
    should_open = "--no-open" not in argv
    for arg in argv:
        if arg.isdigit():
            port = int(arg)

    handler = partial(Handler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True

    try:
        with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
            url = f"http://localhost:{port}/"
            print(f"pdfharvest — serving {ROOT}")
            print(f"  {url}")
            print("  Ctrl+C to stop\n")
            if should_open:
                threading.Timer(0.6, webbrowser.open, args=[url]).start()
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    except OSError as exc:
        print(f"error: could not bind port {port}: {exc}", file=sys.stderr)
        print(f"try another port:  python3 serve.py {port + 1}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
