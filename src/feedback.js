import { HttpError, json } from "./http.js";
import { requireUser, requireAdmin } from "./auth.js";

const MAX_CONTENT = 2000;
const HOURLY_QUOTA = 5;
const VALID_STATUS = ["new", "triaged", "done", "wontfix"];

export async function create(request, env) {
  const user = await requireUser(request, env);
  const body = await request.json().catch(() => null);
  if (!body) throw new HttpError(400, "expected json body");

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) throw new HttpError(400, "content is required");
  if (content.length > MAX_CONTENT) throw new HttpError(400, `content exceeds ${MAX_CONTENT} chars`);

  // target 指反馈针对的目标，如 "M42" 或 "page:catalogue"，允许为空。
  const target = typeof body.target === "string" ? body.target.slice(0, 64) : null;

  const now = Date.now();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?"
  )
    .bind(user.id, now - 3600_000)
    .first();
  if (recent.n >= HOURLY_QUOTA) {
    // 滾動視窗：配額在「視窗內最早一條」滿一小時滑出視窗後恢復。
    // 倒數第 HOURLY_QUOTA 條（OFFSET 配額-1）就是目前擋門的那條。
    const blocking = await env.DB.prepare(
      `SELECT created_at FROM feedback WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 1 OFFSET ?`
    )
      .bind(user.id, HOURLY_QUOTA - 1)
      .first();
    const retryAfter = blocking
      ? Math.max(1, Math.ceil((blocking.created_at + 3600_000 - now) / 1000))
      : 3600;
    throw new HttpError(429, "too many submissions, try later", { retry_after: retryAfter });
  }

  const row = await env.DB.prepare(
    "INSERT INTO feedback (user_id, target, content, created_at) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(user.id, target, content, Date.now())
    .first();

  return json({ id: row.id }, { status: 201 });
}

export async function listMine(request, env) {
  const user = await requireUser(request, env);
  const { results } = await env.DB.prepare(
    `SELECT id, target, content, status, created_at
     FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  )
    .bind(user.id)
    .all();
  return json({ items: results });
}

export async function listAll(request, env, url) {
  await requireAdmin(request, env);
  const status = url.searchParams.get("status") || "new";
  if (!VALID_STATUS.includes(status)) throw new HttpError(400, "unknown status");

  const { results } = await env.DB.prepare(
    `SELECT f.id, f.target, f.content, f.status, f.created_at, u.login
     FROM feedback f JOIN users u ON u.id = f.user_id
     WHERE f.status = ? ORDER BY f.created_at DESC LIMIT 200`
  )
    .bind(status)
    .all();
  return json({ items: results });
}

export async function updateStatus(request, env, id) {
  await requireAdmin(request, env);
  const body = await request.json().catch(() => null);
  const status = body && body.status;
  if (!VALID_STATUS.includes(status)) throw new HttpError(400, "unknown status");

  const result = await env.DB.prepare(
    "UPDATE feedback SET status = ?, reviewed_at = ? WHERE id = ?"
  )
    .bind(status, Date.now(), id)
    .run();
  if (!result.meta.changes) throw new HttpError(404, "feedback not found");

  return json({ id, status });
}
