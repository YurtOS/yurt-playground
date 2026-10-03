"""Synthetic orders for the playground Datasette demo (Apache-2.0)."""
import argparse
import sqlite3
from pathlib import Path

DB_PATH = "/home/user/demos/datasette/orders.db"
ROWS = [
    (1, "2026-01-01", "Notebook", 2, 500),
    (2, "2026-01-01", "Pen", 5, 100),
    (3, "2026-01-02", "Mug", 1, 1200),
    (4, "2026-01-02", "Notebook", 1, 500),
    (5, "2026-01-03", "Pen", 10, 100),
    (6, "2026-01-03", "Mug", 2, 1200),
    (7, "2026-01-04", "Notebook", 3, 500),
    (8, "2026-01-04", "Pen", 4, 100),
    (9, "2026-01-05", "Mug", 1, 1200),
    (10, "2026-01-05", "Notebook", 2, 500),
    (11, "2026-01-06", "Pen", 1, 100),
    (12, "2026-01-06", "Mug", 3, 1200),
]


def seed(reset=False):
    path = Path(DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    if reset:
        for name in ["orders.db", "orders.db-journal", "orders.db-wal",
                     "orders.db-shm", "server.pid", "server.log"]:
            (path.parent / name).unlink(missing_ok=True)
    elif path.exists():
        return
    db = sqlite3.connect(path)
    try:
        with db:
            db.execute("""CREATE TABLE orders (
                id INTEGER PRIMARY KEY,
                ordered_at TEXT NOT NULL,
                product TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
            )""")
            db.executemany("INSERT INTO orders VALUES (?, ?, ?, ?, ?)", ROWS)
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true")
    seed(parser.parse_args().reset)
