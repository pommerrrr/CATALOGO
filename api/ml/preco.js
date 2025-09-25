// api/ml/preco.js (FINAL – sem /sites/MLB/search)
// Fluxo:
// 1) Catálogo: tenta Buy Box via /products/{id} (com token).
// 2) Sem Buy Box: lista itens via /products/{id}/items (com token) e
//    busca detalhes em lotes com /items?ids=...  → menor preço + soma de vendidos.
// 3) ID de item: consulta /items/{id}.
// Sempre responde JSON e nunca redireciona.

function buildHeaders(token) {
  const h = { Accept: 'application/json', 'User-Agent': 'ImportCostControl/1.0 (server)' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end(JSON.stringify({ ok: true }));
    if (req.method !== 'GET') {
      return res
        .status(200)
        .end(JSON.stringify({ ok:false, error_code:'METHOD_NOT_ALLOWED', message:'Only GET', http_status:405 }));
    }

    const mlId = String((req.query?.product_id ?? '')).trim();
    const debug = String(req.query?.debug ?? '') === '1';
    if (!mlId) {
      return res.status(200).end(JSON.stringify({
        ok:false, error_code:'MISSING_PARAM', message:'product_id is required', http_status:400
      }));
    }
    if (!/^MLB\d+$/.test(mlId)) {
      return res.status(200).end(JSON.stringify({
        ok:false, error_code:'INVALID_ID_FORMAT', message:'Use MLB + números', http_status:400
      }));
    }

    // Import do token (arquivo JS; extensão .js é obrigatória em ESM)
    let token = null, tokenErr = null;
    try {
      const mod = await import('./token.js');
      if (typeof mod.getAccessToken === 'function') {
        token = await mod.getAccessToken();
      } else {
        tokenErr = 'getAccessToken não exportado por ./token.js';
      }
    } catch (e) {
      tokenErr = 'Falha ao importar/usar ./token.js: ' + e.message;
    }

    const result = await getProductInfo(mlId, token);

    if (debug) result._debug = { tokenOk: !!token, tokenErr };
    return res.status(200).end(JSON.stringify(result));
  } catch (e) {
    return res
      .status(200)
      .end(JSON.stringify({ ok:false, error_code:'INTERNAL', message:String(e?.message||e), http_status:500 }));
  }
}

async function getProductInfo(mlId, token) {
  const base = 'https://api.mercadolibre.com';
  const fetched_at = new Date().toISOString();
  const isCatalog = mlId.replace('MLB','').length < 10;

  if (isCatalog) {
    if (!token) {
      return {
        ok:false,
        error_code:'AUTH_REQUIRED',
        message:'Token ausente para consultar catálogo.',
        http_status:401
      };
    }

    // 1) Tenta Buy Box
    try {
      const r = await fetch(`${base}/products/${mlId}`, { headers: buildHeaders(token) });
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.includes('application/json')) {
        const data = await r.json();
        if (data?.buy_box_winner?.price) {
          const price = data.buy_box_winner.price;
          const itemId = data.buy_box_winner.item_id || null;

          // Vendidos do item vencedor (melhor esforço)
          let soldWinner = null;
          if (itemId) {
            try {
              const ri = await fetch(`${base}/items/${itemId}`, { headers: buildHeaders(token) });
              const cti = ri.headers.get('content-type') || '';
              if (ri.ok && cti.includes('application/json')) {
                const ji = await ri.json();
                soldWinner = typeof ji.sold_quantity === 'number' ? ji.sold_quantity : null;
              }
            } catch {}
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
      } else if (r.status === 401) {
        return {
          ok:false,
          error_code:'AUTH_REQUIRED',
          message:'401 em /products/{id}. Reautorize o app e confira os escopos.',
          http_status:401,
          details:{ upstream_url: `${base}/products/${mlId}`, upstream_status: r.status }
        };
      } else if (r.status === 403) {
        return {
          ok:false,
          error_code:'FORBIDDEN',
          message:'403 em /products/{id}. Permissões insuficientes.',
          http_status:403,
          details:{ upstream_url: `${base}/products/${mlId}`, upstream_status: r.status }
        };
      }
      // Sem Buy Box → fallback autenticado
    } catch {
      // segue para o fallback
    }

    // 2) Fallback autenticado: listar itens do catálogo e pegar menor preço
    return getCatalogItemsAndPickBest(mlId, base, token, fetched_at);
  }

  // ID de item direto
  const itemUrl = `${base}/items/${mlId}`;
  try {
    const r = await fetch(itemUrl, { headers: buildHeaders(token || undefined) });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      if (r.status === 404) {
        return { ok:false, error_code:'ITEM_NOT_FOUND', message:'Item not found', http_status:404, details:{ upstream_url:itemUrl } };
      }
      return { ok:false, error_code:'UPSTREAM_ERROR', message:`Error ${r.status} on item`, http_status:r.status, details:{ upstream_url:itemUrl } };
    }
    if (!ct.includes('application/json')) {
      return { ok:false, error_code:'UPSTREAM_JSON', message:'Invalid response (not JSON) on item', http_status:502, details:{ upstream_url:itemUrl } };
    }
    const data = await r.json();
    if (!(data?.price > 0)) {
      return { ok:false, error_code:'NO_PRICE', message:'Item has no price', http_status:404, details:{ upstream_url:itemUrl } };
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
    return { ok:false, error_code:'ITEM_ERROR', message:'Error consulting item: ' + String(e?.message||e), http_status:500, details:{ upstream_url:itemUrl } };
  }
}

async function getCatalogItemsAndPickBest(mlId, base, token, fetched_at) {
  const listUrl = `${base}/products/${mlId}/items?limit=200`;
  try {
    const r = await fetch(listUrl, { headers: buildHeaders(token) });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      if (r.status === 401) {
        return {
          ok:false,
          error_code:'AUTH_REQUIRED',
          message:'401 em /products/{id}/items. Reautorize o app e confira escopos.',
          http_status:401,
          details:{ upstream_url:listUrl }
        };
      }
      if (r.status === 403) {
        return {
          ok:false,
          error_code:'FORBIDDEN',
          message:'403 em /products/{id}/items. Permissões insuficientes.',
          http_status:403,
          details:{ upstream_url:listUrl }
        };
      }
      return { ok:false, error_code:'OFFERS_LIST_ERROR', message:`Error ${r.status} on product items`, http_status:r.status, details:{ upstream_url:listUrl } };
    }
    if (!ct.includes('application/json')) {
      return { ok:false, error_code:'UPSTREAM_JSON', message:'Invalid response (not JSON) on product items', http_status:502, details:{ upstream_url:listUrl } };
    }

    const data = await r.json();
    // Shapes possíveis:
    // - { results: [ { id: 'MLB...' }, ... ] }
    // - [ 'MLB...', ... ] ou [ { id:'MLB...' }, ... ]
    const raw = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
    const ids = raw
      .map(x => (typeof x === 'string' ? x : (x?.id || null)))
      .filter(Boolean);

    if (ids.length === 0) {
      return { ok:false, error_code:'NO_ACTIVE_OFFERS', message:'Nenhum item encontrado para este catálogo', http_status:404, details:{ upstream_url:listUrl } };
    }

    // Busca detalhes em lotes de 20 para pegar price/status/sold_quantity
    const chunks = chunk(ids, 20);
    let best = null;       // { id, price }
    let soldTotal = 0;

    for (const c of chunks) {
      const itemsUrl = `${base}/items?ids=${c.join(',')}`;
      const ri = await fetch(itemsUrl, { headers: buildHeaders(token) });
      const cti = ri.headers.get('content-type') || '';
      if (!ri.ok || !cti.includes('application/json')) continue;

      const arr = await ri.json(); // [{ code:200, body:{...}}, ...]
      if (!Array.isArray(arr)) continue;

      for (const entry of arr) {
        const body = entry?.body;
        if (!body) continue;
        const price = Number(body.price) || 0;
        const status = body.status || '';
        const isActive = status === 'active' || status === 'paused' || status === '' || !status;
        if (price > 0 && isActive) {
          if (!best || price < best.price) best = { id: body.id, price };
        }
        const sq = Number(body.sold_quantity);
        if (!Number.isNaN(sq)) soldTotal += sq;
      }
    }

    if (!best) {
      return { ok:false, error_code:'NO_ACTIVE_OFFERS', message:'Itens do catálogo sem preço ativo', http_status:404, details:{ upstream_url:listUrl } };
    }

    return {
      ok: true,
      price: best.price,
      source: 'catalog_items', // <— novo fallback autenticado
      product_id: mlId,
      item_id: best.id,
      sold_winner: null,
      sold_catalog_total: soldTotal,
      fetched_at
    };
  } catch (e) {
    return { ok:false, error_code:'OFFERS_ERROR', message:'Error listing items: ' + String(e?.message||e), http_status:500, details:{ upstream_url:listUrl } };
  }
}
