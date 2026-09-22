import { HttpError, json, readCookie, cookieHeader, clearCookieHeader } from "./http.js";

const SESSION_TTL = 60 * 60 * 24 * 30;
const STATE_TTL = 60 * 10;
const GITHUB_SCOPE = "read:user user:email";

// 两个 GitHub 请求都必须带 UA：Worker 的出口是 Cloudflare 的共享 IP，GitHub 会把
// 共享 IP 上没有 UA 的请求当爬虫，api.github.com 直接回 403，token 交换端点回 429。
const USER_AGENT = "harako-site";

// state 存 cookie 而不是 KV：KV 免费版每天只有 1000 次写入，每次登录尝试都
// 写一条 state 会让失败的、被放弃的登录也吃配额。cookie 由浏览器自己带回来，
// 校验只要比对值相等，服务端零存储。
function stateCookie(value, maxAge) {
  return cookieHeader("oauth_state", value, maxAge);
}

// redirect_uri 跟着请求自己的 hostname 走，而不是写死 SITE_URL：正式域名切过来
// 之前要先在 workers.dev 上验一轮，写死的话每换一个地址都得改配置重新 deploy。
// 只认 SITE_URL、workers.dev 预览域和本地，其余一律退回 SITE_URL，免得伪造的
// Host 头把授权码导去别的站。
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

function redirectUri(request, env) {
  const url = new URL(request.url);
  const trusted =
    url.hostname === new URL(env.SITE_URL).hostname ||
    url.hostname.endsWith(".workers.dev") ||
    LOCAL_HOSTS.includes(url.hostname);
  return `${trusted ? url.origin : env.SITE_URL}/api/auth/callback`;
}

export function login(request, env) {
  if (!env.GITHUB_CLIENT_ID) throw new HttpError(500, "GITHUB_CLIENT_ID not configured");

  const state = crypto.randomUUID();
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri(request, env));
  target.searchParams.set("scope", GITHUB_SCOPE);
  target.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "set-cookie": stateCookie(state, STATE_TTL),
    },
  });
}

export async function callback(request, env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = readCookie(request, "__Host-oauth_state");

  if (!code || !state || !expected || state !== expected) {
    throw new HttpError(400, "invalid oauth state");
  }

  const profile = await fetchGithubProfile(code, request, env);
  const userId = await upsertUser(env, profile);
  const sid = crypto.randomUUID();

  await env.SESSIONS.put(`sess:${sid}`, JSON.stringify({ uid: userId }), {
    expirationTtl: SESSION_TTL,
  });

  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", clearCookieHeader("oauth_state"));
  headers.append("set-cookie", cookieHeader("sess", sid, SESSION_TTL));
  return new Response(null, { status: 302, headers });
}

async function fetchGithubProfile(code, request, env) {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(request, env),
    }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) {
    // GitHub 对凭据错误、回调地址未登记、授权码过期这几种情况回的都是 200 + 一个
    // error 码，error_description 不保证有。只报 description 的话这几种原因看起来
    // 一模一样，没法判断该去改 secret 还是改 Redirect URI，所以把 error 码带上。
    const detail = [token.error, token.error_description].filter(Boolean).join(": ");
    throw new HttpError(502, detail || `token exchange failed (HTTP ${tokenRes.status})`);
  }

  const api = (path) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token.access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
      },
    }).then((r) => r.json());

  const user = await api("/user");
  let email = user.email;
  if (!email) {
    const emails = await api("/user/emails");
    const primary = Array.isArray(emails) && emails.find((e) => e.primary && e.verified);
    email = primary ? primary.email : null;
  }

  return {
    provider: "github",
    providerUid: String(user.id),
    login: user.login,
    email,
    avatarUrl: user.avatar_url,
  };
}

// 首个注册者自动成为 admin，省掉「部署完还要手动改一行数据库」这步。
// 之后再注册的都是普通用户。
async function upsertUser(env, profile) {
  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE provider = ? AND provider_uid = ?"
  )
    .bind(profile.provider, profile.providerUid)
    .first();

  if (existing) {
    await env.DB.prepare("UPDATE users SET login = ?, email = ?, avatar_url = ? WHERE id = ?")
      .bind(profile.login, profile.email, profile.avatarUrl, existing.id)
      .run();
    return existing.id;
  }

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, provider, provider_uid, login, email, avatar_url, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      profile.provider,
      profile.providerUid,
      profile.login,
      profile.email,
      profile.avatarUrl,
      count.n === 0 ? "admin" : "user",
      Date.now()
    )
    .run();
  return id;
}

export async function logout(request, env) {
  const sid = readCookie(request, "__Host-sess");
  if (sid) await env.SESSIONS.delete(`sess:${sid}`);
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearCookieHeader("sess") },
  });
}

export async function currentUser(request, env) {
  const sid = readCookie(request, "__Host-sess");
  if (!sid) return null;

  const raw = await env.SESSIONS.get(`sess:${sid}`, "json");
  if (!raw) return null;

  return env.DB.prepare("SELECT id, login, email, avatar_url, role FROM users WHERE id = ?")
    .bind(raw.uid)
    .first();
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "not signed in");
  return user;
}

export async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (user.role !== "admin") throw new HttpError(403, "admin only");
  return user;
}

export async function me(request, env) {
  return json({ user: await currentUser(request, env) });
}
