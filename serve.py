#!/usr/bin/env python3
"""Dev HTTP server that disables browser caching."""
import http.server
import socketserver

PORT = 8765

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
    print(f"Serving at http://127.0.0.1:{PORT}/ (no-cache)")
    httpd.serve_forever()
