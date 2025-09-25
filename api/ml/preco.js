// api/ml/preco.js
// Retorna o preço do catálogo (buy box) quando for ID de catálogo (MLB + <10 dígitos)
// ou o preço do anúncio (WID, MLB + >=10 dígitos).
// Corrigido para WID: NUNCA usar Authorization em /items (evita 403 quando o item não é seu).
// Para /products/{id} (buy box) usa OAuth via token.js.
//
// Aceita:
//   - ?product_id=MLB...  (pode ser catálogo ou WID)
//   - ?product_id=<link de catálogo com #...wid=MLB...>  (extrai WID e trata como item)
//   - ?my_item_id=MLB... ou ?my_permalink=https://.../MLB...  (fallback quando catálogo sem buy box)
//
// Resposta sempre em JSON.

function isAnyMLB(id) {
  return !!id && /^MLB\d+$/i.test(String(id).trim());
}
// WID = MLB + 10 ou mais dígitos
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

const ML_BASE = "https://api.mercadolibre.com";

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function buildHeaders(token) {
  const h = { Accept: "application/json", "User-Agent": "ImportCostControl/1.0 (server)" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function fetchJson(url, { token=null } = {}) {
  const r = await fetch(url, { headers: buildHeaders(token) });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data, url, ct };
}

// --------- WID (Item) — chamadas públicas, sem token ---------
async function fetchItemPublic(wid) {
  // rota direta
  const url = `${ML_BASE}/items/${wid}?attributes=price,status,available_quantity,sold_quantity,permalink`;
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "WidOnly/1.0" } });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data, url };
}

async function fetchItemBulkPublic(wid) {
  // fallback via bulk
  const url = `${ML_BASE}/items?ids=${wid}&attributes=price,status,available_quantity,sold_quantity,permalink`;
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "WidOnly/1.0" } });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  if (!r.ok) return { ok:false, status:r.status, data, url };
  const arr = Array.isArray(data) ? data : [];
  const first = arr[0] || {};
  if (first.code === 200 && first.body) {
    return { ok:true, status:200, data:first.body, url };
  }
  return { ok:false, status:404, data:null, url };
}

async function getItemPrice(wid) {
  // 1) direta
  let r = await fetchItemPublic(wid);
  if (!r.ok) {
    // 2) bulk fallback
    const b = await fetchItemBulkPublic(wid);
    if (!b.ok) return b;
    r = b;
  }
  const price = Number(r.data?.price || 0);
  if (!price) {
    return { ok:false, status:404, error_code:"NO_PRICE", message:"Anúncio sem preço disponível", url:r.url };
  }
  return {
    ok: true,
    price,
    source: "item",
    item_id: wid,
    sold_winner: Number.isFinite(r.data?.sold_quantity) ? r.data.sold_quantity : null
  };
}

// --------- Catálogo (buy box) — requer OAuth ---------
import { getAccessToken } from "./token.js";

async function getBuyBoxPrice(productId) {
  const token = await getAccessToken().catch(() => null);
  if (!token) {
    return { ok:false, status:401, error_code:"AUTH_REQUIRED", message:"Token ausente/expirado para /products/{id}" };
  }
  const url = `${ML_BASE}/products/${productId}`;
  const r = await fetchJson(url, { token });
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
  // tentar vendidos do item vencedor
  let sold = null;
  if (winner.item_id) {
    const ir = await fetchJson(`${ML_BASE}/items/${winner.item_id}`, { token });
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
    let productId = String(q.product_id || "").trim();
    let myItemId  = String(q.my_item_id  || "").trim();
    const myPermalink = String(q.my_permalink || "").trim();

    // Se product_id for link de catálogo com #...wid=MLB..., extrair WID e tratar como item
    if (!isWID(productId)) {
      const wid = extractWidFromHash(productId);
      if (isWID(wid)) productId = wid;
    }

    // Se não for MLB válido e veio permalink, extrair
    if (!isWID(productId) && !isAnyMLB(productId) && myPermalink) {
      const fromPerma = extractItemIdFromPermalink(myPermalink);
      if (isWID(fromPerma)) myItemId = fromPerma;
    }

    // Decisão: catálogo (<10 dígitos) vs WID (>=10)
    if (isAnyMLB(productId)) {
      const digits = productId.replace(/MLB/i, "");
      const isCatalog = digits.length < 10;

      if (isCatalog) {
        // 1) Buy box
        const r = await getBuyBoxPrice(productId);
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
        // 2) Fallback: seu item (se informado)
        if (isWID(myItemId)) {
          const fr = await getItemPrice(myItemId);
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
        // 3) Erro estruturado
        return json(res, 200, {
          ok: false,
          error_code: r.error_code || "UPSTREAM_ERROR",
          message: r.message || "Falha ao consultar catálogo",
          http_status: r.status || 502,
          details: { upstream_url: r.url || `${ML_BASE}/products/${productId}` }
        });
      }

      // WID (item): SEM token
      const r = await getItemPrice(productId);
      if (!r.ok) {
        return json(res, 200, {
          ok:false,
          error_code: r.error_code || "UPSTREAM_ERROR",
          message: r.message || `Erro ${r.status} em /items`,
          http_status: r.status || 500,
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

    // Sem product_id MLB válido — tenta fallback para my_item_id/permalink
    if (isWID(myItemId)) {
      const r = await getItemPrice(myItemId);
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
        ok:false, error_code: r.error_code || "UPSTREAM_ERROR",
        message: r.message || `Erro ${r.status} em /items`,
        http_status: r.status || 500,
        details: { upstream_url: r.url }
      });
    }

    return json(res, 200, {
      ok:false,
      error_code: "MISSING_PARAM",
      message: "Envie product_id=MLB... (catálogo ou WID). Se colar link de catálogo com #...wid=MLB..., eu extraio automaticamente.",
      http_status: 400
    });
  } catch (e) {
    return json(res, 200, {
      ok:false, error_code:"INTERNAL", message:String(e?.message || e), http_status:500
    });
  }
}
