// api/ml/preco.js
// Busca preço do catálogo/ML com fallback pelo seu anúncio (wid/my_item_id).
// Correção: /items/{id} agora tenta SEM Authorization primeiro e só depois com token,
// evitando 403 quando o token não corresponde ao vendedor do anúncio.

const ML_BASE = "https://api.mercadolibre.com";

// Se você já tem esse helper de token no seu projeto, mantém.
// Se não tiver, tudo bem: o fluxo com wid/my_item_id funciona sem token.
let getAccessToken = null;
try {
  // tente importar helper existente (opcional)
  ({ getAccessToken } = await import("./token.js").catch(() => ({ getAccessToken: null })));
} catch (_) {
  getAccessToken = null;
}

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function isValidMLB(id, minDigits = 1) {
  if (!id) return false;
  const m = String(id).trim().match(new RegExp(`^MLB\\d{${minDigits},}$`, "i"));
  return !!m;
}

function extractWidFromUrlMaybe(url) {
  if (!url) return null;
  try {
    const hash = url.split("#")[1] || "";
    const m = hash.match(/wid=(MLB\d{10,})/i);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

async function fetchJson(url, opts = {}) {
  const { token, withAuth = false, ua = "ImportControl/1.0 (server)" } = opts;
  const headers = { Accept: "application/json", "User-Agent": ua };

  if (withAuth && token) headers.Authorization = `Bearer ${token}`;

  const r = await fetch(url, { headers });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return { ok: false, status: r.status, error: "NON_JSON", data: null };
  }
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// Tenta sem token e, se vier 401/403, tenta com token (se existir).
async function fetchItemSmart(itemId) {
  const url = `${ML_BASE}/items/${itemId}?fields=price,status,available_quantity,sold_quantity,permalink`;
  // 1) tentativa pública
  let r = await fetchJson(url, { withAuth: false });
  if (r.ok) return r;

  if (r.status === 401 || r.status === 403) {
    // 2) tentar com Authorization (se houver)
    let token = null;
    if (typeof getAccessToken === "function") {
      try {
        token = await getAccessToken();
      } catch (_) {
        token = null;
      }
    } else {
      token = process.env.ML_TOKEN || null;
    }
    if (token) {
      r = await fetchJson(url, { withAuth: true, token });
      if (r.ok) return r;
    }
  }
  return r;
}

// Buy box, se você ainda quiser tentar catálogo. Mantém como estava:
async function fetchBuyBox(productId) {
  const url = `${ML_BASE}/products/${productId}`;
  // products geralmente aceita sem token, mas já passamos sem auth primeiro:
  let r = await fetchJson(url, { withAuth: false });
  if (r.ok) return r;

  if (r.status === 401 || r.status === 403) {
    let token = null;
    if (typeof getAccessToken === "function") {
      try {
        token = await getAccessToken();
      } catch (_) {
        token = null;
      }
    } else {
      token = process.env.ML_TOKEN || null;
    }
    if (token) {
      r = await fetchJson(url, { withAuth: true, token });
      if (r.ok) return r;
    }
  }
  return r;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const productInput = u.searchParams.get("product_id") || "";
    // Pode vir my_item_id direto ou então um link de catálogo contendo #...wid=MLBxxxx
    let myItemId = u.searchParams.get("my_item_id") || "";
    const debug = u.searchParams.get("debug") === "1";

    // Suporte a link de catálogo com wid=MLB...
    if (!isValidMLB(myItemId, 10)) {
      const widFromHash = extractWidFromUrlMaybe(productInput);
      if (isValidMLB(widFromHash, 10)) myItemId = widFromHash;
    }

    // 1) Se temos my_item_id (wid), usa /items/{id}
    if (isValidMLB(myItemId, 10)) {
      const r = await fetchItemSmart(myItemId);
      if (!r.ok) {
        return json(res, 200, {
          ok: false,
          error_code: "ITEM_ERROR",
          message: `Erro ${r.status} em /items/{id}`,
          http_status: r.status,
          details: { upstream_url: `${ML_BASE}/items/${myItemId}` },
          _debug: debug ? { step: "items", status: r.status } : undefined,
        });
      }

      const price = Number(r.data?.price || 0);
      if (!price) {
        return json(res, 200, {
          ok: false,
          error_code: "NO_PRICE",
          message: "Anúncio sem preço disponível",
          http_status: 404,
          details: { item_status: r.data?.status },
        });
      }

      return json(res, 200, {
        ok: true,
        price,
        source: "my_item",
        product_id: isValidMLB(productInput, 1) ? productInput.toUpperCase() : undefined,
        item_id: myItemId,
        fetched_at: new Date().toISOString(),
        sold_winner: r.data?.sold_quantity ?? null,
        sold_catalog_total: null,
        _debug: debug ? { used: "items", status: r.status } : undefined,
      });
    }

    // 2) Senão, tenta buy box do catálogo (opcional)
    if (isValidMLB(productInput, 1)) {
      const r = await fetchBuyBox(productInput.toUpperCase());
      if (!r.ok) {
        return json(res, 200, {
          ok: false,
          error_code: "NO_BUY_BOX",
          message: "Catálogo sem buy box disponível via API no momento.",
          http_status: r.status,
          details: { upstream_url: `${ML_BASE}/products/${productInput}` },
          _debug: debug ? { step: "products", status: r.status } : undefined,
        });
      }

      const winner = r.data?.buy_box_winner || null;
      const price = Number(winner?.price || 0);
      if (!price) {
        return json(res, 200, {
          ok: false,
          error_code: "NO_BUY_BOX",
          message: "Catálogo sem buy box com preço.",
          http_status: 404,
        });
      }

      return json(res, 200, {
        ok: true,
        price,
        source: "buy_box",
        product_id: productInput.toUpperCase(),
        item_id: winner?.item_id || null,
        fetched_at: new Date().toISOString(),
        sold_winner: null,
        sold_catalog_total: null,
        _debug: debug ? { used: "products", status: r.status } : undefined,
      });
    }

    return json(res, 200, {
      ok: false,
      error_code: "MISSING_PARAM",
      message: "Informe product_id (MLB...) ou product link com wid=MLB..., e/ou my_item_id.",
      http_status: 400,
    });
  } catch (err) {
    return json(res, 200, {
      ok: false,
      error_code: "INTERNAL",
      message: "Erro interno",
      http_status: 500,
      details: { msg: err?.message },
    });
  }
}
