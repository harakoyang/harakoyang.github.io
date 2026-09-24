export class HttpError extends Error {
  // details 會一併放進錯誤回應 JSON，例如 429 時帶 retry_after 給前端做倒計時。
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// __Host- 前缀要求 Secure + Path=/ 且不带 Domain，浏览器会拒绝任何不满足的
// 写入，等于免费拿到「子域不能伪造这个 cookie」的保证。http://localhost 被
// 当作安全上下文，所以本地 wrangler dev 也能正常设置。
export function cookieHeader(name, value, maxAge) {
  const attrs = [
    `__Host-${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  return attrs.join("; ");
}

export function clearCookieHeader(name) {
  return cookieHeader(name, "", 0);
}
