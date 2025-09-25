// api/ml/preco.js
// WID-only (MLB do anúncio) SEM TOKEN, para evitar 403 em itens que não são seus.
// Entradas aceitas:
//   - product_id = MLBxxxxxxxxxx (WID)
//   - product_id = <link do catálogo com #...wid=MLBxxxxxxxxxx>
//   - my_item_id = MLBxxxxxxxxxx (compatível)
//
// Fluxo: tenta /items/{id} (público) → se falhar, tenta /items?ids={id} (público).
// Nunca envia Authorization. Nunca tenta buy box / catálogo.

const ML_BASE = "https://api.mercadolibre.com";

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function isValidWID(id) {
  return !!id && /^MLB\d{10,}$/i.test(String(id).trim());
}

// Extrai wid=MLB... do fragmento (#...) de um link de catálogo
function extractWidFromUrl(possibleUrl) {
  if (!possibleUrl) return null;
  try {
    const hash = String(possibleUrl).split("#")[1] || "";
    const m = hash.match(/wid=(MLB\d{10,})/i);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

async function fetchPublicJson(url) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "ImportControl/1.0 (server)",
    // SEM Authorization!
  };
  const r = await fetch(url, { headers });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data, url };
}

// /items/{id} sem token
async function fetchItemPublic(wid) {
  // limitar campos ajuda e evita payload desnecessário
  const url = `${ML_BASE}/items/${wid}?attributes=price,status,available_quantity,sold_quantity,permalink`;
  return fetchPublicJson(url);
}

// /items?ids={id} sem token (bulk)
async function fetchItemBulkPublic(wid) {
  const url = `${ML_BASE}/items?ids=${wid}&attributes=price,status,available_quantity,sold_quantity,permalink`;
  const r = await fetchPublicJson(url);
  if (!r.ok) return r;
  const arr = Array.isArray(r.data) ? r.data : [];
  const first = arr[0] || {};
  if (first.code === 200 && first.body) {
    return { ok: true, status: 200, data: first.body, url };
  }
  return { ok: false, status: 404, data: null, url };
}

export default async function handler(req, res) {
  try {
    // CORS/JSON
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return json(res, 200, { ok: true });
    if (req.method !== "GET") {
      return json(res, 200, { ok:false, error_code:"METHOD_NOT_ALLOWED", message:"Only GET", http_status:405 });
    }

    const q = req.query || {};
    let productInput = String(q.product_id || "").trim(); // pode ser WID ou link com #...wid
    let myItemId = String(q.my_item_id || "").trim();     // compatível
    const debug = String(q.debug || "") === "1";

    // 1) Se não veio WID válido em my_item_id, extrair de product_id
    let wid = null;
    if (isValidWID(myItemId)) wid = myItemId.toUpperCase();

    if (!wid) {
      // product_id já é um WID?
      if (isValidWID(productInput)) {
        wid = productInput.toUpperCase();
      } else {
        // tenta extrair do fragmento #...wid=MLB...
        const fromUrl = extractWidFromUrl(productInput);
        if (isValidWID(fromUrl)) wid = fromUrl.toUpperCase();
      }
    }

    if (!isValidWID(wid)) {
      return json(res, 200, {
        ok: false,
        error_code: "MISSING_WID",
        message: "Informe o WID (MLB do anúncio), ex.: MLB4897879806. Você pode colar o link do catálogo com #...wid=MLB..., que eu extraio automaticamente.",
        http_status: 400,
        _debug: debug ? { productInput, myItemId } : undefined
      });
    }

    // 2) Tenta /items/{id} (público)
    let r = await fetchItemPublic(wid);
    if (!r.ok) {
      // se 401/403/404/5xx, tenta bulk público
      const rb = await fetchItemBulkPublic(wid);
      if (!rb.ok) {
        // falhou tudo
        return json(res, 200, {
          ok: false,
          error_code: "UPSTREAM_ERROR",
          message: `Erro ${rb.status} em ${rb.url.includes("?ids=") ? "/items?ids" : "/items/{id}"}`,
          http_status: rb.status,
          details: { upstream_url: rb.url },
          _debug: debug ? { first_try_status: r.status } : undefined
        });
      }
      r = rb; // usa resposta do bulk
    }

    // resposta OK (r.data é do /items ou r.data.body do bulk já normalizado acima)
    const body = r.data;
    const price = Number(body?.price || 0);
    if (!price) {
      return json(res, 200, {
        ok: false,
        error_code: "NO_PRICE",
        message: "Anúncio sem preço disponível",
        http_status: 404,
        details: { upstream_url: r.url },
        _debug: debug ? { body } : undefined
      });
    }

    return json(res, 200, {
      ok: true,
      price,
      source: "item",
      product_id: wid,
      item_id: wid,
      sold_winner: Number.isFinite(body?.sold_quantity) ? body.sold_quantity : null,
      sold_catalog_total: null,
      fetched_at: new Date().toISOString(),
      _debug: debug ? { via: r.url.includes("?ids=") ? "bulk" : "direct" } : undefined
    });

  } catch (err) {
    return json(res, 200, {
      ok:false, error_code:"INTERNAL", message:String(err?.message||err), http_status:500
    });
  }
}
