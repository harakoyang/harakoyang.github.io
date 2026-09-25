import { HttpError, json, readCookie, cookieHeader, clearCookieHeader } from "./http.js";
import { sendEmail } from "./mail.js";

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
  const sid = await issueSession(env, userId);

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
// Email + password —— 站內自行註冊，不依賴任何第三方 OAuth 設定
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const LOGIN_MAX = 40;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const textEncoder = new TextEncoder();

function bufToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function derivePasswordBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      256
    )
  );
}

// 儲存格式：pbkdf2$<迭代數>$<salt b64>$<hash b64>。迭代數寫進字串，
// 以後要調高強度可以按帳號逐個升級，不用一次清掉所有密碼。
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derivePasswordBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bufToB64(salt)}$${bufToB64(bits)}`;
}

async function verifyPassword(password, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  let salt;
  let expected;
  try {
    salt = b64ToBuf(parts[2]);
    expected = b64ToBuf(parts[3]);
  } catch {
    return false;
  }
  const actual = await derivePasswordBits(password, salt, Number(parts[1]));
  if (actual.length !== expected.length) return false;
  // 常數時間比較，避免逐位元組洩漏密碼雜湊內容。
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function readCredentials(request) {
  const body = await request.json().catch(() => null);
  if (!body) throw new HttpError(400, "expected json body");
  return {
    login: typeof body.login === "string" ? body.login.trim() : "",
    email: typeof body.email === "string" ? body.email.trim().toLowerCase() : "",
    password: typeof body.password === "string" ? body.password : "",
  };
}

// ---------------------------------------------------------------------------
// 限流：KV 固定窗口（rl:<prefix>:<窗口序号>），TTL 两个窗口让旧 key 自动过期，
// 免建表免清理。窗口交界处最多放行两倍配额，对注册灌水、密码爆破、
// 邮件轰炸这类滥用场景足够。KV 读写在 SESSIONS 命名空间，和会话共存。
// ---------------------------------------------------------------------------

const RL_WINDOW_S = 3600;

function rlBucket() {
  return Math.floor(Date.now() / (RL_WINDOW_S * 1000));
}

async function rlCount(env, prefix) {
  return (await env.SESSIONS.get(`rl:${prefix}:${rlBucket()}`, "json")) || 0;
}

async function rlBump(env, prefix) {
  await env.SESSIONS.put(`rl:${prefix}:${rlBucket()}`, JSON.stringify((await rlCount(env, prefix)) + 1), {
    expirationTtl: RL_WINDOW_S * 2,
  });
}

// 只查不计：由调用方在真正产生副作用后自行 rlBump（如重设密码是寄信成功才计次）。
async function rlCheck(env, prefix, limit) {
  if ((await rlCount(env, prefix)) >= limit) {
    const retryAfter = Math.max(1, (rlBucket() + 1) * RL_WINDOW_S - Math.floor(Date.now() / 1000));
    throw new HttpError(429, "too many requests, try later", { retry_after: retryAfter });
  }
}

// 尝试即计次：用于注册与登录，失败/成功都占配额。
async function rlGuard(env, prefix, limit) {
  await rlCheck(env, prefix, limit);
  await rlBump(env, prefix);
}

async function rlClear(env, prefix) {
  await env.SESSIONS.delete(`rl:${prefix}:${rlBucket()}`);
}

// 本地 wrangler dev 没有 cf-connecting-ip，全部归到同一个桶即可。
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "local";
}

export async function register(request, env) {
  const { login, email, password } = await readCredentials(request);

  if (!login) throw new HttpError(400, "login is required");
  if (login.length > LOGIN_MAX) throw new HttpError(400, `login exceeds ${LOGIN_MAX} chars`);
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }
  if (password.length < PASSWORD_MIN) {
    throw new HttpError(400, `password must be at least ${PASSWORD_MIN} characters`);
  }
  if (password.length > PASSWORD_MAX) {
    throw new HttpError(400, `password must be at most ${PASSWORD_MAX} characters`);
  }

  // 格式校验通过后才计次：用户改输入不耗配额，但批量灌水会被挡下。
  await rlGuard(env, `reg:${clientIp(request)}`, 10);

  const dup = await env.DB.prepare(
    "SELECT id FROM users WHERE provider = 'email' AND provider_uid = ?"
  )
    .bind(email)
    .first();
  if (dup) throw new HttpError(409, "email already registered");

  // 與 OAuth 路徑一致：第一個註冊者（不分 provider）自動成為 admin。
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users
       (id, provider, provider_uid, login, email, avatar_url, role, created_at, password_hash)
     VALUES (?, 'email', ?, ?, ?, NULL, ?, ?, ?)`
  )
    .bind(id, email, login, email, count.n === 0 ? "admin" : "user", Date.now(), await hashPassword(password))
    .run();

  const user = await userById(env, id);
  const sid = await issueSession(env, id);
  return json({ user }, { headers: { "set-cookie": cookieHeader("sess", sid, SESSION_TTL) } });
}

export async function passwordLogin(request, env) {
  const { email, password } = await readCredentials(request);

  // 双维度：per-email 挡单账号爆破，per-IP 挡同一个密码喷多个账号。
  if (email) await rlGuard(env, `login:${email}`, 10);
  await rlGuard(env, `loginip:${clientIp(request)}`, 30);

  const row = await env.DB.prepare(
    "SELECT id, password_hash FROM users WHERE provider = 'email' AND provider_uid = ?"
  )
    .bind(email)
    .first();

  // 信箱不存在與密碼錯誤回同一則訊息，不幫攻擊者列舉站上已註冊的信箱。
  // 信箱格式在這裡不另外報錯：查無此人自然走同一個 401。
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new HttpError(401, "invalid email or password");
  }

  const user = await userById(env, row.id);
  const sid = await issueSession(env, row.id);
  return json({ user }, { headers: { "set-cookie": cookieHeader("sess", sid, SESSION_TTL) } });
}

// ---------------------------------------------------------------------------
// 忘記密碼：密碼只存 PBKDF2 雜湊，無法還原，所以是生成一組臨時密碼寄過去。
// 顺序刻意安排成「先寄信、成功才改哈希」：寄送失敗時舊密碼仍然有效，
// 使用者不會因為一封信沒寄到就被鎖在門外。
// ---------------------------------------------------------------------------

// 避開 0/O、1/l/I 這類容易看錯的字元，從信件照抄時少踩坑。
const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateTempPassword() {
  const out = [];
  while (out.length < 10) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0];
    // 54 * 4 = 216，拒絕 >= 216 的位元組，避免取模分佈不均。
    if (b < 216) out.push(TEMP_ALPHABET[b % TEMP_ALPHABET.length]);
  }
  return out.join("");
}

export async function resetPassword(request, env) {
  const { email } = await readCredentials(request);
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }

  // IP 維度每次嘗試都計，擋住「拿別人信箱批量觸發重設」的騷擾；
  // 信箱維度只在真的寄出信時才計（下面 rlBump），服務異常時重試不耗配額。
  await rlGuard(env, `resetip:${clientIp(request)}`, 10);
  await rlCheck(env, `reset:${email}`, 3);

  const row = await env.DB.prepare(
    "SELECT id FROM users WHERE provider = 'email' AND provider_uid = ?"
  )
    .bind(email)
    .first();

  // 查無此信箱也回一樣的成功訊息，回應內容不得洩漏該信箱有沒有註冊過。
  if (!row) return json({ ok: true });

  const tempPassword = generateTempPassword();
  const ok = await sendEmail(env, {
    to: email,
    subject: "密碼重設 — 天体観測「Tentai Kansoku」Catalogue",
    text:
      `你的新密碼是：${tempPassword}\n\n` +
      "舊密碼已失效，請用這組新密碼登入。如果這不是你本人的操作，" +
      "表示有人誤填了你的信箱；只有你收得到這封信，帳號依然安全，" +
      "可再重設一次取得另一組密碼。",
    html:
      `<p>你的新密碼是：</p>` +
      `<p style="font-size:20px;font-weight:bold;letter-spacing:2px;">${tempPassword}</p>` +
      `<p>舊密碼已失效，請用這組新密碼登入。</p>` +
      `<p style="color:#888;">如果這不是你本人的操作，表示有人誤填了你的信箱；` +
      `只有你收得到這封信，帳號依然安全，可再重設一次取得另一組密碼。</p>`,
  });
  if (!ok) {
    // RESEND_API_KEY 未設定或 Resend 故障：密碼維持不變，使用者可稍後重試。
    throw new HttpError(502, "email send failed, try later");
  }

  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(await hashPassword(tempPassword), row.id)
    .run();

  await rlBump(env, `reset:${email}`);
  // 剛拿到新密碼的人不該被重設前的登入失敗次數擋住，順手清零。
  await rlClear(env, `login:${email}`);

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Session 管理（provider 无关，不改动）
// ---------------------------------------------------------------------------

// OAuth callback 與信箱註冊/登入三條路共用：session 只存 users.id，
// 其餘資料一律查庫，改暱稱或頭像後下一請求即生效。
async function issueSession(env, userId) {
  const sid = crypto.randomUUID();
  await env.SESSIONS.put(`sess:${sid}`, JSON.stringify({ uid: userId }), {
    expirationTtl: SESSION_TTL,
  });
  return sid;
}

async function userById(env, id) {
  return env.DB.prepare("SELECT id, login, email, avatar_url, role FROM users WHERE id = ?")
    .bind(id)
    .first();
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

// 前端拉取这个列表，按实际配置渲染对应按钮，未配置的 provider 不显示。
// email 是站內自辦的註冊/登入，不需要任何外部憑據，永遠可用。
export function providers(request, env) {
  const list = [];
  if (env.GITHUB_CLIENT_ID) list.push("github");
  if (env.GOOGLE_CLIENT_ID) list.push("google");
  list.push("email");
  return json({ providers: list });
}
