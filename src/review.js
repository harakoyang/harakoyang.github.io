import { json } from "./http.js";
import { requireAdmin } from "./auth.js";
import { sendEmail } from "./mail.js";

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
  if (!env.REVIEW_EMAIL_TO) {
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

  const ok = await sendEmail(env, {
    to: env.REVIEW_EMAIL_TO,
    subject: `观测站反馈周报：${snapshot.newInWindow} 条新增 / ${snapshot.pendingTotal} 条待处理`,
    html: `<table border="1" cellpadding="6"><tr><th>用户</th><th>目标</th><th>内容</th></tr>${rows}</table>`,
  });
  if (!ok) console.error("weekly review: sendEmail failed");
}

export async function latestSnapshot(request, env) {
  await requireAdmin(request, env);
  const snapshot = await env.SESSIONS.get(SNAPSHOT_KEY, "json");
  return json({ snapshot });
}

// cron 一周只跑一次，改完汇总逻辑要等到下周一才知道对不对，所以留一个立即重算的
// 入口。它跑的就是 scheduled() 调的同一个函数，会照常写快照、照常发信。
export async function runNow(request, env) {
  await requireAdmin(request, env);
  return json({ snapshot: await runWeeklyReview(env) });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
