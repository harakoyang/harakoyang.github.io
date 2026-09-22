import { HttpError, json } from "./http.js";
import * as auth from "./auth.js";
import * as feedback from "./feedback.js";
import { runWeeklyReview, latestSnapshot } from "./review.js";

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

  if (method === "GET" && path === "/api/auth/login") return auth.login(request, env);
  if (method === "GET" && path === "/api/auth/callback") return auth.callback(request, env, url);
  if (method === "POST" && path === "/api/auth/logout") return auth.logout(request, env);
  if (method === "GET" && path === "/api/me") return auth.me(request, env);

  if (path === "/api/feedback") {
    if (method === "POST") return feedback.create(request, env);
    if (method === "GET") return feedback.listMine(request, env);
  }

  if (method === "GET" && path === "/api/admin/feedback") return feedback.listAll(request, env, url);
  if (method === "GET" && path === "/api/admin/review") return latestSnapshot(request, env);

  const statusMatch = path.match(/^\/api\/admin\/feedback\/(\d+)$/);
  if (method === "PATCH" && statusMatch) {
    return feedback.updateStatus(request, env, Number(statusMatch[1]));
  }

  throw new HttpError(404, "no such endpoint");
}
