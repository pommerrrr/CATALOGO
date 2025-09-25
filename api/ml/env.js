export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const env = {
      ML_APP_ID: !!process.env.ML_APP_ID,
      ML_APP_SECRET: !!process.env.ML_APP_SECRET,
      ML_REDIRECT_URI: !!process.env.ML_REDIRECT_URI,
      ML_REFRESH_TOKEN: !!process.env.ML_REFRESH_TOKEN,
      NODE_VERSION: process.version
    };
    res.status(200).end(JSON.stringify({ ok: true, env }));
  } catch (e) {
    res.status(200).end(JSON.stringify({ ok: false, error: String(e) }));
  }
}
