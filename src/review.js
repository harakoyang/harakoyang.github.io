import { json } from "./http.js";
import { requireAdmin } from "./auth.js";

const SNAPSHOT_KEY = "review:latest";

export async function runWeeklyReview(env) {
  const windowDays = Number(env.REVIEW_WINDOW_DAYS) || 7;
  const since = Date.now() - windowDays * 86400_000;

  const { results } = await env.DB.prepare(
    `SELECT f.id, f.target, f.content, f.created_at, u.login
     FROM feedback f JOIN users u ON u.id = f.user_id
     WHERE f.status = 'new' AND f.created_at > ?
     ORDER BY f.created_at DESC LIMIT 100`
  )
    .bind(since)
    .all();

  const backlog = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'"
  ).first();

  const snapshot = {
    generatedAt: Date.now(),
    windowDays,
    pendingTotal: backlog.n,
    newInWindow: results.length,
    items: results,
  };

  // 快照落 KV，管理页一次 KV 读就能出结果，不用每次打开都去 D1 跑联表查询。
  await env.SESSIONS.put(SNAPSHOT_KEY, JSON.stringify(snapshot));

  if (results.length) await sendDigest(env, snapshot);
  return snapshot;
}

async function sendDigest(env, snapshot) {
  if (!env.RESEND_API_KEY || !env.REVIEW_EMAIL_TO || !env.REVIEW_EMAIL_FROM) {
    console.log(`weekly review: ${snapshot.newInWindow} new, ${snapshot.pendingTotal} pending`);
    return;
  }

  const rows = snapshot.items
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.login)}</td><td>${escapeHtml(i.target || "-")}</td>` +
        `<td>${escapeHtml(i.content)}</td></tr>`
    )
    .join("");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.REVIEW_EMAIL_FROM,
      to: env.REVIEW_EMAIL_TO,
      subject: `观测站反馈周报：${snapshot.newInWindow} 条新增 / ${snapshot.pendingTotal} 条待处理`,
      html: `<table border="1" cellpadding="6"><tr><th>用户</th><th>目标</th><th>内容</th></tr>${rows}</table>`,
    }),
  });

  // cron 失败只会进 Past Events 列表，没人盯着，所以把状态码打进日志。
  if (!res.ok) console.error(`resend failed: ${res.status} ${await res.text()}`);
}

export async function latestSnapshot(request, env) {
  await requireAdmin(request, env);
  const snapshot = await env.SESSIONS.get(SNAPSHOT_KEY, "json");
  return json({ snapshot });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
