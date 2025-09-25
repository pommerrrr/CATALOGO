// API: /api/ml/preco?product_id=MLB35854070[&debug=1]
function buildHeaders(token) {
  const h = {
    Accept: 'application/json',
    'User-Agent': 'ImportCostControl/1.0 (server)'
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export default async function handler(req, res) {
  try {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(200).end(JSON.stringify({ ok: true }));
    }
    if (req.method !== 'GET') {
      return res
        .status(200)
        .end(JSON.stringify({ ok: false, error_code: 'METHOD_NOT_ALLOWED', message: 'Only GET', http_status: 405 }));
    }

    const mlId = String((req.query?.product_id ?? '')).trim();
    const debug = String(req.query?.debug ?? '') === '1';

    if (!mlId) {
      return res
        .status(200)
        .end(JSON.stringify({ ok: false, error_code: 'MISSING_PARAM', message: 'product_id is required', http_status: 400 }));
    }
    if (!/^MLB\d+$/.test(mlId)) {
      return res
        .status(200)
        .end(JSON.stringify({ ok: false, error_code: 'INVALID_ID_FORMAT', message: 'Use MLB + números', http_status: 400 }));
    }

    // Import dinâmico evita crash na carga do módulo
    let token = null;
    let tokenErr = null;
    try {
      const mod = await import('./token'); // importa token.ts compilado
      if (typeof mod.getAccessToken === 'function') {
        token = await mod.getAccessToken();
      } else {
        tokenErr = 'getAccessToken não exportado por ./token';
      }
    } catch (e) {
      tokenErr = 'Falha ao importar/usar ./token: ' + e.message;
    }

    const result = await getProductInfo(mlId, token);

    if (debug) {
      result._debug = { tokenOk: !!token, tokenErr };
    }
    return res.status(200).end(JSON.stringify(result));
  } catch (e) {
    return res
      .status(200)
      .end(JSON.stringify({ ok: false, error_code: 'INTERNAL', message: String(e?.message || e), http_status: 500 }));
  }
}

async function getProductInfo(mlId, token) {
  const base = 'https://api.mercadolibre.com';
  const fetched_at = new Date().toISOString();
  const digits = mlId.replace('MLB', '');
  const isCatalog = digits.length < 10;

  if (isCatalog) {
    // Tenta /products (requer token). Se 401/403 → fallback ofertas
    if (token) {
      try {
        const prodUrl = `${base}/products/${mlId}`;
        const r = await fetch(prodUrl, { method: 'GET', headers: buildHeaders(token) });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && ct.includes('application/json')) {
          const data = await r.json();
          if (data?.buy_box_winner?.price) {
            const price = data.buy_box_winner.price;
            const itemId = data.buy_box_winner.item_id || null;

            // tenta pegar sold_quantity do item vencedor (melhor esforço)
            let soldWinner = null;
            if (itemId) {
              try {
                const ir = await fetch(`${base}/items/${itemId}`, { method: 'GET', headers: buildHeaders(token) });
                const ict = ir.headers.get('content-type') || '';
                if (ir.ok && ict.includes('application/json')) {
                  const j = await ir.json();
                  soldWinner = typeof j.sold_quantity === 'number' ? j.sold_quantity : null;
                }
              } catch { /* ignore */ }
            }

            return {
              ok: true,
              price,
              source: 'buy_box',
              product_id: mlId,
              item_id: itemId,
              sold_winner: soldWinner,
              sold_catalog_total: null,
              fetched_at
            };
          }
        }
        // se não ok ou sem JSON, cai no fallback
      } catch {
        // ignora e tenta fallback
      }
    }
    // Fallback: ofertas do catálogo (não precisa token)
    return getCatalogOffers(mlId, base, fetched_at);
  }

  // ID de item direto (precisa token, mas tentamos mesmo assim)
  const itemUrl = `${base}/items/${mlId}`;
  try {
    const r = await fetch(itemUrl, { method: 'GET', headers: buildHeaders(token || undefined) });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      if (r.status === 404) {
        return { ok: false, error_code: 'ITEM_NOT_FOUND', message: 'Item not found', http_status: 404, details: { upstream_url: itemUrl } };
      }
      return { ok: false, error_code: 'UPSTREAM_ERROR', message: `Error ${r.status} on item`, http_status: r.status, details: { upstream_url: itemUrl } };
    }
    if (!ct.includes('application/json')) {
      return { ok: false, error_code: 'UPSTREAM_JSON', message: 'Invalid response (not JSON) on item', http_status: 502, details: { upstream_url: itemUrl } };
    }
    const data = await r.json();
    if (!(data?.price > 0)) {
      return { ok: false, error_code: 'NO_PRICE', message: 'Item has no price', http_status: 404, details: { upstream_url: itemUrl } };
    }
    return {
      ok: true,
      price: data.price,
      source: 'item',
      product_id: mlId,
      item_id: mlId,
      sold_winner: typeof data.sold_quantity === 'number' ? data.sold_quantity : null,
      sold_catalog_total: null,
      fetched_at
    };
  } catch (e) {
    return { ok: false, error_code: 'ITEM_ERROR', message: 'Error consulting item: ' + String(e?.message || e), http_status: 500, details: { upstream_url: itemUrl } };
  }
}

async function getCatalogOffers(mlId, base, fetched_at) {
  try {
    const url = `${base}/sites/MLB/search?product_id=${mlId}&limit=50&sort=price_asc`;
    const
