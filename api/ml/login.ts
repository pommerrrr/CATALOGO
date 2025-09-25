// api/ml/login.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const appId = process.env.ML_APP_ID!;
  const redirect = process.env.ML_REDIRECT_URI!;
  // Use o host BR:
  const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}`;
  res.status(302).setHeader("Location", authUrl).end();
}
