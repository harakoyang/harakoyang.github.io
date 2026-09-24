import { HttpError, json, readCookie, cookieHeader, clearCookieHeader } from "./http.js";

const SESSION_TTL = 60 * 60 * 24 * 30;
const STATE_TTL = 60 * 10;

// 两个 GitHub 请求都必须带 UA：Worker 的出口是 Cloudflare 的共享 IP，GitHub 会把
// 共享 IP 上没有 UA 的请求当爬虫，api.github.com 直接回 403，token 交换端点回 429。
const USER_AGENT = "harako-site";

// state 和 provider 都存 cookie 而不是 KV：KV 免费版每天只有 1000 次写入，每次登录尝试都
// 写一条 state 会让失败的、被放弃的登录也吃配额。cookie 由浏览器自己带回来，
// 校验只要比对值相等，服务端零存储。
function stateCookie(value, maxAge) {
  return cookieHeader("oauth_state", value, maxAge);
}
function providerCookie(value, maxAge) {
  return cookieHeader("oauth_provider", value, maxAge);
}

// redirect_uri 跟着请求自己的 hostname 走，而不是写死 SITE_URL：正式域名切过来
// 之前要先在 workers.dev 上验一轮，写死的话每换一个地址都得改配置重新 deploy。
// 只认 SITE_URL、workers.dev 预览域和本地，其余一律退回 SITE_URL，免得伪造的
// Host 头把授权码导去别的站。
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

function trustedOrigin(request, env) {
  const url = new URL(request.url);
  const trusted =
    url.hostname === new URL(env.SITE_URL).hostname ||
    url.hostname.endsWith(".workers.dev") ||
    LOCAL_HOSTS.includes(url.hostname);
  return trusted ? url.origin : env.SITE_URL;
}

// legacy=true 时返回无后缀的 /api/auth/callback（兼容现有 GitHub OAuth App 注册），
// 否则返回 /api/auth/callback/:provider。
function redirectUri(request, env, provider, legacy) {
  const base = trustedOrigin(request, env);
  return legacy ? `${base}/api/auth/callback` : `${base}/api/auth/callback/${provider}`;
}

// ---------------------------------------------------------------------------
// Provider 配置表
// ---------------------------------------------------------------------------

const PROVIDERS = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    scope: "read:user user:email",
    clientIdVar: "GITHUB_CLIENT_ID",
    clientSecretVar: "GITHUB_CLIENT_SECRET",
    fetchProfile: fetchGithubProfile,
    // GitHub OAuth App 只注册一个 callback，子路径放行规则实测不可靠
    // （dev 新 App 用子路径直接被拒），授权与换 token 统一走无后缀精确地址。
    legacyCallback: true,
  },
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    clientIdVar: "GOOGLE_CLIENT_ID",
    clientSecretVar: "GOOGLE_CLIENT_SECRET",
    fetchProfile: fetchGoogleProfile,
  },
};

// ---------------------------------------------------------------------------
// Login —— 构造 authorize URL，设 state + provider cookie，302 跳转
// ---------------------------------------------------------------------------

export function login(request, env, provider = "github", opts = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new HttpError(400, "unknown provider");

  const ri = redirectUri(request, env, provider, opts.legacy || cfg.legacyCallback);
  const state = crypto.randomUUID();

  let location;
  const clientId = env[cfg.clientIdVar];
  if (!clientId) throw new HttpError(500, `${cfg.clientIdVar} not configured`);
  const target = new URL(cfg.authorizeUrl);
  target.searchParams.set("client_id", clientId);
  target.searchParams.set("redirect_uri", ri);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", cfg.scope);
  target.searchParams.set("state", state);
  location = target.toString();

  const headers = new Headers({ location });
  headers.append("set-cookie", stateCookie(state, STATE_TTL));
  headers.append("set-cookie", providerCookie(provider, STATE_TTL));
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------
// Callback —— 校验 state + provider cookie，换 token，写 session
// ---------------------------------------------------------------------------

export async function callback(request, env, url, provider = "github") {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new HttpError(400, "unknown provider");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = readCookie(request, "__Host-oauth_state");
  const expectedProvider = readCookie(request, "__Host-oauth_provider");

  if (!code || !state || !expected || state !== expected) {
    throw new HttpError(400, "invalid oauth state");
  }
  // 防 provider 串号：login 时写下的 provider cookie 必须和回调路径上的 provider 一致
  if (expectedProvider && expectedProvider !== provider) {
    throw new HttpError(400, "provider mismatch");
  }

  const profile = await cfg.fetchProfile(code, request, env);
  const userId = await upsertUser(env, profile);
  const sid = crypto.randomUUID();

  await env.SESSIONS.put(`sess:${sid}`, JSON.stringify({ uid: userId }), {
    expirationTtl: SESSION_TTL,
  });

  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", clearCookieHeader("oauth_state"));
  headers.append("set-cookie", clearCookieHeader("oauth_provider"));
  headers.append("set-cookie", cookieHeader("sess", sid, SESSION_TTL));
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------
// GitHub fetchProfile
// ---------------------------------------------------------------------------

async function fetchGithubProfile(code, request, env) {
  const ri = redirectUri(request, env, "github", true); // legacy: 无后缀
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
      redirect_uri: ri,
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

// ---------------------------------------------------------------------------
// Google fetchProfile
// ---------------------------------------------------------------------------

async function fetchGoogleProfile(code, request, env) {
  const ri = redirectUri(request, env, "google", false);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: ri,
    }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) {
    const detail = [token.error, token.error_description].filter(Boolean).join(": ");
    throw new HttpError(502, detail || `token exchange failed (HTTP ${tokenRes.status})`);
  }

  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const u = await userRes.json();
  if (!u.sub) throw new HttpError(502, "google userinfo missing sub");

  return {
    provider: "google",
    providerUid: u.sub,
    login: u.name || u.email || u.sub,
    email: u.email || null,
    avatarUrl: u.picture || null,
  };
}

// ---------------------------------------------------------------------------
// 首个注册者自动成为 admin，省掉「部署完还要手动改一行数据库」这步。
// 之后再注册的都是普通用户。
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Session 管理（provider 无关，不改动）
// ---------------------------------------------------------------------------

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

// 前端拉取这个列表，按实际配置渲染对应按钮，未配置的 provider 不显示。
export function providers(request, env) {
  const list = [];
  if (env.GITHUB_CLIENT_ID) list.push("github");
  if (env.GOOGLE_CLIENT_ID) list.push("google");
  return json({ providers: list });
}
