// api/ml/preco.js
// === SOMENTE WID (MLB com 10+ dígitos) ===
// GET /api/ml/preco?wid=MLB1234567890 (&debug=1 [&sf=1])
// Ordem: token header → token query → público → busca → (opcional) scrape
// Melhorias: extractor completo + debug probe + scraper mais potente.

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
  const reqId = r.headers.get("x-request-id")
    || r.headers.get("x-request-id-meli")
    || r.headers.get("x-request-id-ml")
    || null;
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
  return {
    ok: false,
    status: first.code || r.status || 404,
    url: r.url, ct: r.ct, reqId: r.reqId,
    raw: first
  };
}

// ---------- Price extractors ----------
function extractFromPricesObject(pricesObj) {
  const list = Array.isArray(pricesObj?.prices) ? pricesObj.prices : [];
  if (!list.length) return null;
  const candidates = list
    .filter(p => Number(p?.amount) > 0 && (!p.currency_id || p.currency_id === "BRL"))
    .filter(p => !p.status || p.status === "active" || p.status === "available")
    .sort((a,b) => new Date(b.last_updated || 0) - new Date(a.last_updated || 0));
  if (candidates.length) return Number(candidates[0].amount);
  return null;
}

function extractFromVariations(variations) {
  if (!Array.isArray(variations) || !variations.length) return null;
  const vals = variations.map(v => Number(v?.price || 0)).filter(p => p > 0);
  if (!vals.length) return null;
  return Math.min(...vals);
}

function extractPriceSold(body) {
  // 1) diretos
  let price = Number(body?.price || body?.base_price || body?.original_price || 0);
  let sold  = Number.isFinite(body?.sold_quantity) ? body.sold_quantity : null;
  if (price > 0) return { price, sold };

  // 2) prices.prices
  const fromPrices = extractFromPricesObject(body?.prices);
  if (Number(fromPrices) > 0) return { price: Number(fromPrices), sold };

  // 3) variations[]
  const fromVars = extractFromVariations(body?.variations);
  if (Number(fromVars) > 0) return { price: Number(fromVars), sold };

  return { price: 0, sold };
}

// ---------- BUSCA pública de fallback ----------
async function getPriceViaSearch(wid, mode, token, dbg) {
  let url = `${ML_BASE}/sites/MLB/search?q=${encodeURIComponent(wid)}&limit=3`;
  let headers = PUBLIC_HEADERS;
  if (mode === "auth_header" && token) {
    headers = authHeaders(token);
  } else if (mode === "auth_query" && token) {
    url = addAccessToken(url, token);
  }

  const r = await fetchJson(url, headers);
  dbg.search.push({ mode, url, status: r.status, ok: r.ok, reqId: r.reqId, ct: r.ct });

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

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function findPriceInObject(obj) {
  let best = null;
  function walk(node, path = []) {
    if (!node || typeof node !== "object") return;

    if (typeof node.amount === "number" && node.amount > 0) {
      const p = path.join(".").toLowerCase();
      if (p.includes("price") || p.includes("unitprice") || p.includes("unit_price") || p.includes("buybox")) {
        best = best ? Math.max(best, node.amount) : node.amount; // pega o maior "relevante"
      } else if (best == null) {
        best = node.amount;
      }
    }
    if (typeof node.price === "number" && node.price > 0) {
      best = best ? Math.max(best, node.price) : node.price;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") {
        walk(v, path.concat(k));
      }
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          walk(v[i], path.concat(k, String(i)));
        }
      }
    }
  }
  walk(obj, []);
  return best;
}

function parseBRL(str) {
  // "1.234,56" → 1234.56
  const s = String(str).replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parsePriceFromHtml(html) {
  // 1) JSON-LD
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scripts) {
    const raw = m[1];
    const data = safeJsonParse(raw);
    if (!data) continue;
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
  }

  // 2) PRELOADED_STATE
  const mPre = html.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});/);
  if (mPre) {
    const obj = safeJsonParse(mPre[1]);
    const found = obj ? findPriceInObject(obj) : null;
    if (Number(found) > 0) return Number(found);
  }

  // 3) __NEXT_DATA__
  const mNextScript = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (mNextScript) {
    const obj = safeJsonParse(mNextScript[1]);
    const found = obj ? findPriceInObject(obj) : null;
    if (Number(found) > 0) return Number(found);
  }
  const mNextAssign = html.match(/__NEXT_DATA__\s*=\s*({[\s\S]*?});/);
  if (mNextAssign) {
    const obj = safeJsonParse(mNextAssign[1]);
    const found = obj ? findPriceInObject(obj) : null;
    if (Number(found) > 0) return Number(found);
  }

  // 4) Seletores comuns de preço (HTML estático renderizado)
  // andes-money-amount__fraction + (opcional) cents
  const mFraction = html.match(/andes-money-amount__fraction[^>]*>([\d\.]+)/i);
  if (mFraction) {
    let frac = mFraction[1].replace(/\./g, "");
    let cents = "00";
    const mCents = html.match(/andes-money-amount__cents[^>]*>(\d{2})/i);
    if (mCents) cents = mCents[1];
    const p = Number(`${frac}.${cents}`);
    if (p > 0) return p;
  }

  // data-testid="price-value">R$ 1.234,56</...>
  const mTestId = html.match(/data-testid=["']price-value["'][^>]*>\s*R\$\s*([\d\.\,]+)/i);
  if (mTestId) {
    const p = parseBRL(mTestId[1]);
    if (p && p > 0) return p;
  }

  // 5) Regex BRL geral: pega vários e escolhe o maior (evita capturar parcela)
  const moneyMatches = [...html.matchAll(/R\$\s*([0-9]{1,3}(?:\.[0-9]{3})*,\d{2})/g)];
  if (moneyMatches.length) {
    const nums = moneyMatches
      .map(m => parseBRL(m[1]))
      .filter(n => typeof n === "number" && n > 0 && n < 1000000);
    if (nums.length) {
      // heurística: o maior tende a ser o preço total (e não a parcela)
      const max = Math.max(...nums);
      if (max > 0) return max;
    }
  }

  return null;
}

async function scrapePrice(wid, dbg) {
  const urls = [
    `https://produto.mercadolivre.com.br/MLB${wid.replace(/^MLB/i, "")}`,
    `https://www.mercadolivre.com.br/MLB${wid.replace(/^MLB/i, "")}`
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: HTML_HEADERS, redirect: "follow" });
      const status = r.status;
      const ok = r.ok;
      let price = null;
      if (ok) {
        const html = await r.text();
        price = parsePriceFromHtml(html);
      }
      dbg.scrape.push({ url, status, ok, price });
      if (ok && price && price > 0) {
        return { ok:true, price, url };
      }
    } catch (e) {
      dbg.scrape.push({ url, error: String(e && e.message || e) });
    }
  }
  return { ok:false };
}

// ---------- Core: obter preço por WID ----------
async function getPriceByWID(wid, token, dbg) {
  const ATTRS_FULL = [
    "price","base_price","original_price",
    "prices","variations",
    "status","available_quantity","sold_quantity",
    "permalink","listing_type_id","catalog_product_id"
  ].join(",");

  // 1) COM TOKEN no header (se houver)
  const triesHeader = token ? [
    { kind: "auth_direct_attrs", url: `${ML_BASE}/items/${wid}?attributes=${ATTRS_FULL}`, headers: authHeaders(token) },
    { kind: "auth_bulk_attrs",   url: `${ML_BASE}/items?ids=${wid}&attributes=${ATTRS_FULL}`, headers: authHeaders(token), bulk: true },
    { kind: "auth_direct",       url: `${ML_BASE}/items/${wid}`, headers: authHeaders(token) },
    { kind: "auth_bulk",         url: `${ML_BASE}/items?ids=${wid}`, headers: authHeaders(token), bulk: true }
  ] : [];

  // 2) COM TOKEN na query (?access_token=...)
  const triesQuery = token ? [
    { kind: "authq_direct_attrs", url: addAccessToken(`${ML_BASE}/items/${wid}?attributes=${ATTRS_FULL}`, token), headers: PUBLIC_HEADERS },
    { kind: "authq_bulk_attrs",   url: addAccessToken(`${ML_BASE}/items?ids=${wid}&attributes=${ATTRS_FULL}`, token), headers: PUBLIC_HEADERS, bulk: true },
    { kind: "authq_direct",       url: addAccessToken(`${ML_BASE}/items/${wid}`, token), headers: PUBLIC_HEADERS },
    { kind: "authq_bulk",         url: addAccessToken(`${ML_BASE}/items?ids=${wid}`, token), headers: PUBLIC_HEADERS, bulk: true }
  ] : [];

  // 3) PÚBLICO
  const triesPublic = [
    { kind: "public_direct_attrs", url: `${ML_BASE}/items/${wid}?attributes=${ATTRS_FULL}`, headers: PUBLIC_HEADERS },
    { kind: "public_bulk_attrs",   url: `${ML_BASE}/items?ids=${wid}&attributes=${ATTRS_FULL}`, headers: PUBLIC_HEADERS, bulk: true },
    { kind: "public_direct",       url: `${ML_BASE}/items/${wid}`, headers: PUBLIC_HEADERS },
    { kind: "public_bulk",         url: `${ML_BASE}/items?ids=${wid}`, headers: PUBLIC_HEADERS, bulk: true }
  ];

  const sequences = [triesHeader, triesQuery, triesPublic];

  for (const seq of sequences) {
    for (const t of seq) {
      const r = await fetchJson(t.url, t.headers);
      dbg.items.push({ kind: t.kind, url: t.url, status: r.status, ok: r.ok, reqId: r.reqId, ct: r.ct });

      if (!r.ok) continue;

      // bulk
      if (t.bulk) {
        const nb = normalizeBulk(r);
        if (!nb.ok) continue;

        const { price, sold } = extractPriceSold(nb.data);
        // --- DEBUG PROBE (somente se debug ligado lá em cima) ---
        if (!dbg.bulkProbe && (price === 0 || price === null || price === undefined)) {
          dbg.bulkProbe = {
            from: t.kind,
            listing_type_id: nb.data?.listing_type_id || null,
            catalog_product_id: nb.data?.catalog_product_id || null,
            base_price: nb.data?.base_price || null,
            original_price: nb.data?.original_price || null,
            variations_sample: Array.isArray(nb.data?.variations)
              ? nb.data.variations.slice(0, 3).map(v => ({
                  id: v?.id, price: v?.price ?? null, aq: v?.available_quantity ?? null
                }))
              : null,
            prices_sample: Array.isArray(nb.data?.prices?.prices)
              ? nb.data.prices.prices.slice(0, 3).map(p => ({
                  amount: p?.amount ?? null,
                  currency_id: p?.currency_id ?? null,
                  status: p?.status ?? null,
                  type: p?.type ?? null,
                  last_updated: p?.last_updated ?? null
                }))
              : null
          };
        }
        // --------------------------------------------------------

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

      // direto
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
    const sr = await getPriceViaSearch(wid, m, token, dbg);
    if (sr.ok) {
      return { ok:true, price: sr.price, item_id: wid, sold_winner: null, via: sr.where };
    }
  }

  // 5) SCRAPE (se habilitado)
  if (dbg.enableScrape) {
    const scr = await scrapePrice(wid, dbg);
    if (scr.ok) {
      return { ok:true, price: scr.price, item_id: wid, sold_winner: null, via: "scrape" };
    }
  }

  // Falha geral
  return {
    ok: false,
    status: 401,
    error_code: "UPSTREAM_ERROR",
    message: "Falha ao obter preço do WID (itens, busca e scrape).",
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

    const q   = req.query || {};
    const wid = String(q.wid || q.product_id || "").trim().toUpperCase();
    const debug = String(q.debug || "") === "1";
    const forceScrape = String(q.sf || q.scrape || "") === "1";
    const enableScrape = forceScrape || String(process.env.ENABLE_SCRAPE_FALLBACK || "") === "1";

    if (!isWID(wid)) {
      return sendJSON(res, 200, {
        ok:false,
        error_code: "MISSING_WID",
        message: "Envie wid=MLBxxxxxxxxxx (somente WID, 10+ dígitos).",
        http_status: 400
      });
    }

    const token = await getTokenMaybe(); // pode ser null
    const dbg = {
      vercelRegion: process.env.VERCEL_REGION || null,
      tokenPresent: !!token,
      enableScrape,
      items: [],
      search: [],
      scrape: []
    };

    const out = await getPriceByWID(wid, token, dbg);

    if (!out.ok) {
      const err = {
        ok:false,
        error_code: out.error_code || "UPSTREAM_ERROR",
        message: out.message || "Falha ao consultar WID",
        http_status: out.status || 500,
        details: out.details || {}
      };
      if (debug) err._debug = dbg;
      return sendJSON(res, 200, err);
    }

    const resp = {
      ok: true,
      price: out.price,
      source: "item",
      product_id: wid,
      item_id: out.item_id,
      sold_winner: out.sold_winner,
      fetched_at: nowISO()
    };
    if (debug) resp._debug = dbg;
    return sendJSON(res, 200, resp);

  } catch (e) {
    return sendJSON(res, 200, {
      ok:false,
      error_code:"INTERNAL",
      message:String(e?.message || e),
      http_status:500
    });
  }
}
