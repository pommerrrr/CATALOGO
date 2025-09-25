// api/ml/login.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomBytes, createHash } from "crypto";

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const appId = process.env.ML_APP_ID!;
  const redirect = process.env.ML_REDIRECT_URI!;
  if (!appId || !redirect) {
    return res.status(500).send("ML_APP_ID / ML_REDIRECT_URI não configurados");
  }

  // PKCE: gera verifier (43–128 chars) e challenge S256
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  // Também usamos "state" para validar a volta
  const state = b64url(randomBytes(16));

  // Salva verifier e state em cookies de curta duração (10 min)
  res.setHeader("Set-Cookie", [
    `ml_verifier=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    `ml_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  ]);

  // IMPORTANT: Brasil → auth.mercadolivre.com.br
  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256` +
    `&state=${state}`;

  res.status(302).setHeader("Location", authUrl).end();
}
