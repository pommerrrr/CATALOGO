// api/ml/preco.js (SOMENTE BUY BOX)
// Objetivo: retornar "o preço que o catálogo está ganhando".
// Fluxo:
// - Se for catálogo (MLB + <10 dígitos): GET /products/{id} com token, lê buy_box_winner.price.
//   * Se houver: retorna ok:true, source:'buy_box'.
//   * Se não houver: retorna ok:false, NO_BUY_BOX (catálogo existe mas sem vencedor visível via API).
// - Se for item (MLB + >=10 dígitos): GET /items/{id} (com token) e retorna price.
// Observações:
// - Não usamos mais /sites/{site}/search?product_id nem /products/{id}/items (descontinuado).
// - Sempre responde JSON e nunca redireciona.

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

    if (req.method === 'OPTIONS') {
      return res.status(200).end(JSON.stringify({ ok: true }));
    }
    if (req.method !== 'GET') {
      return res.status(200).end(JSON.stringify({
        ok: false, error_code: 'METHOD_NOT_ALLOWED', message: 'Only GET', http_status: 405
      }));
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

    // Token via arquivo JS (extensão .js é obrigatória em ESM/Vercel)
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

    const result = await getPrice(mlId, token);

    if (debug) result._debug = { tokenOk: !!token, tokenErr };
    return res.status(200).end(JSON.stringify(result));
  } catch (e) {
    return res.status(200).end(JSON.stringify({
      ok:false, error_code:'INTERNAL', message:String(e?.message||e), http_status:500
    }));
  }
}

async function getPrice(mlId, token) {
  const base = 'https://api.mercadolibre.com';
  const fetched_at = new Date().toISOString();
  const isCatalog = mlId.replace('MLB','').length < 10;

  if (isCatalog) {
    if (!token) {
      return { ok:false, error_code:'AUTH_REQUIRED', message:'Token ausente para consultar catálogo.', http_status:401 };
    }

    const url = `${base}/products/${mlId}`;
    try {
      const r = await fetch(url, { headers: buildHeaders(token) });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) {
        if (r.status === 401) {
          return { ok:false, error_code:'AUTH_REQUIRED', message:'401 em /products/{id}. Reautorize o app/escopos.', http_status:401, details:{ upstream_url:url } };
        }
        if (r.status === 403) {
          return { ok:false, error_code:'FORBIDDEN', message:'403 em /products/{id}. Permissões insuficientes.', http_status:403, details:{ upstream_url:url } };
        }
        if (r.status === 404) {
          return { ok:false, error_code:'CATALOG_NOT_FOUND', message:'Catálogo não encontrado', http_status:404, details:{ upstream_url:url } };
        }
        return { ok:false, error_code:'UPSTREAM_ERROR', message:`Erro ${r.status} em /products/{id}`, http_status:r.status, details:{ upstream_url:url } };
      }
      if (!ct.includes('application/json')) {
        return { ok:false, error_code:'UPSTREAM_JSON', message:'Resposta inválida (não JSON) em /products/{id}', http_status:502, details:{ upstream_url:url } };
      }

      const data = await r.json();
      const winner = data?.buy_box_winner;
      if (winner?.price > 0) {
        // Melhor esforço: vendidos do item vencedor
        let soldWinner = null;
        if (winner.item_id) {
          try {
            const ri = await fetch(`${base}/items/${winner.item_id}`, { headers: buildHeaders(token) });
            const cti = ri.headers.get('content-type') || '';
            if (ri.ok && cti.includes('application/json')) {
              const ji = await ri.json();
              soldWinner = typeof ji.sold_quantity === 'number' ? ji.sold_quantity : null;
            }
          } catch {}
        }

        return {
          ok: true,
          price: winner.price,
          source: 'buy_box',
          product_id: mlId,
          item_id: winner.item_id || null,
          sold_winner: soldWinner,
          sold_catalog_total: null,
          fetched_at
        };
      }

      // Sem buy box exposto pela API (ou catálogo sem vencedor)
      return {
        ok:false,
        error_code:'NO_BUY_BOX',
        message:'Catálogo sem buy box disponível via API no momento.',
        http_status:404,
        details:{ upstream_url:url }
      };
    } catch (e) {
      return { ok:false, error_code:'CATALOG_ERROR', message:'Erro consultando catálogo: ' + String(e?.message||e), http_status:500 };
    }
  }

  // ID de item direto
  const itemUrl = `${base}/items/${mlId}`;
  try {
    const r = await fetch(itemUrl, { headers: buildHeaders(token || undefined) });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      if (r.status === 404) return { ok:false, error_code:'ITEM_NOT_FOUND', message:'Item não encontrado', http_status:404, details:{ upstream_url:itemUrl } };
      return { ok:false, error_code:'UPSTREAM_ERROR', message:`Erro ${r.status} em /items/{id}`, http_status:r.status, details:{ upstream_url:itemUrl } };
    }
    if (!ct.includes('application/json')) {
      return { ok:false, error_code:'UPSTREAM_JSON', message:'Resposta inválida (não JSON) em /items/{id}', http_status:502, details:{ upstream_url:itemUrl } };
    }
    const data = await r.json();
    if (!(data?.price > 0)) {
      return { ok:false, error_code:'NO_PRICE', message:'Item sem preço disponível', http_status:404, details:{ upstream_url:itemUrl } };
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
    return { ok:false, error_code:'ITEM_ERROR', message:'Erro consultando item: ' + String(e?.message||e), http_status:500, details:{ upstream_url:itemUrl } };
  }
}
