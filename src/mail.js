// 共用寄信 helper。線上透過 RESEND_API_KEY 走 Resend；未設定時一律回 false，
// 避免測試環境忘配 key 就把密碼改掉卻沒寄出。
// 寄件人沿用 REVIEW_EMAIL_FROM：Resend 要求寄件網域先驗證，站上只有這一組
// 已驗證地址，週報與重設密碼信共用。

export async function sendEmail(env, { to, subject, text, html }) {
  if (!env.RESEND_API_KEY || !env.REVIEW_EMAIL_FROM) return false;

  const body = { from: env.REVIEW_EMAIL_FROM, to, subject };
  if (text) body.text = text;
  if (html) body.html = html;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(`resend failed: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}
