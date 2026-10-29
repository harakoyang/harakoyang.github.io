#!/usr/bin/env python3
"""从远程库删除一笔指定用户的回报。"""

from __future__ import annotations

import argparse
import sqlite3
import sys

from localdb import add_db_args, open_database, report_sqlite, resolve_user


def main() -> int:
    args = parse_args()
    conn = open_database(args)
    try:
        with conn:
            user = resolve_user(conn, args.login, args.user_id)
            cur = conn.execute(
                "DELETE FROM feedback WHERE id = ? AND user_id = ?",
                (args.id, user["id"]),
            )
            if cur.rowcount == 0:
                print("找不到这笔回报", file=sys.stderr)
                return 1
            conn.commit()
    except sqlite3.OperationalError as err:
        report_sqlite(err)
        return 1

    print(conn.label)
    print(f"已删除回报 id={args.id}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="删除指定用户的一笔回报")
    add_db_args(parser)
    parser.add_argument("--id", type=int, required=True, help="回报 id")
    parser.add_argument("--login", help="回报所属用户的登录名")
    parser.add_argument("--user-id", help="回报所属用户的 id")
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(main())
