// Stage 0: apenas prova que o handler roda
export default async function handler(req, res) {
  try {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(200).end(JSON.stringify({ ok: true, step: 'stage0' }));
    }

    return res.status(200).end(JSON.stringify({
      ok: true,
      step: 'stage0',
      node: process.version,
      query: req.query || null
    }));
  } catch (e) {
    return res.status(200).end(JSON.stringify({ ok: false, step: 'stage0', error: String(e) }));
  }
}
