// api/ml/callback.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = String(req.query.code || "");
  if (!code) return res.status(400).send("Sem 'code'");

  const appId = process.env.ML_APP_ID!;
  const appSecret = process.env.ML_APP_SECRET!;
  const redirect = process.env.ML_REDIRECT_URI!;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: appId,
    client_secret: appSecret,
    code,
    redirect_uri: redirect,
  });

  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await r.text();
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!r.ok) {
    return res.status(500).send(`<h1>Erro trocando code por token</h1><pre>${text}</pre>`);
  }

  const json = JSON.parse(text);
  // json contém: access_token, refresh_token, expires_in, user_id, ...
  const refresh = json.refresh_token;

  // Mostra o refresh_token para você copiar e colar na Vercel
  return res.status(200).send(`
    <h1>Tokens obtidos com sucesso ✅</h1>
    <p><b>refresh_token:</b></p>
    <pre style="white-space:pre-wrap">${refresh}</pre>
    <p>Vá na Vercel → Settings → Environment Variables e salve <code>ML_REFRESH_TOKEN</code> com esse valor. Depois faça um redeploy.</p>
  `);
}
