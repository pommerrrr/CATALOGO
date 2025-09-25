// api/ml/preco.js
// ✅ WID (MLB com 10+ dígitos) via chamadas PÚBLICAS, sem Authorization, com fallbacks:
//    1) /items/{WID}
//    2) /items/{WID}?attributes=...
//    3) /items?ids={WID}
//    4) /items?ids={WID}&attributes=...
// ✅ Catálogo (MLB com <10 dígitos) via /products/{id} com OAuth (token.js) → buy_box_winner
// ✅ product_id pode ser MLB direto OU link de catálogo com #...wid=MLB... (extrai WID)
// ✅ Sempre responde JSON

const ML_BASE = "https://api.mercadolibre.com";

// --------- Utils ---------
function isAnyMLB(id) {
  return !!id && /^MLB\d+$/i.test(String(id).trim());
}
function isWID(id) {
  return !!id && /^MLB\d{10,}$/i.test(String(id).trim());
}
function extractWidFromHash(url) {
  if (!url) return null;
  try {
    const hash = String(url).split("#")[1] || "";
    const m = hash.match(/wid=(MLB\d{10,})/i);
    return m ? m[1].toUpperCase() : null;
  } catch { return null; }
}
function extractItemIdFromPermalink(url) {
  if (!url) return null;
  try {
    const m = String(url).match(/MLB\d{10,}/i);
    return m ? m[0].toUpperCase() : null;
  } catch { return null; }
}
function json(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// --------- HTTP helpers ---------
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

async function fetchPublicJson(url) {
  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": BROWSER_UA,
      "Cache-Control": "no-cache"
    }
  });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data, url, ct };
}

function buildAuthHeaders(token) {
  const h = {
    Accept: "application/json",
    "User-Agent": "ImportCostControl/1.0 (server)",
    "Cache-Control": "no-cache"
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function fetchAuthJson(url, token) {
  const r = await fetch(url, { headers: buildAuthHeaders(token) });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data, url, ct };
}

// --------- WID (Item) — 100% público ---------
async function getItemPricePublic(wid) {
  // Tenta em ordem: direta sem atributos → direta com atributos → bulk sem attrs → bulk com attrs
  const tries = [
    `${ML_BASE}/items/${wid}`,
    `${ML_BASE}/items/${wid}?attributes=price,status,available_quantity,sold_quantity,permalink`,
    `${ML_BASE}/items?ids=${wid}`,
    `${ML_BASE}/items?ids=${wid}&attributes=price,status,available_quantity,sold_quantity,permalink`
  ];

  for (const url of tries) {
    const r = await fetchPublicJson(url);

    // Caso bulk, normalizar resposta (array [{code, body}])
    if (url.includes("/items?ids=") && r.ok) {
      const arr = Array.isArray(r.data) ? r.data : [];
      const first = arr[0] || {};
      if (first.code === 200 && first.body) {
        const price = Number(first.body.price || 0);
        if (price > 0) {
          return {
            ok: true,
            price,
            source: "item",
            item_id: wid,
            sold_winner: Number.isFinite(first.body.sold_quantity) ? first.body.sold_quantity : null,
            via: url
          };
        }
        return { ok: false, status: 404, error_code: "NO_PRICE", message: "Anúncio sem preço disponível", url };
      }
      // se code !== 200, tenta próximo fallback
      continue;
    }

    // Direta
    if (r.ok) {
      const price = Number(r.data?.price || 0);
      if (price > 0) {
        return {
          ok: true,
          price,
          source: "item",
          item_id: wid,
          sold_winner: Number.isFinite(r.data?.sold_quantity) ? r.data.sold_quantity : null,
          via: url
        };
      }
      // Sem preço → tenta próximo fallback
      continue;
    }

    // Se deu 401/403/5xx, tenta próximo fallback
    // (não retornamos ainda; só devolvemos se acabar as tentativas)
  }

  // Se chegou aqui, todos os fallbacks falharam
  return {
    ok: false,
    status: 401,
    error_code: "UPSTREAM_ERROR",
    message: "Falha ao obter preço público do WID (todas as tentativas).",
    url: "all-fallbacks"
  };
}

// --------- Catálogo (buy box) — com OAuth ---------
import { getAccessToken } from "./token.js";

async function getCatalogBuyBox(productId) {
  const token = await getAccessToken().catch(() => null);
  if (!token) {
    return { ok:false, status:401, error_code:"AUTH_REQUIRED", message:"Token ausente/expirado para /products/{id}" };
  }
  const url = `${ML_BASE}/products/${productId}`;
  const r = await fetchAuthJson(url, token);
  if (!r.ok) {
    const code = r.status === 403 ? "FORBIDDEN" : (r.status === 404 ? "CATALOG_NOT_FOUND" : "UPSTREAM_ERROR");
    const msg  = r.status === 403 ? "Permissões insuficientes para /products/{id}" :
                 r.status === 404 ? "Catálogo não encontrado" :
                 `Erro ${r.status} em /products/{id}`;
    return { ok:false, status:r.status, error_code:code, message:msg, url };
  }
  if (!r.ct.includes("application/json")) {
    return { ok:false, status:502, error_code:"UPSTREAM_JSON", message:"Resposta inválida (não JSON) em /products/{id}", url };
  }
  const winner = r.data?.buy_box_winner;
  if (!(winner?.price > 0)) {
    return { ok:false, status:404, error_code:"NO_BUY_BOX", message:"Catálogo sem buy box disponível via API no momento.", url };
  }

  // tentar soldados do item vencedor (best-effort)
  let sold = null;
  if (winner.item_id) {
    const ir = await fetchAuthJson(`${ML_BASE}/items/${winner.item_id}`, token);
    if (ir.ok && Number.isFinite(ir.data?.sold_quantity)) sold = ir.data.sold_quantity;
  }

  return { ok:true, price:winner.price, item_id:winner.item_id || null, sold };
}

// --------- Handler ---------
export default async function handler(req, res) {
  try {
    // CORS/JSON
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") return json(res, 200, { ok: true });
    if (req.method !== "GET")     return json(res, 200, { ok:false, error_code:"METHOD_NOT_ALLOWED", http_status:405 });

    const q = req.query || {};
    let productId   = String((q.product_id ?? "")).trim();
    let myItemId    = String((q.my_item_id ?? "")).trim();
    const permalink = String((q.my_permalink ?? "")).trim();

    // Se vier link de catálogo com #...wid=MLB..., extrair WID e tratar como item
    if (!isWID(productId)) {
      const wid = extractWidFromHash(productId);
      if (isWID(wid)) productId = wid;
    }

    // Se não for MLB válido mas vier permalink, tenta extrair WID
    if (!isAnyMLB(productId) && permalink) {
      const fromP = extractItemIdFromPermalink(permalink);
      if (isWID(fromP)) myItemId = fromP;
    }

    // Decisão: catálogo (<10 dígitos) ou WID (>=10)
    if (isAnyMLB(productId)) {
      const digits = productId.replace(/MLB/i, "");
      const isCatalog = digits.length < 10;

      if (isCatalog) {
        // Catálogo → buy box com OAuth
        const r = await getCatalogBuyBox(productId);
        if (r.ok) {
          return json(res, 200, {
            ok: true,
            price: r.price,
            source: "buy_box",
            product_id: productId,
            item_id: r.item_id,
            sold_winner: r.sold,
            sold_catalog_total: null,
            fetched_at: new Date().toISOString()
          });
        }

        // Fallback: se usuario mandar my_item_id, tenta como item público
        if (isWID(myItemId)) {
          const fr = await getItemPricePublic(myItemId);
          if (fr.ok) {
            return json(res, 200, {
              ok: true,
              price: fr.price,
              source: "my_item",
              product_id: productId,
              item_id: myItemId,
              sold_winner: fr.sold_winner,
              sold_catalog_total: null,
              fetched_at: new Date().toISOString()
            });
          }
        }

        return json(res, 200, {
          ok:false,
          error_code: r.error_code || "UPSTREAM_ERROR",
          message:  r.message    || "Falha ao consultar catálogo",
          http_status: r.status  || 502,
          details: { upstream_url: r.url || `${ML_BASE}/products/${productId}` }
        });
      }

      // WID (Item) → público, sem Authorization, com fallbacks
      const r = await getItemPricePublic(productId);
      if (!r.ok) {
        return json(res, 200, {
          ok:false,
          error_code: r.error_code || "UPSTREAM_ERROR",
          message:  r.message    || `Erro ${r.status} consultando WID`,
          http_status: r.status  || 500,
          details: { upstream_url: r.url }
        });
      }
      return json(res, 200, {
        ok: true,
        price: r.price,
        source: "item",
        product_id: productId,
        item_id: productId,
        sold_winner: r.sold_winner,
        sold_catalog_total: null,
        fetched_at: new Date().toISOString()
      });
    }

    // Sem product_id MLB válido → tenta fallback para my_item_id/permalink se vier
    if (isWID(myItemId)) {
      const r = await getItemPricePublic(myItemId);
      if (r.ok) {
        return json(res, 200, {
          ok: true,
          price: r.price,
          source: "item",
          product_id: myItemId,
          item_id: myItemId,
          sold_winner: r.sold_winner,
          sold_catalog_total: null,
          fetched_at: new Date().toISOString()
        });
      }
      return json(res, 200, {
        ok:false,
        error_code: r.error_code || "UPSTREAM_ERROR",
        message:  r.message    || `Erro ${r.status} consultando WID`,
        http_status: r.status  || 500,
        details: { upstream_url: r.url }
      });
    }

    return json(res, 200, {
      ok:false,
      error_code: "MISSING_PARAM",
      message: "Envie product_id=MLB... (catálogo ou WID). Links com #...wid=MLB... também são aceitos.",
      http_status: 400
    });

  } catch (e) {
    return json(res, 200, {
      ok:false, error_code:"INTERNAL", message:String(e?.message || e), http_status:500
    });
  }
}
