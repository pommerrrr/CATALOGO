export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    // Import dinâmico para evitar crash na carga do módulo
    const mod = await import('./token.js').catch((e) => {
      throw new Error('Falha ao importar ./token.js (verifique se o arquivo existe e foi compilado): ' + e.message);
    });

    if (typeof mod.getAccessToken !== 'function') {
      throw new Error('getAccessToken não exportado por ./token.js');
    }

    const token = await mod.getAccessToken().catch((e) => {
      throw new Error('getAccessToken() falhou: ' + e.message);
    });

    res.status(200).end(JSON.stringify({
      ok: true,
      tokenSample: token ? token.slice(0, 10) + '...' : null
    }));
  } catch (e) {
    res.status(200).end(JSON.stringify({ ok: false, error: String(e) }));
  }
}
