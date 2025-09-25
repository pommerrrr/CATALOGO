// api/ml/preco.js
// WID-only: usa exclusivamente o MLB do anúncio (WID), vindo de
//   - my_item_id=MLBxxxxxxxxxx
//   - product_id=MLBxxxxxxxxxx
//   - product_id=<link-de-catalogo-com-#...wid=MLBxxxxxxxxxx>
//
// Busca o preço apenas em /items/{id}, com fallbacks para /items?ids={id}
// e alternando sem/COM token para evitar 403/401.
//
// Opcional: definir ML_TOKEN (env) para chamadas autenticadas quando necessário.

const ML_BASE = "https://api.mercadolibre.com";

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function isValidMLB(id, minDigits = 10) {
  if (!id) return false;
  return /^MLB\d{10,}$/i.test(String(id).trim());
}

function extractWidFromUrl(possibleUrl) {
  if (!possibleUrl) return null;
  try {
    // procura no fragmento (#...) por wid=MLBxxxxxxxxxx
    const hash = String(possibleUrl).split("#")[1] || "";
    const m = hash.match(/wid=(MLB\d{10,})/i);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

async function getAccessTokenMaybe() {
  // 1) variáveis de ambiente
  if (process.env.ML_TOKEN) return process.env.ML_TOKEN;

  // 2) se você tiver um helper opcional em api/ml/token.js exportando getAccessToken()
  //    tentamos importar dinamicamente (não quebra caso não exista):
  try {
    const mod = await import("./token.js");
    if (typeof mod.getAccessToken === "function") {
      return await mod.getAccessToken();
    }
  } catch {}
  return null;
}

async function fetchJson(url, { withAuth = false, token = null } = {}) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "ImportControl/1.0 (server)",
  };
  if (withAuth && token) headers.Authorization = `Bearer ${token}`;

  const r = await fetch(url, { headers });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data };
}

async function fetchItemDirect(itemId, authFirst = false) {
  const url = `${ML_BASE}/items/${itemId}?fields=price,status,available_quantity,sold_quantity,permalink`;
  const token = await getAccessTokenMaybe();

  const attempts = authFirst
    ? [{ withAuth: true, token }, { withAuth: false }]
    : [{ withAuth: false }, { withAuth: true, token }];

  for (const a of attempts) {
    const r = await fetchJson(url, a);
    if (r.ok) return r;
    // só troca a estratégia se for 401/403; outros erros retornam direto
    if (![401, 403].includes(r.status)) return r;
  }
  return { ok: false, status: 403, data: null };
}

async function fetchItemBulk(itemId, authFirst = false) {
  const url = `${ML_BASE}/items?ids=${itemId}`;
  const token = await getAccessTokenMaybe();

  const attempts = authFirst
    ? [{ withAuth: true, token }, { withAuth: false }]
    : [{ withAuth: false }, { withAuth: true, token }];

  for (const a of attempts) {
    const r = await fetchJson(url, a);
    if (!r.ok) {
      if (![401, 403].includes(r.status)) return r;
      continue;
    }
    const arr = Array.isArray(r.data) ? r.data : [];
    const first = arr[0] || {};
    if (first.code === 200 && first.body) {
      return { ok: true, status: 200, data: first.body };
    }
    return { ok: false, status: 404, data: null };
  }
  return { ok: false, status: 403, data: null };
}

async function fetchItemAny(itemId) {
  // 1) /items sem auth → com auth
  let r = await fetchItemDirect(itemId, false);
  if (r.ok) return r;

  // 2) /items?ids sem auth → com auth
  r = await fetchItemBulk(itemId, false);
  if (r.ok) return r;

  // 3) /items com auth → sem auth (ordem invertida)
  r = await fetchItemDirect(itemId, true);
  if (r.ok) return r;

  // 4) /items?ids com auth → sem auth (ordem invertida)
  r = await fetchItemBulk(itemId, true);
  return r;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const debug = u.searchParams.get("debug") === "1";

    // Entrada pode vir como my_item_id (preferido) ou product_id
    let myItemId = (u.searchParams.get("my_item_id") || "").toUpperCase();
    const productInput = u.searchParams.get("product_id") || "";

    // Se não veio my_item_id válido, tentar extrair do product_id:
    if (!isValidMLB(myItemId)) {
      // 1) product_id já é um WID?
      if (isValidMLB(productInput)) {
        myItemId = productInput.toUpperCase();
      }
      // 2) link de catálogo com #...wid=MLB...?
      if (!isValidMLB(myItemId)) {
        const wid = extractWidFromUrl(productInput);
        if (isValidMLB(wid)) myItemId = wid;
      }
    }

    if (!isValidMLB(myItemId)) {
      return json(res, 200, {
        ok: false,
        error_code: "MISSING_WID",
        message:
          "Informe o WID (MLB do anúncio), por exemplo MLB4897879806. Se colar o link do catálogo com #...wid=MLB..., eu extraio automaticamente.",
        http_status: 400,
        _debug: debug ? { productInput, myItemId } : undefined,
      });
    }

    const r = await fetchItemAny(myItemId);
    if (!r.ok) {
      return json(res, 200, {
        ok: false,
        error_code: "ITEM_ERROR",
        message: `Erro ${r.status} ao consultar /items`,
        http_status: r.status,
        details: { upstream: "/items ou /items?ids" },
        _debug: debug ? { tried: "items,bulk", status: r.status } : undefined,
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
