// api/ml/preco.js
// Somente WID (MLB do anúncio). Aceita my_item_id diretamente ou product_id
// (que pode ser um WID MLB... ou um link de catálogo contendo #...wid=MLB...).
// NÃO tenta mais buy box/catalogo. Busca preço exclusivamente em /items/{id}
// com fallbacks para evitar 403.

const ML_BASE = "https://api.mercadolibre.com";

// Tenta importar helper de token se você tiver (opcional):
let getAccessToken = null;
try {
  ({ getAccessToken } = await import("./token.js").catch(() => ({ getAccessToken: null })));
} catch {
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

// Extrai wid=MLB... do fragmento do link de catálogo
function extractWidFromUrl(url) {
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

// /items/{id} com/sem auth
async function fetchItemDirect(itemId, withAuthFirst = false) {
  const url = `${ML_BASE}/items/${itemId}?fields=price,status,available_quantity,sold_quantity,permalink`;
  let token = null;
  if (typeof getAccessToken === "function") {
    try { token = await getAccessToken(); } catch {}
  } else {
    token = process.env.ML_TOKEN || null;
  }

  // ordem: se withAuthFirst==true tenta com token primeiro; senão tenta público primeiro
  const attempts = [];
  if (withAuthFirst) {
    attempts.push({ withAuth: true, token }, { withAuth: false });
  } else {
    attempts.push({ withAuth: false }, { withAuth: true, token });
  }

  for (const a of attempts) {
    const r = await fetchJson(url, a);
    if (r.ok) return r;
    if (![401, 403].includes(r.status)) return r; // outros erros: retorna já
    // 401/403: tenta próxima variação
  }
  // se chegou aqui, falhou ambas
  return { ok: false, status: 403, data: null };
}

// /items?ids=MLBxxxx (bulk) – às vezes retorna mesmo quando /items/{id} dá 403
async function fetchItemBulk(itemId, withAuthFirst = false) {
  const url = `${ML_BASE}/items?ids=${itemId}`;
  let token = null;
  if (typeof getAccessToken === "function") {
    try { token = await getAccessToken(); } catch {}
  } else {
    token = process.env.ML_TOKEN || null;
  }

  const attempts = [];
  if (withAuthFirst) {
    attempts.push({ withAuth: true, token }, { withAuth: false });
  } else {
    attempts.push({ withAuth: false }, { withAuth: true, token });
  }

  for (const a of attempts) {
    const r = await fetchJson(url, a);
    if (!r.ok) {
      if (![401, 403].includes(r.status)) return r;
      continue; // tenta a próxima
    }
    // formato: [{code:200, body: {...}}]
    const arr = Array.isArray(r.data) ? r.data : [];
    const first = arr[0] || {};
    if (first.code !== 200 || !first.body) {
      return { ok: false, status: 404, data: null };
    }
    return { ok: true, status: 200, data: first.body };
  }
  return { ok: false, status: 403, data: null };
}

// Busca preço robusta: tenta /items, depois bulk; alterna auth/não-auth
async function fetchItemAny(itemId) {
  // 1) /items sem auth → com auth
  let r = await fetchItemDirect(itemId, false);
  if (r.ok) return r;
  // 2) /items bulk sem auth → com auth
  r = await fetchItemBulk(itemId, false);
  if (r.ok) return r;
  // 3) /items com auth → sem auth (ordem invertida)
  r = await fetchItemDirect(itemId, true);
  if (r.ok) return r;
  // 4) bulk com auth → sem auth (ordem invertida)
  r = await fetchItemBulk(itemId, true);
  return r;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    // entrada pode vir em qualquer desses:
    // - my_item_id=MLBxxxxxxxxxx (recomendado)
    // - product_id=MLBxxxxxxxxxx (vamos tratar como WID também)
    // - product_id=<link-do-catalogo-com-#...wid=MLBxxxxxxxxxx>
    let myItemId = u.searchParams.get("my_item_id") || "";
    const productInput = u.searchParams.get("product_id") || "";
    const debug = u.searchParams.get("debug") === "1";

    // Se não veio my_item_id, tentar extrair do product_id:
    if (!isValidMLB(myItemId, 10)) {
      // 1) product_id já é um WID (MLB com 10+ dígitos)?
      if (isValidMLB(productInput, 10)) {
        myItemId = productInput.toUpperCase();
      }
      // 2) ou link de catálogo com #...wid=MLB...?
      if (!isValidMLB(myItemId, 10)) {
        const widFromUrl = extractWidFromUrl(productInput);
        if (isValidMLB(widFromUrl, 10)) myItemId = widFromUrl;
      }
    }

    if (!isValidMLB(myItemId, 10)) {
      return json(res, 200, {
        ok: false,
        error_code: "MISSING_WID",
        message:
          "Informe o WID (MLB do anúncio), por exemplo MLB4897879806. Você pode colar o link do catálogo com #...wid=MLB..., que eu extraio automaticamente.",
        http_status: 400,
        _debug: debug ? { productInput, myItemId } : undefined,
      });
    }

    const r = await fetchItemAny(myItemId);
    if (!r.ok) {
      return json(res, 200, {
        ok: false,
        error_code: "ITEM_ERROR",
        message: `Erro ${r.status} em /items`,
        http_status: r.status,
        details: { upstream: "/items or /items?ids" },
        _debug: debug ? { tried: "items, bulk", status: r.status } : undefined,
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
        _debug: debug ? { body: r.data } : undefined,
      });
    }

    return json(res, 200, {
      ok: true,
      price,
      source: "my_item",
      item_id: myItemId,
      fetched_at: new Date().toISOString(),
      sold_winner: r.data?.sold_quantity ?? null,
      _debug: debug ? { used: "my_item" } : undefined,
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
