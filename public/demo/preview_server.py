"""Small prefixed WSGI server for the editable browser preview."""

import hmac
import html
import mimetypes
import secrets
import sys
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote
from wsgiref.simple_server import WSGIRequestHandler, make_server


def response(start_response, status, body, headers=()):
    payload = body.encode("utf-8") if isinstance(body, str) else body
    start_response(status, [("Content-Length", str(len(payload))), *headers])
    return [payload]


def cookies(environ):
    jar = SimpleCookie()
    jar.load(environ.get("HTTP_COOKIE", ""))
    return jar


def make_app(prefix, site_dir):
    script_name = prefix.rstrip("/")
    site = Path(site_dir)
    site_root = site.resolve()

    def app(environ, start_response):
        path = environ["PATH_INFO"]
        if not path.startswith(prefix):
            return response(start_response, "404 Not Found", "Not found")
        environ["SCRIPT_NAME"] = script_name
        path = "/" + path[len(prefix):]
        environ["PATH_INFO"] = path
        method = environ["REQUEST_METHOD"]

        if method == "GET" and path == "/__ready":
            return response(start_response, "200 OK", "yurt-preview-ready",
                            [("Content-Type", "text/plain; charset=utf-8")])

        if method == "GET" and path == "/form":
            token = secrets.token_urlsafe(24)
            body = ("<!doctype html><title>Preview form</title>"
                    f'<form method="post" action="{script_name}/form">'
                    '<label>Name <input name="name"></label>'
                    f'<input type="hidden" name="csrf" value="{token}">'
                    '<button type="submit">Save</button></form>')
            return response(start_response, "200 OK", body, [
                ("Content-Type", "text/html; charset=utf-8"),
                ("Set-Cookie", f"yurt_csrf={token}; Path={prefix}"),
            ])

        if method == "POST" and path == "/form":
            size = int(environ.get("CONTENT_LENGTH") or 0)
            fields = parse_qs(environ["wsgi.input"].read(size).decode("utf-8"))
            token = fields.get("csrf", [""])[0]
            csrf = cookies(environ).get("yurt_csrf")
            if not csrf or not token or not hmac.compare_digest(token, csrf.value):
                return response(start_response, "403 Forbidden", "Forbidden")
            name = fields.get("name", [""])[0]
            return response(start_response, "303 See Other", b"", [
                ("Location", script_name + "/"),
                ("Set-Cookie", f"yurt_name={quote(name, safe='')}; Path={prefix}"),
            ])

        if method != "GET":
            return response(start_response, "405 Method Not Allowed", "Method not allowed")
        relative = unquote(path).lstrip("/")
        parts = relative.split("/")
        if path.startswith("//") or any(part in ("..", ".") for part in parts):
            return response(start_response, "404 Not Found", "Not found")
        target = site.joinpath(*parts)
        if target.is_dir():
            target = target / "index.html"
        if not target.resolve().is_relative_to(site_root):
            return response(start_response, "404 Not Found", "Not found")
        if target.suffix.lower() not in {".html", ".css", ".js", ".mjs", ".wasm", ".svg", ".json", ".txt"} or not target.is_file():
            return response(start_response, "404 Not Found", "Not found")
        payload = target.read_bytes()
        if target.name == "index.html":
            name = cookies(environ).get("yurt_name")
            greeting = f"<p>Hello, {html.escape(unquote(name.value))}!</p>" if name else ""
            payload = payload.replace(b"<!--GREETING-->", greeting.encode("utf-8"))
        content_type = {".mjs": "text/javascript", ".wasm": "application/wasm"}.get(
            target.suffix.lower(), mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        )
        if content_type.startswith("text/"):
            content_type += "; charset=utf-8"
        return response(start_response, "200 OK", payload, [("Content-Type", content_type)])

    return app


class RequestHandler(WSGIRequestHandler):
    def log_message(self, format, *args):
        parts = self.requestline.split()
        if len(parts) >= 2:
            print(f"{parts[0]} {parts[1]} {args[1]}", flush=True)


if __name__ == "__main__":
    _, port, prefix, site_dir = sys.argv
    with make_server("127.0.0.1", int(port), make_app(prefix, site_dir),
                     handler_class=RequestHandler) as server:
        server.serve_forever()
