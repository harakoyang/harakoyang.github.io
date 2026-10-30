"""打开回报库。默认调用 Cloudflare D1 API。--db 才打开一个本地 SQLite 文件。"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def add_db_args(parser) -> None:
    parser.add_argument("--env", help="配置环境名，例如 preview。省略时远程库是 harako")
    parser.add_argument("--db", help="改为打开这个本地 SQLite 文件")


def open_database(args):
    load_dev_vars(ROOT / ".dev.vars")
    load_cloudflare_token()
    if args.db:
        path = Path(args.db)
        if not path.is_file():
            print(f"找不到本地库: {path}", file=sys.stderr)
            raise SystemExit(1)
        return SqliteSession(path)
    name, database_id = database_binding(args.env)
    return RemoteSession(name, database_id)


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def report_sqlite(err: sqlite3.OperationalError) -> None:
    print(f"读写回报库失败: {err}", file=sys.stderr)
    message = str(err)
    if "CLOUDFLARE_API_TOKEN" in message:
        print("把令牌写进根目录的 cloudflare-token.txt，等号后面填写 CLOUDFLARE_API_TOKEN。", file=sys.stderr)
    elif "CLOUDFLARE_ACCOUNT_ID" in message:
        print("这个令牌能访问多个账号，请在 cloudflare-token.txt 里写上 CLOUDFLARE_ACCOUNT_ID。", file=sys.stderr)
    elif "no such table" in message:
        print("远程库还没有这张表。", file=sys.stderr)
    elif "locked" in message:
        print("数据库文件正被占用。", file=sys.stderr)


def resolve_user(conn: sqlite3.Connection, login: str | None, user_id: str | None) -> sqlite3.Row:
    if user_id:
        row = conn.execute(
            "SELECT id, provider, login FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            raise SystemExit(f"找不到用户: {user_id}")
        return row
    if not login:
        raise SystemExit("请指定 --login 或 --user-id")
    rows = conn.execute(
        "SELECT id, provider, login FROM users WHERE login = ? ORDER BY created_at",
        (login,),
    ).fetchall()
    if not rows:
        raise SystemExit(f"找不到用户: {login}")
    if len(rows) > 1:
        detail = ", ".join(f"{row['id']} ({row['provider']})" for row in rows)
        raise SystemExit(f"登录名 {login} 对应多个账号: {detail}。请改用 --user-id")
    return rows[0]


def load_wrangler() -> dict:
    text = strip_jsonc((ROOT / "wrangler.jsonc").read_text(encoding="utf-8"))
    return json.loads(text)


def strip_jsonc(text: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(text):
        char = text[i]
        if char == '"':
            out.append(char)
            i += 1
            while i < len(text):
                out.append(text[i])
                if text[i] == "\\":
                    if i + 1 < len(text):
                        i += 1
                        out.append(text[i])
                    i += 1
                    continue
                if text[i] == '"':
                    i += 1
                    break
                i += 1
            continue
        if char == "/" and i + 1 < len(text) and text[i + 1] == "/":
            newline = text.find("\n", i)
            i = len(text) if newline == -1 else newline
            continue
        out.append(char)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def database_binding(env_name: str | None) -> tuple[str, str]:
    config = load_wrangler()
    section = config
    if env_name:
        section = config.get("env", {}).get(env_name)
        if not section:
            raise SystemExit(f"wrangler.jsonc 里没有 env.{env_name}")
    databases = section.get("d1_databases") or []
    if not databases:
        raise SystemExit("wrangler.jsonc 里没有 d1_databases")
    name = databases[0].get("database_name")
    database_id = databases[0].get("database_id")
    if not name or not database_id:
        raise SystemExit("d1_databases 缺少 database_name 或 database_id")
    return name, database_id


class SqliteSession:
    def __init__(self, path: Path):
        self.label = f"数据库: {path}"
        self._conn = connect(path)

    def execute(self, sql, params=()):
        return self._conn.execute(sql, params)

    def commit(self):
        self._conn.commit()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
        finally:
            self._conn.close()
        return False


class RemoteSession:
    def __init__(self, database_name: str, database_id: str):
        self.label = f"远程库: {database_name}"
        self._database_id = database_id

    def execute(self, sql, params=()):
        result = d1_query(self._database_id, sql, params)
        meta = result.get("meta") or {}
        changes = meta.get("changes", meta.get("rows_written", 0))
        last_row_id = meta.get("last_row_id", meta.get("lastRowId", 0))
        return RemoteCursor(result.get("results") or [], changes, last_row_id)

    def commit(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class RemoteCursor:
    def __init__(self, rows, changes, last_row_id):
        self._rows = rows
        self.rowcount = changes
        self.lastrowid = last_row_id

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


_ACCOUNT_ID = ""


def d1_query(database_id: str, sql: str, params) -> dict:
    payload = cf_api(
        "POST",
        f"/accounts/{cloudflare_account_id()}/d1/database/{database_id}/query",
        {"sql": sql, "params": [json_param(value) for value in params]},
    )
    result = payload.get("result")
    if isinstance(result, list):
        if not result:
            raise sqlite3.OperationalError("远程库没有返回结果")
        result = result[0]
    if not isinstance(result, dict):
        raise sqlite3.OperationalError("远程库返回了无法识别的结果")
    if result.get("success") is False:
        raise sqlite3.OperationalError(result.get("error") or "远程查询失败")
    return result


def json_param(value):
    if isinstance(value, bool):
        return 1 if value else 0
    return value


def cloudflare_account_id() -> str:
    global _ACCOUNT_ID
    if _ACCOUNT_ID:
        return _ACCOUNT_ID
    explicit = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if explicit:
        _ACCOUNT_ID = explicit
        return _ACCOUNT_ID
    payload = cf_api("GET", "/accounts?per_page=50")
    accounts = payload.get("result") or []
    if len(accounts) == 1 and accounts[0].get("id"):
        _ACCOUNT_ID = accounts[0]["id"]
        return _ACCOUNT_ID
    if not accounts:
        raise sqlite3.OperationalError("这个令牌看不到任何 Cloudflare 账号")
    raise sqlite3.OperationalError("请在 cloudflare-token.txt 里设置 CLOUDFLARE_ACCOUNT_ID")


def cf_api(method: str, path: str, body=None) -> dict:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        raise sqlite3.OperationalError("缺少 CLOUDFLARE_API_TOKEN，请填写 cloudflare-token.txt")
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        "https://api.cloudflare.com/client/v4" + path,
        data=data,
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError as err:
        raw = err.read().decode(errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            raise sqlite3.OperationalError(f"Cloudflare API {err.code}") from err
    except urllib.error.URLError as err:
        raise sqlite3.OperationalError(f"连不上 Cloudflare API: {err.reason}") from err
    if not payload.get("success"):
        errors = payload.get("errors") or []
        message = "; ".join(
            item.get("message", str(item)) for item in errors
        ) or "Cloudflare API 调用失败"
        raise sqlite3.OperationalError(message)
    return payload


def load_dev_vars(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


TOKEN_FILE = ROOT / "cloudflare-token.txt"
CLOUDFLARE_KEYS = {"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"}


def load_cloudflare_token() -> None:
    if not TOKEN_FILE.is_file():
        return
    for raw in TOKEN_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            os.environ["CLOUDFLARE_API_TOKEN"] = line.strip('"').strip("'")
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key in CLOUDFLARE_KEYS and value:
            os.environ[key] = value
