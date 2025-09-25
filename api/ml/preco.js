// api/ml/preco.js
// Funciona com:
//   • WID (MLB do anúncio) em product_id=MLBxxxxxxxxxx  ← novo layout
//   • Link de catálogo com #...wid=MLBxxxxxxxxxx (product_id pode ser a URL)
//   • (Opcional) my_item_id / my_permalink (mantido para compatibilidade)
//
// Regras:
//   • Se ID tiver < 10 dígitos: trata como catálogo → /products/{id} (buy box).
//   • Caso contrário: trata como WID → tenta /items/{id} com fallbacks:
//       - /items/{id} sem token → com token
//       - /items?ids={id} sem token → com token
//
// Token:
//   • Se existir ML_TOKEN nas variáveis de ambiente, será usado.
//   • Se existir ./token.js exportando getAccessToken(), também será usado.

const ML_BASE = "https://api.mercadolibre.com";

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function buildHeaders(token) {
  const h = { Accept: "application/json", "User-Agent": "ImportControl/1.0 (server)" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function isValidMLB(id, minDigits = 10) {
  if (!id) return false;
  return /^MLB\d{10,}$/i.test(String(id).trim());
}

function isAnyMLB(id) {
  return /^MLB\d+$/i.test(String(id).trim());
}

function extractItemIdFromPermalink(url) {
  if (!url) return null;
  try {
    const m = String(url).match(/MLB\d{10,}/i);
    return m ? m[0].toUpperCase() : null;
  } catch { return null; }
}

function extractWidFromUrlFragment(possibleUrl) {
  // para links de catálogo com "#...wid=MLBxxxxxxxxxx"
  if (!possibleUrl) return null;
  try {
    const hash = String(possibleUrl).split("#")[1] || "";
    const m = hash.match(/wid=(MLB\d{10,})/i);
    return m ? m[1].toUpperCase() : null;
  } catch { return null; }
}

async function getAccessTokenMaybe() {
  // 1) ML_TOKEN no ambiente
  if (process.env.ML_TOKEN) return process.env.ML_TOKEN;
  // 2) helper opcional ./token.js
  try {
    const mod = await import("./token.js");
    if (typeof mod.getAccessToken === "function") {
      return await mod.getAccessToken();
    }
  } catch {}
  return null;
}

async function fetchJson(url, { withAuth = false, token = null } = {}) {
  const headers = buildHeaders(withAuth && token ? token : null);
  const r = await fetch(url, { headers });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data, ct, url };
}

// ---------- Fallbacks para WID (/items) ----------
async function fetchItemWithFallbacks(itemId) {
  const token = await getAccessTokenMaybe();

  // Ordem: /items → /items?ids, alternando sem/​com token
  const attempts = [
    { url: `${ML_BASE}/items/${itemId}`, withAuth: false },
    { url: `${ML_BASE}/items/${itemId}`, withAuth: true },
    { url: `${ML_BASE}/items?ids=${itemId}`, withAuth: false, bulk: true },
    { url: `${ML_BASE}/items?ids=${itemId}`, withAuth: true, bulk: true },
  ];

  for (const a of attempts) {
    const r = await fetchJson(a.url, { withAuth: a.withAuth, token });
    if (r.ok) {
      if (a.bulk) {
        const arr = Array.isArray(r.data) ? r.data : [];
        const first = arr[0] || {};
        if (first.code === 200 && first.body) {
          return { ok: true, body: first.body, via: a.url };
        }
      } else {
        return { ok: true, body: r.data, via: a.url };
      }
    }
    // se não ok, só troca a estratégia quando for 401/403;
    // erros 404/5xx retornam direto para reportar ao cliente
    if (![401, 403].includes(r.status)) {
      return { ok: false, status: r.status, via: a.url };
    }
  }
  return { ok: false, status: 403, via: "all-attempts" };
}

// ---------- Buy box de catálogo ----------
async function fetchCatalogBuyBox(productId) {
  const token = await getAccessTokenMaybe();
  if (!token) {
    return { ok:false, status:401, err:"AUTH_REQUIRED", url:`${ML_BASE}/products/${productId}` };
  }
  const r = await fetchJson(`${ML_BASE}/products/${productId}`, { withAuth: true, token });
  if (!r.ok) return { ok:false, status:r.status, url:r.url };
  const winner = r.data?.buy_box_winner;
  if (!(winner?.price > 0)) return { ok:false, status:404, url:r.url, noWinner:true };
  // tente buscar sold_quantity do item vencedor
  let sold = null;
  if (winner.item_id) {
    const ir = await fetchJson(`${ML_BASE}/items/${winner.item_id}`, { withAuth: true, token });
    if (ir.ok && Number.isFinite(ir.data?.sold_quantity)) sold = ir.data.sold_quantity;
  }
  return { ok:true, price:winner.price, item_id:winner.item_id || null, sold };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    // CORS/JSON
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return json(res, 200, { ok: true });
    if (req.method !== "GET") {
      return json(res, 200, { ok:false, error_code:"METHOD_NOT_ALLOWED", message:"Only GET", http_status:405 });
    }

    const q = req.query || {};
    let productId = String(q.product_id || "").trim(); // novo layout: só product_id
    let myItemId = String(q.my_item_id || "").trim();  // compat
    const myPermalink = String(q.my_permalink || "").trim(); // compat
    const debug = String(q.debug || "") === "1";

    if (!productId && !myItemId && !myPermalink) {
      return json(res, 200, { ok:false, error_code:"MISSING_PARAM", message:"Envie product_id (WID/MLB ou link com #...wid=MLB...), ou my_item_id / my_permalink.", http_status:400 });
    }

    // 1) permitir que product_id seja um link de catálogo com #...wid=MLBxxxxxxxxxx
    if (!isAnyMLB(productId)) {
      const wid = extractWidFromUrlFragment(productId);
      if (wid) productId = wid;
    }

    // 2) se ainda não é MLB, mas veio permalink, extrair
    if (!isAnyMLB(productId) && myPermalink) {
      const fromPermalink = extractItemIdFromPermalink(myPermalink);
      if (fromPermalink) myItemId = fromPermalink;
    }

    // 3) se my_item_id não é válido, ignora
    if (!isValidMLB(myItemId)) myItemId = "";

    // 4) decidir: catálogo vs WID
    if (isAnyMLB(productId)) {
      const numeric = productId.replace(/MLB/i, "");
      const isCatalog = numeric.length < 10;
      const fetched_at = new Date().toISOString();

      if (isCatalog) {
        // ---- Catálogo: buy box ----
        const r = await fetchCatalogBuyBox(productId);
        if (r.ok) {
          return json(res, 200, {
            ok: true,
            price: r.price,
            source: "buy_box",
            product_id: productId,
            item_id: r.item_id,
            sold_winner: r.sold,
            sold_catalog_total: null,
            fetched_at
          });
        }

        // fallback: seu item se tiver sido informado
        if (myItemId) {
          const fr = await fetchItemWithFallbacks(myItemId);
          if (fr.ok) {
            const price = Number(fr.body?.price || 0);
            if (price > 0) {
              return json(res, 200, {
                ok: true,
                price,
                source: "my_item",
                product_id: productId,
                item_id: myItemId,
                sold_winner: Number.isFinite(fr.body?.sold_quantity) ? fr.body.sold_quantity : null,
                sold_catalog_total: null,
                fetched_at
              });
            }
          }
        }

        // sem buy box e sem fallback válido
        const errMsg =
          r.status === 401 ? "Token ausente/expirado para /products/{id}" :
          r.status === 403 ? "Permissões insuficientes para /products/{id}" :
          r.noWinner    ? "Catálogo sem buy box disponível via API no momento." :
          `Erro ${r.status} em /products/{id}`;

        return json(res, 200, {
          ok:false,
          error_code: r.status === 401 ? "AUTH_REQUIRED" :
                      r.status === 403 ? "FORBIDDEN" :
                      r.noWinner ? "NO_BUY_BOX" : "UPSTREAM_ERROR",
          message: errMsg,
          http_status: r.status || 404,
          details: { upstream_url: `${ML_BASE}/products/${productId}` }
        });
      }

      // ---- WID (item) ----
      const fr = await fetchItemWithFallbacks(productId);
      if (!fr.ok) {
        return json(res, 200, {
          ok:false,
          error_code:"UPSTREAM_ERROR",
          message:`Erro ${fr.status} em ${fr.via.includes("?ids=") ? "/items?ids" : "/items/{id}"}`,
          http_status: fr.status,
          details: { upstream_url: fr.via },
          _debug: debug ? { productId } : undefined
        });
      }

      const price = Number(fr.body?.price || 0);
      if (!price) {
        return json(res, 200, {
          ok:false,
          error_code:"NO_PRICE",
          message:"Anúncio sem preço disponível",
          http_status:404,
          details: { upstream_url: fr.via },
          _debug: debug ? { body: fr.body } : undefined
        });
      }

      return json(res, 200, {
        ok: true,
        price,
        source: "item",
        product_id: productId,
        item_id: productId,
        sold_winner: Number.isFinite(fr.body?.sold_quantity) ? fr.body.sold_quantity : null,
        sold_catalog_total: null,
        fetched_at
      });
    }

    // Se chegar aqui e existir myItemId válido, trata como WID
    if (isValidMLB(myItemId)) {
      const fr = await fetchItemWithFallbacks(myItemId);
      if (!fr.ok) {
        return json(res, 200, {
          ok:false,
          error_code:"UPSTREAM_ERROR",
          message:`Erro ${fr.status} em ${fr.via.includes("?ids=") ? "/items?ids" : "/items/{id}"}`,
          http_status: fr.status,
          details: { upstream_url: fr.via }
        });
      }
      const price = Number(fr.body?.price || 0);
      if (!price) {
        return json(res, 200, {
          ok:false, error_code:"NO_PRICE", message:"Anúncio sem preço disponível",
          http_status:404, details:{ upstream_url: fr.via }
        });
      }
      return json(res, 200, {
        ok: true, price, source:"item",
        product_id: myItemId, item_id: myItemId, sold_winner: Number.isFinite(fr.body?.sold_quantity) ? fr.body.sold_quantity : null, sold_catalog_total: null,
        fetched_at: new Date().toISOString()
      });
    }

    return json(res, 200, {
      ok:false, error_code:"INVALID_ID_FORMAT",
      message:"Envie um MLB válido (ex.: MLB4897879806) ou link de catálogo com #...wid=MLB...",
      http_status:400,
      _debug: debug ? { productId, myItemId, myPermalink } : undefined
    });
  } catch (err) {
    return json(res, 200, {
      ok:false, error_code:"INTERNAL", message:String(err?.message||err), http_status:500
    });
  }
}
