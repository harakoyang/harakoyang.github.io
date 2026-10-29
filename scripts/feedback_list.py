#!/usr/bin/env python3
"""列出远程库里的回报。"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time

from localdb import add_db_args, open_database, report_sqlite, resolve_user

STATUSES = ("new", "triaged", "done", "wontfix")


def main() -> int:
    args = parse_args()
    if args.status and args.status not in STATUSES:
        print(f"未知状态: {args.status}", file=sys.stderr)
        return 1
    conn = open_database(args)
    try:
        with conn:
            items = list_feedback(conn, args)
    except sqlite3.OperationalError as err:
        report_sqlite(err)
        return 1

    if args.json:
        print(json.dumps({"items": items}, ensure_ascii=False))
        return 0

    print(conn.label)
    if not items:
        print("没有回报")
        return 0
    for item in items:
        target = item["target"] or "-"
        content = item["content"].replace("\n", " ")
        if len(content) > 80:
            content = content[:80] + "..."
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(item["created_at"] / 1000))
        print(f"- {item['id']} {item['login']} [{target}] {item['status']} {when} {content}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="列出远程库里的回报")
    add_db_args(parser)
    parser.add_argument("--status", help="只看一种状态: new, triaged, done, wontfix")
    parser.add_argument("--login", help="只看这个登录名的回报")
    parser.add_argument("--user-id", help="只看这个用户 id 的回报")
    parser.add_argument("--json", action="store_true", help="把结果 JSON 打到标准输出")
    return parser.parse_args()


def list_feedback(conn, args) -> list[dict]:
    user = None
    if args.login or args.user_id:
        user = resolve_user(conn, args.login, args.user_id)
    sql = """
        SELECT f.id, f.target, f.content, f.status, f.created_at, u.login
        FROM feedback f JOIN users u ON u.id = f.user_id
        WHERE 1 = 1
    """
    params: list = []
    if args.status:
        sql += " AND f.status = ?"
        params.append(args.status)
    if user is not None:
        sql += " AND f.user_id = ?"
        params.append(user["id"])
    sql += " ORDER BY f.created_at DESC LIMIT ?"
    params.append(50 if user is not None else 200)
    rows = conn.execute(sql, params).fetchall()
    return [
        {
            "id": row["id"],
            "target": row["target"],
            "content": row["content"],
            "status": row["status"],
            "created_at": row["created_at"],
            "login": row["login"],
        }
        for row in rows
    ]


if __name__ == "__main__":
    sys.exit(main())
