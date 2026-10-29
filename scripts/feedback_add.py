#!/usr/bin/env python3
"""向远程库写入一笔回报。"""

from __future__ import annotations

import argparse
import math
import sqlite3
import sys
import time

from localdb import add_db_args, open_database, report_sqlite, resolve_user

MAX_CONTENT = 2000
HOURLY_QUOTA = 5
HOUR_MS = 3_600_000


def main() -> int:
    args = parse_args()
    content = args.content.strip()
    if not content:
        print("回报内容不能为空", file=sys.stderr)
        return 1
    if len(content) > MAX_CONTENT:
        print(f"回报内容超过 {MAX_CONTENT} 字", file=sys.stderr)
        return 1
    target = args.target.strip()[:64] if args.target else None
    if target == "":
        target = None

    conn = open_database(args)
    now = int(time.time() * 1000)
    try:
        with conn:
            user = resolve_user(conn, args.login, args.user_id)
            retry_after = quota_retry_after(conn, user["id"], now)
            if retry_after is not None:
                print(f"这个用户一小时内已有 {HOURLY_QUOTA} 笔回报，请 {retry_after} 秒后再写", file=sys.stderr)
                return 1
            cur = conn.execute(
                "INSERT INTO feedback (user_id, target, content, created_at) VALUES (?, ?, ?, ?)",
                (user["id"], target, content, now),
            )
            conn.commit()
            new_id = cur.lastrowid
    except sqlite3.OperationalError as err:
        report_sqlite(err)
        return 1

    print(conn.label)
    print(f"已写入回报 id={new_id}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="向远程库写入一笔回报")
    add_db_args(parser)
    parser.add_argument("--login", help="回报所属用户的登录名")
    parser.add_argument("--user-id", help="回报所属用户的 id")
    parser.add_argument("--content", required=True, help="回报内容")
    parser.add_argument("--target", help="回报对象，例如 M42")
    return parser.parse_args()


def quota_retry_after(conn, user_id: str, now: int) -> int | None:
    recent = conn.execute(
        "SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?",
        (user_id, now - HOUR_MS),
    ).fetchone()
    if recent["n"] < HOURLY_QUOTA:
        return None
    blocking = conn.execute(
        """
        SELECT created_at FROM feedback WHERE user_id = ?
        ORDER BY created_at DESC LIMIT 1 OFFSET ?
        """,
        (user_id, HOURLY_QUOTA - 1),
    ).fetchone()
    if blocking is None:
        return 3600
    return max(1, math.ceil((blocking["created_at"] + HOUR_MS - now) / 1000))


if __name__ == "__main__":
    sys.exit(main())
