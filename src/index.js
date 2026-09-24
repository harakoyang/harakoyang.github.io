import { HttpError, json } from "./http.js";
import * as auth from "./auth.js";
import * as feedback from "./feedback.js";
import { runWeeklyReview, latestSnapshot, runNow } from "./review.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 静态资源优先命中，走到这里的都是 public/ 下没有对应文件的路径。
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
      console.error(err);
      return json({ error: "internal error" }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWeeklyReview(env));
  },
};

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // Legacy bare path 保持指向 github，兼容现有 OAuth App 注册的无后缀 callback URL
  if (method === "GET" && path === "/api/auth/login") return auth.login(request, env, "github", { legacy: true });
  if (method === "GET" && path === "/api/auth/callback") return auth.callback(request, env, url, "github");

  // Provider-specific 路径：白名单正则避免路径穿越
  const loginMatch = path.match(/^\/api\/auth\/login\/(github|google)$/);
  if (method === "GET" && loginMatch) return auth.login(request, env, loginMatch[1]);

  const callbackMatch = path.match(/^\/api\/auth\/callback\/(github|google)$/);
  if (method === "GET" && callbackMatch) return auth.callback(request, env, url, callbackMatch[1]);

  // 前端拉取已配置的 provider 列表，按需显示登录按钮
  if (method === "GET" && path === "/api/auth/providers") return auth.providers(request, env);
  if (method === "POST" && path === "/api/auth/logout") return auth.logout(request, env);
  if (method === "GET" && path === "/api/me") return auth.me(request, env);

  if (path === "/api/feedback") {
    if (method === "POST") return feedback.create(request, env);
    if (method === "GET") return feedback.listMine(request, env);
  }

  if (method === "GET" && path === "/api/admin/feedback") return feedback.listAll(request, env, url);
  if (path === "/api/admin/review") {
    if (method === "GET") return latestSnapshot(request, env);
    if (method === "POST") return runNow(request, env);
  }

  const statusMatch = path.match(/^\/api\/admin\/feedback\/(\d+)$/);
  if (method === "PATCH" && statusMatch) {
    return feedback.updateStatus(request, env, Number(statusMatch[1]));
  }

  throw new HttpError(404, "no such endpoint");
}
