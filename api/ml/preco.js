// api/ml/preco.js
// === SOMENTE WID (MLB com 10+ dígitos) ===
// Uso:  GET /api/ml/preco?wid=MLB1234567890   (compat: ?product_id=MLB...)
// Retorna SEMPRE JSON com o preço do ANÚNCIO.
// Ordem de tentativas:
//  1) COM TOKEN no header  → /items (direto/bulk, com/sem attributes)
//  2) COM TOKEN na query   → /items (direto/bulk, com/sem attributes)
//  3) PÚBLICO (sem token)  → /items (direto/bulk, com/sem attributes)
//  4) BUSCA pública        → /sites/MLB/search?q=WID (com token → token na query → público)
//  5) (Opcional) SCRAPE HTML da página do anúncio (se ENABLE_SCRAPE_FALLBACK=1)
//
// Observações:
// - Muitos ambientes passaram a exigir token inclusive em endpoints antes "públicos".
// - Se ainda assim falhar com WIDs de terceiros, ative o scrape fallback e/ou fixe a região GRU1.

const ML_BASE = "https://api.mercadolibre.com";

// ---------- Utils ----------
const isWID = (s) => !!s && /^MLB\d{10,}$/i.test(String(s).trim());
const nowISO = () => new Date().toISOString();

function sendJSON(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// tenta carregar token.js (named ou default). Se falhar, retorna null.
async function getTokenMaybe() {
  try {
    const mod = await import("./token.js");
    const fn =
      (mod && typeof mod.getAccessToken === "function" && mod.getAccessToken) ||
      (mod && typeof mod.default === "function" && mod.default) ||
      null;
    if (!fn) return null;
    const t = await fn().catch(() => null);
    return (typeof t === "string" && t.trim()) ? t.trim() : null;
  } catch {
    return null;
  }
}

function addAccessToken(url, token) {
  if (!token) return url;
  return url + (url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(token);
}

// ---------- HTTP helpers ----------
const PUBLIC_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Cache-Control": "no-cache"
};

function authHeaders(token) {
  const h = {
    Accept: "application/json",
    "User-Agent": "WidOnly/1.0 (server)",
    "Cache-Control": "no-cache",
    Authorization: `Bearer ${token}`
  };
  if (process.env.ML_INTEGRATOR_ID) {
    h["x-integrator-id"] = String(process.env.ML_INTEGRATOR_ID);
  }
  return h;
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  const ct = r.headers.get("content-type") || "";
  const reqId = r.headers.get("x-request-id") || r.headers.get("x-request-id-meli") || null;
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  } else {
    try {
      const txt = await r.text();
      data = { _text: txt.slice(0, 2000) }; // limita para debug
    } catch {}
  }
  return { ok: r.ok, status: r.status, data, url, ct, reqId };
}

// normaliza /items?ids=...
function normalizeBulk(r) {
  const arr = Array.isArray(r.data) ? r.data : [];
  const first = arr[0] || {};
  if (first.code === 200 && first.body) {
    return { ok: true, data: first.body, status: 200, url: r.url, ct: r.ct, reqId: r.reqId };
  }
  return { ok: false, status: first.code || r.status || 404, url: r.url, ct: r.ct, reqId: r.reqId };
}

function extractPriceSold(body) {
  const price = Number(body?.price || 0);
  const sold  = Number.isFinite(body?.sold_quantity) ? body.sold_quantity : null;
  return { price, sold };
}

// ---------- BUSCA pública de fallback ----------
async function getPriceViaSearch(wid, mode, token) {
  let url = `${ML_BASE}/sites/MLB/search?q=${encodeURIComponent(wid)}&limit=3`;
  let headers = PUBLIC_HEADERS;
  if (mode === "auth_header" && token) {
    headers = authHeaders(token);
  } else if (mode === "auth_query" && token) {
    url = addAccessToken(url, token);
  }

  const r = await fetchJson(url, headers);
  if (!r.ok) return { ok:false, status:r.status, url, ct:r.ct, reqId:r.reqId, where:"search" };

  const results = Array.isArray(r.data?.results) ? r.data.results : [];
  let hit = results.find(x => (x && String(x.id).toUpperCase() === wid));
  if (!hit) {
    hit = results.find(x => (x?.permalink || "").toUpperCase().includes(wid));
  }
  if (!hit) return { ok:false, status:404, url, ct:r.ct, reqId:r.reqId, where:"search_no_hit" };

  const price = Number(hit.price || 0);
  if (price > 0) return { ok:true, price, where:"search" };
  return { ok:false, status:404, url, ct:r.ct, reqId:r.reqId, where:"search_no_price" };
}

// ---------- SCRAPE (opcional, último recurso) ----------
const HTML_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
};

function parsePriceFromHtml(html) {
  // tenta achar JSON-LD com offers.price
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scripts) {
    const raw = m[1];
    try {
      const data = JSON.parse(raw);
      // data pode ser objeto ou array
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const offers = node?.offers;
        if (!offers) continue;
        if (Array.isArray(offers)) {
          for (const off of offers) {
            const p = Number(off?.price || 0);
            if (p > 0) return p;
          }
        } else if (typeof offers === "object") {
          const p = Number(offers?.price || 0);
          if (p > 0) return p;
        }
      }
    } catch {}
  }
  // fallback: regex simples (menos confiável)
  const mPrice = html.match(/"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (mPrice) {
    const p = Number(mPrice[1]);
    if (p > 0) return p;
  }
  return null;
}

async function scrapePrice(wid) {
  // tentamos duas URLs comuns de item
  const urls = [
    `https://produto.mercadolivre.com.br/${wid}`,
    `https://www.mercadolivre.com.br/${wid}`
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: HTML_HEADERS, redirect: "follow" });
      if (!r.ok) continue;
      const html = await r.text();
      const price = parsePriceFromHtml(html);
      if (price && price > 0) {
        return { ok:true, price, url };
      }
    } catch {}
  }
  return { ok:false };
}

// ---------- Core: obter preço por WID ----------
async function getPriceByWID(wid, token) {
  const ATTRS = "price,status,available_quantity,sold_quantity,permalink";

  // 1) COM TOKEN no header (se houver)
  const triesHeader = token ? [
    { kind: "auth_direct_attrs", url: `${ML_BASE}/items/${wid}?attributes=${ATTRS}`, headers: authHeaders(token) },
    { kind: "auth_bulk_attrs",   url: `${ML_BASE}/items?ids=${wid}&attributes=${ATTRS}`, headers: authHeaders(token), bulk: true },
    { kind: "auth_direct",       url: `${ML_BASE}/items/${wid}`, headers: authHeaders(token) },
    { kind: "auth_bulk",         url: `${ML_BASE}/items?ids=${wid}`, headers: authHeaders(token), bulk: true }
  ] : [];

  // 2) COM TOKEN na query (?access_token=...)
  const triesQuery = token ? [
    { kind: "authq_direct_attrs", url: addAccessToken(`${ML_BASE}/items/${wid}?attributes=${ATTRS}`, token), headers: PUBLIC_HEADERS },
    { kind: "authq_bulk_attrs",   url: addAccessToken(`${ML_BASE}/items?ids=${wid}&attributes=${ATTRS}`, token), headers: PUBLIC_HEADERS, bulk: true },
    { kind: "authq_direct",       url: addAccessToken(`${ML_BASE}/items/${wid}`, token), headers: PUBLIC_HEADERS },
    { kind: "authq_bulk",         url: addAccessToken(`${ML_BASE}/items?ids=${wid}`, token), headers: PUBLIC_HEADERS, bulk: true }
  ] : [];

  // 3) PÚBLICO
  const triesPublic = [
    { kind: "public_direct_attrs", url: `${ML_BASE}/items/${wid}?attributes=${ATTRS}`, headers: PUBLIC_HEADERS },
    { kind: "public_bulk_attrs",   url: `${ML_BASE}/items?ids=${wid}&attributes=${ATTRS}`, headers: PUBLIC_HEADERS, bulk: true },
    { kind: "public_direct",       url: `${ML_BASE}/items/${wid}`, headers: PUBLIC_HEADERS },
    { kind: "public_bulk",         url: `${ML_BASE}/items?ids=${wid}`, headers: PUBLIC_HEADERS, bulk: true }
  ];

  const sequences = [triesHeader, triesQuery, triesPublic];

  for (const seq of sequences) {
    for (const t of seq) {
      const r = await fetchJson(t.url, t.headers);
      if (!r.ok) continue;

      if (t.bulk) {
        const nb = normalizeBulk(r);
        if (!nb.ok) continue;
        const { price, sold } = extractPriceSold(nb.data);
        if (price > 0) {
          return {
            ok: true,
            price,
            item_id: wid,
            sold_winner: sold,
            via: t.kind
          };
        }
        continue;
      }

      const { price, sold } = extractPriceSold(r.data);
      if (price > 0) {
        return {
          ok: true,
          price,
          item_id: wid,
          sold_winner: sold,
          via: t.kind
        };
      }
    }
  }

  // 4) BUSCA: token header → token na query → público
  const searchModes = token ? ["auth_header", "auth_query", "public"] : ["public"];
  for (const m of searchModes) {
    const sr = await getPriceViaSearch(wid, m, token);
    if (sr.ok) {
      return { ok:true, price: sr.price, item_id: wid, sold_winner: null, via: sr.where };
    }
  }

  // 5) SCRAPE (se autorizado via env)
  if (String(process.env.ENABLE_SCRAPE_FALLBACK || "") === "1") {
    const scr = await scrapePrice(wid);
    if (scr.ok) {
      return { ok:true, price: scr.price, item_id: wid, sold_winner: null, via: "scrape" };
    }
  }

  // Falha geral
  return {
    ok: false,
    status: 401,
    error_code: "UPSTREAM_ERROR",
    message: "Falha ao obter preço do WID (itens, busca e scrape desativado).",
    details: { phase: "all-fallbacks-exhausted" }
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

    // Apenas WID — use ?wid= (compat: ?product_id=)
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

    const token = await getTokenMaybe(); // pode ser null
    const out   = await getPriceByWID(wid, token);

    if (!out.ok) {
      return sendJSON(res, 200, {
        ok:false,
        error_code: out.error_code || "UPSTREAM_ERROR",
        message: out.message || "Falha ao consultar WID",
        http_status: out.status || 500,
        details: out.details || {}
      });
    }

    return sendJSON(res, 200, {
      ok: true,
      price: out.price,
      source: "item",
      product_id: wid,
      item_id: out.item_id,
      sold_winner: out.sold_winner,
      fetched_at: nowISO()
    });

  } catch (e) {
    return sendJSON(res, 200, {
      ok:false,
      error_code:"INTERNAL",
      message:String(e?.message || e),
      http_status:500
    });
  }
}
