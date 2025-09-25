// api/ml/preco.js
// === WID-ONLY ===
// Entrada: ?wid=MLBxxxxxxxxxx  (aceita também ?product_id=MLB..., mas o recomendado é ?wid=)
// Saída: sempre JSON. Busca preço do ANÚNCIO via /items (não usa catálogo).
// Tenta público primeiro; se 401/403/5xx, tenta com OAuth (se existir token.js).

const ML_BASE = "https://api.mercadolibre.com";

// ---------- Utils ----------
const isWID = (s) => !!s && /^MLB\d{10,}$/i.test(String(s).trim());

function sendJSON(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// tenta carregar token.js dinamicamente (se não existir, segue sem token)
async function getTokenMaybe() {
  try {
    const mod = await import("./token.js");
    if (mod && typeof mod.getAccessToken === "function") {
      try {
        return await mod.getAccessToken();
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- HTTP helpers ----------
const PUBLIC_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Origin: "https://www.mercadolivre.com.br",
  Referer: "https://www.mercadolivre.com.br/"
};
const authHeaders = (token) => ({
  Accept: "application/json",
  "User-Agent": "WidOnly/1.0 (server)",
  "Cache-Control": "no-cache",
  Authorization: `Bearer ${token}`
});

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data, url, ct };
}

// Normaliza respostas do /items?ids=...
function normalizeBulk(r) {
  const arr = Array.isArray(r.data) ? r.data : [];
  const first = arr[0] || {};
  if (first.code === 200 && first.body) {
    return { ok: true, data: first.body, status: 200, url: r.url };
  }
  return { ok: false, status: r.status || 404, url: r.url };
}

// ---------- Core: obter preço por WID ----------
async function getPriceByWID(wid, token) {
  // Cadeia de tentativas (ordem pensada para maximizar sucesso):
  // Público (bulk com attrs) → Público (direto com attrs) → Público (direto simples) → Público (bulk simples)
  // Se falhar: com token (mesma ordem)
  const tries = [
    { kind: "public_bulk_attrs", url: `${ML_BASE}/items?ids=${wid}&attributes=price,status,available_quantity,sold_quantity,permalink`, headers: PUBLIC_HEADERS, bulk: true },
    { kind: "public_direct_attrs", url: `${ML_BASE}/items/${wid}?attributes=price,status,available_quantity,sold_quantity,permalink`, headers: PUBLIC_HEADERS },
    { kind: "public_direct", url: `${ML_BASE}/items/${wid}`, headers: PUBLIC_HEADERS },
    { kind: "public_bulk", url: `${ML_BASE}/items?ids=${wid}`, headers: PUBLIC_HEADERS, bulk: true },
  ];

  if (token) {
    tries.push(
      { kind: "auth_bulk_attrs", url: `${ML_BASE}/items?ids=${wid}&attributes=price,status,available_quantity,sold_quantity,permalink`, headers: authHeaders(token), bulk: true },
      { kind: "auth_direct_attrs", url: `${ML_BASE}/items/${wid}?attributes=price,status,available_quantity,sold_quantity,permalink`, headers: authHeaders(token) },
      { kind: "auth_direct", url: `${ML_BASE}/items/${wid}`, headers: authHeaders(token) },
      { kind: "auth_bulk", url: `${ML_BASE}/items?ids=${wid}`, headers: authHeaders(token), bulk: true },
    );
  }

  for (const t of tries) {
    const r = await fetchJson(t.url, t.headers);

    if (!r.ok) {
      // segue para próxima tentativa
      continue;
    }

    // bulk → normaliza
    if (t.bulk) {
      const nb = normalizeBulk(r);
      if (!nb.ok) continue;
      const body = nb.data || {};
      const price = Number(body.price || 0);
      if (price > 0) {
        return {
          ok: true,
          price,
          item_id: wid,
          sold_winner: Number.isFinite(body.sold_quantity) ? body.sold_quantity : null,
          via: t.kind
        };
      }
      // sem preço → tenta próxima
      continue;
    }

    // direta
    const body = r.data || {};
    const price = Number(body.price || 0);
    if (price > 0) {
      return {
        ok: true,
        price,
        item_id: wid,
        sold_winner: Number.isFinite(body.sold_quantity) ? body.sold_quantity : null,
        via: t.kind
      };
    }
  }

  // se chegou aqui, todas tentativas falharam
  return {
    ok: false,
    status: 401,
    error_code: "UPSTREAM_ERROR",
    message: "Falha ao obter preço do WID (todas as tentativas).",
    url: "all-fallbacks"
  };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    // CORS/JSON
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") return sendJSON(res, 200, { ok: true });
    if (req.method !== "GET")     return sendJSON(res, 200, { ok:false, error_code:"METHOD_NOT_ALLOWED", http_status:405 });

    // Somente WID — aceitar ?wid=... (recomendado) ou ?product_id=... por compatibilidade
    const q   = req.query || {};
    const wid = String(q.wid || q.product_id || "").trim().toUpperCase();

    if (!isWID(wid)) {
      return sendJSON(res, 200, {
        ok:false,
        error_code: "MISSING_WID",
        message: "Envie wid=MLBxxxxxxxxxx (somente WID, 10+ dígitos).",
        http_status: 400
      });
    }

    // tenta com público; se falhar, tenta com token (se houver)
    const token = await getTokenMaybe();
    const out   = await getPriceByWID(wid, token);

    if (!out.ok) {
      return sendJSON(res, 200, {
        ok:false,
        error_code: out.error_code || "UPSTREAM_ERROR",
        message: out.message || "Falha ao consultar WID",
        http_status: out.status || 500,
        details: { upstream_url: out.url }
      });
    }

    return sendJSON(res, 200, {
      ok: true,
      price: out.price,
      source: "item",
      product_id: wid,
      item_id: out.item_id,
      sold_winner: out.sold_winner,
      fetched_at: new Date().toISOString()
    });

  } catch (e) {
    return sendJSON(res, 200, { ok:false, error_code:"INTERNAL", message:String(e?.message || e), http_status:500 });
  }
}
