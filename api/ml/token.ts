// api/ml/token.ts
export async function getAccessToken(): Promise<string> {
  const appId = process.env.ML_APP_ID!;
  const appSecret = process.env.ML_APP_SECRET!;
  const refresh = process.env.ML_REFRESH_TOKEN || "";

  if (!refresh) throw new Error("ML_REFRESH_TOKEN vazio. Rode o login e salve o refresh_token na Vercel.");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: appId,
    client_secret: appSecret,
    refresh_token: refresh,
  });

  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Falha ao renovar access_token: ${r.status} ${t}`);
  }

  const json = await r.json();
  return json.access_token as string; // ~6h
}
