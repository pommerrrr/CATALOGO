// api/ml/preco.js (FINAL atualizado)
// Busca Buy Box (com token) e, se não houver, cai no fallback de ofertas do catálogo.
// Agora o fallback também envia Authorization quando o token existe.

function buildHeaders(token) {
  const h = { Accept: 'application/json', 'User-Agent': 'ImportCostControl/1.0 (server)' };
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

    // Import do token (JS) – extensão .js é obrigatória em ESM na Vercel
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
    // 1) Tenta Buy Box (precisa token)
    if (token) {
      try {
        const r = await fetch(`${base}/products/${mlId}`, { headers: buildHeaders(token) });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && ct.includes('application/json')) {
          const data = await r.json();
          if (data?.buy_box_winner?.price) {
            const price = data.buy_box_winner.price;
            const itemId = data.buy_box_winner.item_id || null;

            // vendidos do item vencedor (melhor esforço)
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
        }
        // Se não ok/JSON/sem buy box → fallback
      } catch {
        // ignora e cai no fallback
      }
    }

    // 2) Fallback: ofertas do catálogo (agora com token quando existir)
    return getCatalogOffers(mlId, base, fetched_at, token);
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

async function getCatalogOffers(mlId, base, fetched_at, token) {
  try {
    const url = `${base}/sites/MLB/search?product_id=${mlId}&limit=50&sort=price_asc`;
    const r = await fetch(url, { headers: buildHeaders(token || undefined) });
    const ct = r.headers.get('content-type') || '';

    if (!r.ok) {
      if (r.status === 401) {
        return {
          ok:false,
          error_code:'AUTH_REQUIRED',
          message:'Mercado Livre retornou 401 para a busca de ofertas. Verifique se o app está autorizado e se o token possui escopo de leitura.',
          http_status:401,
          details:{ upstream_url:url }
        };
      }
      return { ok:false, error_code:'SEARCH_ERROR', message:`Error ${r.status} on offers`, http_status:r.status, details:{ upstream_url:url } };
    }

    if (!ct.includes('application/json')) {
      return { ok:false, error_code:'UPSTREAM_JSON', message:'Invalid response (not JSON) on offers', http_status:502, details:{ upstream_url:url } };
    }

    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const active = results.filter(o => (o.status === 'active' || !o.status) && o.price > 0);

    if (active.length === 0) {
      return { ok:false, error_code:'NO_ACTIVE_OFFERS', message:'Catalog found, but no active offers', http_status:404, details:{ upstream_url:url, total_results:results.length } };
    }

    const best = active[0];
    const soldTotal = active.reduce((s, o) => s + (typeof o.sold_quantity === 'number' ? o.sold_quantity : 0), 0);

    return {
      ok: true,
      price: best.price,
      source: 'catalog_offers',
      product_id: mlId,
      item_id: best.id,
      sold_winner: null,
      sold_catalog_total: soldTotal,
      fetched_at
    };
  } catch (e) {
    return { ok:false, error_code:'OFFERS_ERROR', message:'Error searching offers: ' + String(e?.message||e), http_status:500 };
  }
}
