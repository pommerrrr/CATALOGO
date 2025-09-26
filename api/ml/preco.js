// api/ml/preco.js
// Consulta preço por WID (ex.: MLB5694522104). Fallbacks: API -> Busca -> Browserless.
// Sempre responde JSON (status HTTP 200) no contrato combinado.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function sendJson(res, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = 200; // contrato: erro vem no campo http_status
  res.end(JSON.stringify(body));
}

function okPrice({ price, wid, sold }) {
  return {
    ok: true,
    price,
    source: "item",
    product_id: wid,
    item_id: wid,
    sold_winner: typeof sold === "number" ? sold : null,
    fetched_at: new Date().toISOString(),
  };
}

function err(code, message, httpStatus, details, extra = {}) {
  return {
    ok: false,
    error_code: code,
    message,
    http_status: httpStatus,
    details: details || {},
    ...extra,
  };
}

function isWid(v) {
  return typeof v === "string" && /^MLB\d{6,}$/.test(v);
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    data = await res.json();
  } else {
    data = { non_json: true };
  }
  return { res, data };
}

/** 1) Tenta APIs autenticadas de /items (é o caminho mais estável) */
async function tryMlItemApis(wid, token, _debug) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  // (a) bulk + attributes (mais permissivo)
  {
    const url = `https://api.mercadolibre.com/items?ids=${wid}&attributes=price,status,available_quantity,sold_quantity,permalink`;
    const { res, data } = await fetchJson(url, { headers });
    _debug.items.push({
      kind: "auth_bulk_attrs",
      url,
      status: res.status,
      ok: res.ok,
      ct: res.headers.get("content-type"),
    });

    if (res.ok && Array.isArray(data) && data[0] && data[0].body) {
      const b = data[0].body;
      if (typeof b.price === "number" && b.price > 0) {
        return okPrice({ price: b.price, wid, sold: b.sold_quantity });
      }
    }
  }

  // (b) direto + attributes
  {
    const url = `https://api.mercadolibre.com/items/${wid}?attributes=price,status,available_quantity,sold_quantity,permalink`;
    const { res, data } = await fetchJson(url, { headers });
    _debug.items.push({
      kind: "auth_direct_attrs",
      url,
      status: res.status,
      ok: res.ok,
      ct: res.headers.get("content-type"),
    });

    if (res.ok && data && typeof data.price === "number" && data.price > 0) {
      return okPrice({ price: data.price, wid, sold: data.sold_quantity });
    }
  }

  return null;
}

/** 2) Tenta busca pública/autenticada como fallback */
async function tryPublicSearch(wid, token, _debug) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${wid}&limit=3`;
  const { res, data } = await fetchJson(url, { headers });
  _debug.search.push({
    mode: token ? "auth_header" : "public",
    url,
    status: res.status,
    ok: res.ok,
    ct: res.headers.get("content-type"),
  });

  if (res.ok && data && Array.isArray(data.results)) {
    const hit = data.results.find(
      (r) => r && r.id === wid && typeof r.price === "number"
    );
    if (hit) return okPrice({ price: hit.price, wid });
  }
  return null;
}

/** 3) Tenta Browserless (Puppeteer remoto) raspando o preço no PDP */
async function tryBrowserlessScrape(wid, wsUrl, _debug) {
  if (!wsUrl) {
    _debug.scrape.push({ url: null, status: 0, ok: false, note: "NO_WS_URL" });
    return null;
  }
  let browser, page, puppeteer;
  try {
    // importante: "puppeteer-core" precisa estar nas dependencies
    puppeteer = (await import("puppeteer-core")).default;

    browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      timeout: 25000,
    });
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1366, height: 900 });

    const urls = [
      `https://produto.mercadolivre.com.br/${wid}`,
      `https://www.mercadolivre.com.br/${wid}`,
    ];

    const selectors = [
      // principais
      ".ui-pdp-price__main-container .andes-money-amount__fraction",
      ".andes-money-amount__fraction",
      // metadado
      "meta[itemprop='price']",
      "[itemprop='price']",
    ];

    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

        let price = null;
        for (const sel of selectors) {
          const exists = await page.$(sel);
          if (!exists) continue;

          if (sel.startsWith("meta")) {
            const content = await page.$eval(sel, (m) => m.content || "");
            const n = Number((content || "").replace(/\./g, "").replace(",", "."));
            if (n > 0) { price = n; break; }
          } else {
            const raw = await page.$eval(sel, (e) => e.textContent || "");
            const cleaned = (raw || "")
              .replace(/[^\d,.-]/g, "")
              .replace(/\./g, "")
              .replace(",", ".");
            const n = Number(cleaned);
            if (n > 0) { price = n; break; }
          }
        }

        _debug.scrape.push({ url, status: 200, ok: true, price });
        if (price) {
          await browser.close().catch(() => {});
          return {
            ok: true,
            price,
            source: "scrape",
            product_id: wid,
            item_id: wid,
            fetched_at: new Date().toISOString(),
          };
        }
      } catch (e) {
        _debug.scrape.push({ url, status: 500, ok: false, err: String(e) });
      }
    }
  } catch (e) {
    _debug.scrape.push({ url: null, status: 500, ok: false, err: String(e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const wid = String(req.query.product_id || "").trim();

    const _debug = {
      vercelRegion: process.env.VERCEL_REGION || null,
      tokenPresent: !!process.env.ML_ACCESS_TOKEN,
      enableScrape: !!process.env.BROWSERLESS_WS_URL,
      items: [],
      search: [],
      scrape: [],
    };

    if (!isWid(wid)) {
      return sendJson(
        res,
        err("INVALID_WID", "Informe um WID válido (ex.: MLB5694522104).", 400, {
          received: wid,
        })
      );
    }

    const token = process.env.ML_ACCESS_TOKEN || null;

    // 1) APIs autenticadas /items
    const s1 = await tryMlItemApis(wid, token, _debug);
    if (s1) return sendJson(res, req.query.debug ? { ...s1, _debug } : s1);

    // 2) Busca pública/autenticada
    const s2 = await tryPublicSearch(wid, token, _debug);
    if (s2) return sendJson(res, req.query.debug ? { ...s2, _debug } : s2);

    // 3) Scrape via Browserless
    const s3 = await tryBrowserlessScrape(
      wid,
      process.env.BROWSERLESS_WS_URL || "",
      _debug
    );
    if (s3) return sendJson(res, req.query.debug ? { ...s3, _debug } : s3);

    // Esgotou
    const failure = err(
      "UPSTREAM_ERROR",
      "Falha ao obter preço do WID (itens, busca e scrape).",
      401,
      { phase: "all-fallbacks-exhausted" }
    );
    return sendJson(res, req.query.debug ? { ...failure, _debug } : failure);
  } catch (e) {
    return sendJson(
      res,
      err("INTERNAL_ERROR", "Erro interno", 500, { message: String(e) })
    );
  }
}
