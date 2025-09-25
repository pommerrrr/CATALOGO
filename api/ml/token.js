// api/ml/token.js
export async function getAccessToken() {
  const {
    ML_APP_ID,
    ML_APP_SECRET,
    ML_REFRESH_TOKEN,
  } = process.env;

  if (!ML_APP_ID || !ML_APP_SECRET || !ML_REFRESH_TOKEN) {
    throw new Error('Missing ML_APP_ID / ML_APP_SECRET / ML_REFRESH_TOKEN envs');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ML_APP_ID,
    client_secret: ML_APP_SECRET,
    refresh_token: ML_REFRESH_TOKEN,
  });

  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    // Inclui o início da resposta para diagnóstico rápido
    const text = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed: ${resp.status} ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.access_token;
}
