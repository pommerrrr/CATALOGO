// GET /api/ml/preco?product_id=MLBXXXXXXXXXX  (somente WID)
//
// Vars de ambiente esperadas:
// - BROWSERLESS_BASE_URL (ex.: https://production-sfo.browserless.io)
// - BROWSERLESS_TOKEN    (sua API key do Browserless)
// - ML_ACCESS_TOKEN      (opcional; melhora quando o WID é seu)

const JSON_HEADERS = { "Content-Type": "application/json" };

function send(res, code, body) {
  res.status(code);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
function nowISO() { return new Date().toISOString(); }
function isWid(id) { return /^MLB\d{10,}$/i.test((id || "").toString()); }
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

function parseBRL(b) {
  const s = (b || "").trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function findPriceDeep(o) {
  let best = null;
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.price === "number" && n.price > 0) best = Math.max(best ?? 0, n.price);
    if (typeof n.amount === "number" && n.amount > 0) best = Math.max(best ?? 0, n.amount);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(o);
  return best;
}

function extractPriceFromHTML(html) {
  // JSON-LD
  const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    const data = safeJson(m[1]); if (!data) continue;
    const arr = Array.isArray(data) ? data : [data];
    for (const node of arr) {
      const offers = node?.offers;
      if (!offers) continue;
      if (Array.isArray(offers)) {
        for (const o of offers) { const p = Number(o?.price || 0); if (p > 0) return p; }
      } else if (typeof offers === "object") {
        const p = Number(offers?.price || 0); if (p > 0) return p;
      }
    }
  }
  // Estados em JS
  const mPre = html.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});/);
  if (mPre) { const obj = safeJson(mPre[1]); const p = obj ? findPriceDeep(obj) : null; if (p && p > 0) return p; }
  const mNext = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (mNext) { const obj = safeJson(mNext[1]); const p = obj ? findPriceDeep(obj) : null; if (p && p > 0) return p; }

  // Seletores comuns
  const mTest = html.match(/data-testid=["']price-value["'][^>]*>\s*R\$\s*([\d\.\,]+)/i);
  if (mTest) { const p = parseBRL(mTest[1]); if (p && p > 0) return p; }
  const mFrac = html.match(/andes-money-amount__fraction[^>]*>([\d\.]+)/i);
  if (mFrac) {
    const inteiros = mFrac[1].replace(/\./g, "");
    const cents = (html.match(/andes-money-amount__cents[^>]*>(\d{2})/i)?.[1]) || "00";
    const p = Number(`${inteiros}.${cents}`); if (p > 0) return p;
  }

  // Regex BRL
  const money = [...html.matchAll(/R\$\s*([0-9]{1,3}(?:\.[0-9]{3})*,\d{2})/g)]
    .map(m => parseBRL(m[1]))
    .filter(n => typeof n === "number" && n > 0 && n < 1_000_000);
  if (money.length) return Math.max(...money);
  return null;
}

async function fetchML(url, token) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers });
  const ct = r.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");
  const text = await r.text().catch(() => "");
  const body = isJson ? safeJson(text) : null;
  return { ok: r.ok, status: r.status, body, ct, text };
}

async function browserlessContent(url) {
  const base = process.env.BROWSERLESS_BASE_URL || "";
  const token = process.env.BROWSERLESS_TOKEN || "";
  if (!base || !token) {
    return { ok: false, status: 500, html: "", error: "SCRAPE_MISCONFIG" };
  }
  const endpoint = `${base.replace(/\/+$/, "")}/content?token=${encodeURIComponent(token)}`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      url,
      gotoOptions: { waitUntil: "networkidle2", timeout: 20000 },
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        "Referer": "https://www.mercadolivre.com.br/",
        "Origin": "https://www.mercadolivre.com.br"
      }
    })
  });
  const html = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, html };
}

async function tryScrapePrice(wid) {
  const urls = [
    `https://produto.mercadolivre.com.br/${wid}`,
    `https://www.mercadolivre.com.br/${wid}`
  ];
  for (const u of urls) {
    const r = await browserlessContent(u);
    if (!r.ok || !r.html) continue;
    const price = extractPriceFromHTML(r.html);
    if (price && price > 0) {
      return { ok: true, price, source: "scrape", product_id: wid, item_id: wid, fetched_at: nowISO() };
    }
  }
  return { ok: false, error_code: "UPSTREAM_ERROR", message: "Falha ao obter preço do WID (API bloqueada e scraping sem preço).", http_status: 401, details: { phase: "scrape-failed" } };
}

async function tryMLItemPrice(wid) {
  const token = process.env.ML_ACCESS_TOKEN || "";
  const attrs = "price,base_price,original_price,prices,status,available_quantity,sold_quantity,permalink";

  // 1) Bulk com Authorization (melhor chance quando é seu)
  if (token) {
    const u1 = `https://api.mercadolibre.com/items?ids=${wid}&attributes=${attrs}`;
    const r1 = await fetchML(u1, token);
    if (r1.ok && Array.isArray(r1.body)) {
      const entry = r1.body[0]; const it = entry?.body;
      const p = Number(it?.price || it?.base_price || 0);
      if (p > 0) return { ok: true, price: p, source: "item", product_id: wid, item_id: wid, fetched_at: nowISO(), sold_winner: it?.sold_quantity ?? null };
      const priceDeep = findPriceDeep(it?.prices);
      if (priceDeep && priceDeep > 0) return { ok: true, price: priceDeep, source: "item", product_id: wid, item_id: wid, fetched_at: nowISO(), sold_winner: it?.sold_quantity ?? null };
    }
  }

  // 2) Bulk público (muitas vezes bloqueia para terceiros)
  const u2 = `https://api.mercadolibre.com/items?ids=${wid}&attributes=${attrs}`;
  const r2 = await fetchML(u2);
  if (r2.ok && Array.isArray(r2.body)) {
    const entry = r2.body[0]; const it = entry?.body;
    const p = Number(it?.price || it?.base_price || 0);
    if (p > 0) return { ok: true, price: p, source: "item", product_id: wid, item_id: wid, fetched_at: nowISO(), sold_winner: it?.sold_quantity ?? null };
    const priceDeep = findPriceDeep(it?.prices);
    if (priceDeep && priceDeep > 0) return { ok: true, price: priceDeep, source: "item", product_id: wid, item_id: wid, fetched_at: nowISO(), sold_winner: it?.sold_quantity ?? null };
  }

  // 3) Scraping (Browserless)
  return await tryScrapePrice(wid);
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return send(res, 200, { ok: true });

    if (req.method !== "GET") {
      return send(res, 200, { ok: false, error_code: "METHOD_NOT_ALLOWED", message: "Use GET", http_status: 405 });
    }

    const raw = (req.query?.product_id || "").toString().trim().toUpperCase();
    if (!isWid(raw)) {
      return send(res, 200, { ok: false, error_code: "INVALID_ID_FORMAT", message: "Use WID de item: MLB + 10+ dígitos (ex.: MLB3520318133).", http_status: 400 });
    }

    const result = await tryMLItemPrice(raw);
    return send(res, 200, result);

  } catch (e) {
    return send(res, 200, { ok: false, error_code: "INTERNAL_ERROR", message: e?.message || "Erro interno", http_status: 500 });
  }
};
