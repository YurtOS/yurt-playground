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


def cell_traceback(error):
    """Trim dispatch frames in every displayed exception without changing
    exceptions saved in the cell namespace. SyntaxError keeps its location."""
    formatted = traceback.TracebackException.from_exception(error)
    pending = [formatted]
    while pending:
        current = pending.pop()
        stack = current.stack
        # A compiler-only cell SyntaxError supplies its own location. A
        # library-only cause or group member still needs its complete stack.
        dispatch = next((i for i, frame in enumerate(stack)
                         if frame.filename == __file__ and frame.name == "run_cell"), None)
        compiler_error = (
            getattr(current, "filename", None) == "<cell>" and dispatch is not None
            and all(frame.filename == ast.__file__ for frame in stack[dispatch + 1:])
        )
        fallback = len(stack) if compiler_error else 0
        first = next((i for i, frame in enumerate(stack)
                      if frame.filename == "<cell>"), fallback)
        # Re-raising a saved exception can put older dispatch frames below
        # its first cell frame. Keep other callees, including Stream.write.
        current.stack = traceback.StackSummary.from_list([
            frame for frame in stack[first:]
            if not (frame.filename == __file__
                    and frame.name in ("main", "run_cell"))
        ])
        pending.extend(part for part in (current.__cause__, current.__context__)
                       if part is not None)
        pending.extend(current.exceptions or [])
    return list(formatted.format())


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
                "traceback": cell_traceback(error),
            })
        emit({"t": "done", "count": count})


if __name__ == "__main__":
    main()
