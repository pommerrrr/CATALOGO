// Stage 1: valida apenas o import do token e a geração do access_token
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  try {
    let token = null;
    let tokenErr = null;

    try {
      // Import dinâmico evita crash se o módulo não existir/compilar
      const mod = await import('./token');
      if (typeof mod.getAccessToken !== 'function') {
        tokenErr = 'getAccessToken não exportado por ./token';
      } else {
        token = await mod.getAccessToken();
      }
    } catch (e) {
      tokenErr = 'Falha ao importar/usar ./token: ' + e.message;
    }

    return res.status(200).end(JSON.stringify({
      ok: true,
      step: 'stage1',
      tokenOk: !!token,
      tokenSample: token ? token.slice(0, 10) + '...' : null,
      tokenErr
    }));
  } catch (e) {
    return res.status(200).end(JSON.stringify({ ok: false, step: 'stage1', error: String(e) }));
  }
}
