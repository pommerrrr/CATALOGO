// api/ml/callback.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

function getCookie(req: VercelRequest, name: string): string | null {
  const raw = req.headers.cookie || "";
  const parts = raw.split(/; */).map(s => s.trim());
  for (const p of parts) {
    const [k, ...rest] = p.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  if (!code) return res.status(400).send("<h1>Sem 'code' na URL</h1>");

  const appId = process.env.ML_APP_ID!;
  const appSecret = process.env.ML_APP_SECRET!;
  const redirect = process.env.ML_REDIRECT_URI!;
  if (!appId || !appSecret || !redirect) {
    return res.status(500).send("<h1>Variáveis de ambiente ausentes (ML_APP_ID / ML_APP_SECRET / ML_REDIRECT_URI)</h1>");
  }

  // Recupera verifier e confere state
  const cookieVerifier = getCookie(req, "ml_verifier");
  const cookieState = getCookie(req, "ml_state");

  if (!cookieVerifier) {
    return res.status(400).send("<h1>PKCE verifier ausente/expirado. Recomece o login.</h1>");
  }
  if (!cookieState || cookieState !== state) {
    return res.status(400).send("<h1>State inválido. Recomece o login.</h1>");
  }

  // Troca code por tokens (com PKCE)
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: appId,
    client_secret: appSecret,
    code,
    redirect_uri: redirect,
    code_verifier: cookieVerifier,
  });

  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await r.text();

  if (!r.ok) {
    return res
      .status(400)
      .send(`<h1>Erro trocando code por token</h1><pre>${text.replace(/</g, "&lt;")}</pre>`);
  }

  const json = JSON.parse(text);
  const refresh = json.refresh_token;

  // Limpa cookies (opcional)
  res.setHeader("Set-Cookie", [
    `ml_verifier=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `ml_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);

  return res.status(200).send(`
    <h1>Tokens obtidos com sucesso ✅</h1>
    <p><b>refresh_token:</b></p>
    <pre style="white-space:pre-wrap">${refresh}</pre>
    <p>Na Vercel, salve em <code>ML_REFRESH_TOKEN</code> esse valor e faça redeploy.</p>
  `);
}
