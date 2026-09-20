"""The guest half of the playground's suspend/resume notebook kernel.

One CPython process, fed cells over its stdin and answering over its stdout,
one JSON object per line. The page-side worker turns those lines into Jupyter
messages; nothing here knows about Jupyter. Between cells the process is
parked in a read(2), and while a cell runs its prints are write(2)s: either is
a syscall the sandbox seal can unwind the process at, which is what lets the
notebook be suspended mid-cell and resumed later exactly there.

Frames in:  {"t": "exec", "code": "..."}
Frames out: {"t": "ready"}
            {"t": "stream", "name": "stdout"|"stderr", "text": "..."}
            {"t": "result", "text": "..."}            the last expression's repr
            {"t": "error", "ename": "...", "evalue": "...", "traceback": [...]}
            {"t": "done", "count": N}                 after every cell
"""
import ast
import json
import os
import sys
import traceback
import tty

IN = 0
OUT = 1


def emit(frame):
    data = (json.dumps(frame) + "\n").encode()
    while data:
        n = os.write(OUT, data)
        data = data[n:]


class Stream:
    """A sys.stdout/sys.stderr that ships each write as a frame at once, so
    a long-running cell's output reaches the notebook while it runs."""

    def __init__(self, name):
        self.name = name

    def write(self, text):
        if text:
            emit({"t": "stream", "name": self.name, "text": text})
        return len(text)

    def flush(self):
        pass

    def isatty(self):
        return False


def read_line():
    buf = bytearray()
    while True:
        chunk = os.read(IN, 4096)
        if not chunk:
            return None
        buf.extend(chunk)
        if buf.endswith(b"\n"):
            return bytes(buf)


def run_cell(code, namespace):
    tree = ast.parse(code, "<cell>", "exec")
    last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    if last is not None:
        tree.body = tree.body[:-1]
    exec(compile(tree, "<cell>", "exec"), namespace)
    if last is not None:
        value = eval(compile(ast.Expression(last.value), "<cell>", "eval"), namespace)
        if value is not None:
            namespace["_"] = value
            emit({"t": "result", "text": repr(value)})


def main():
    # The pty carries a protocol, not a terminal session: no echo, no
    # CR/LF rewriting, no ^C (the host interrupts with a signal instead).
    tty.setraw(IN)
    sys.stdout = Stream("stdout")
    sys.stderr = Stream("stderr")
    namespace = {"__name__": "__main__", "__builtins__": __builtins__}
    count = 0
    emit({"t": "ready"})
    while True:
        line = read_line()
        if line is None:
            return
        try:
            frame = json.loads(line)
        except ValueError:
            continue
        if frame.get("t") != "exec":
            continue
        count += 1
        try:
            run_cell(frame.get("code", ""), namespace)
        except BaseException as error:  # a cell may raise anything, including SystemExit
            emit({
                "t": "error",
                "ename": type(error).__name__,
                "evalue": str(error),
                "traceback": traceback.format_exception(error),
            })
        emit({"t": "done", "count": count})


if __name__ == "__main__":
    main()
