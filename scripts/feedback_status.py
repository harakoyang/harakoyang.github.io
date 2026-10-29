#!/usr/bin/env python3
"""修改远程库里一笔回报的状态。"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time

from localdb import add_db_args, open_database, report_sqlite

STATUSES = ("new", "triaged", "done", "wontfix")


def main() -> int:
    args = parse_args()
    if args.status not in STATUSES:
        print(f"未知状态: {args.status}", file=sys.stderr)
        return 1
    conn = open_database(args)
    now = int(time.time() * 1000)
    try:
        with conn:
            cur = conn.execute(
                "UPDATE feedback SET status = ?, reviewed_at = ? WHERE id = ?",
                (args.status, now, args.id),
            )
            if cur.rowcount == 0:
                print("找不到这笔回报", file=sys.stderr)
                return 1
            conn.commit()
    except sqlite3.OperationalError as err:
        report_sqlite(err)
        return 1

    print(conn.label)
    print(f"回报 {args.id} 状态已改为 {args.status}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="修改一笔回报的状态")
    add_db_args(parser)
    parser.add_argument("--id", type=int, required=True, help="回报 id")
    parser.add_argument("--status", required=True, help="new, triaged, done, wontfix")
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(main())
