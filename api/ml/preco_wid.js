// api/ml/preco_wid.js
// WID-only (MLB do anúncio) 100% público, sem Authorization.
// Aceita:
//   - ?product_id=MLBxxxxxxxxxx
//   - ?product_id=<link-de-catálogo-com-#...wid=MLBxxxxxxxxxx>
//   - ?my_item_id=MLBxxxxxxxxxx
//
// Fluxo: /items/{id} (público) → se falhar, /items?ids={id} (público).

const ML_BASE = "https://api.mercadolibre.com";

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function isWID(s) { return !!s && /^MLB\d{10,}$/i.test(String(s).trim()); }

function widFromHash(url) {
  if (!url) return null;
  try {
    const hash = String(url).split("#")[1] || "";
    const m = hash.match(/wid=(MLB\d{10,})/i);
    return m ? m[1].toUpperCase() : null;
  } catch { return null; }
}

async function getJsonPublic(url) {
  const r = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "WidOnly/1.0" }
  });
  const ct = r.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data, url };
}

async function getItemDirect(wid) {
  const url = `${ML_BASE}/items/${wid}?attributes=price,status,available_quantity,sold_quantity,permalink`;
  return getJsonPublic(url);
}

async function getItemBulk(wid) {
  const url = `${ML_BASE}/items?ids=${wid}&attributes=price,status,available_quantity,sold_quantity,permalink`;
  const r = await getJsonPublic(url);
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
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return send(res, 200, { ok: true });

    if (req.method !== "GET") {
      return send(res, 200, { ok:false, error_code:"METHOD_NOT_ALLOWED", http_status:405 });
    }

    const q = req.query || {};
    let productInput = String(q.product_id || "").trim();
    const myItemId = String(q.my_item_id || "").trim();
    const debug = String(q.debug || "") === "1";

    // Resolver WID
    let wid = null;
    if (isWID(myItemId)) wid = myItemId.toUpperCase();
    if (!wid && isWID(productInput)) wid = productInput.toUpperCase();
    if (!wid) {
      const fromHash = widFromHash(productInput);
      if (isWID(fromHash)) wid = fromHash.toUpperCase();
    }

    if (!isWID(wid)) {
      return send(res, 200, {
        ok:false,
        error_code:"MISSING_WID",
        message:"Informe o WID (MLB do anúncio) ou cole o link do catálogo com #...wid=MLB...",
        http_status:400,
        version:"wid_only_public_v1",
        _debug: debug ? { productInput, myItemId } : undefined
      });
    }

    // 1) /items/{id}
    let r = await getItemDirect(wid);
    if (!r.ok) {
      // 2) fallback /items?ids=
      const rb = await getItemBulk(wid);
      if (!rb.ok) {
        return send(res, 200, {
          ok:false,
          error_code:"UPSTREAM_ERROR",
          message:`Erro ${rb.status} em ${rb.url.includes("?ids=")?"/items?ids":"/items/{id}"}`,
          http_status: rb.status,
          details:{ upstream_url: rb.url },
          version:"wid_only_public_v1",
          _debug: debug ? { direct_status: r.status } : undefined
        });
      }
      r = rb;
    }

    const body = r.data;
    const price = Number(body?.price || 0);
    if (!price) {
      return send(res, 200, {
        ok:false, error_code:"NO_PRICE", message:"Anúncio sem preço disponível",
        http_status:404, details:{ upstream_url: r.url }, version:"wid_only_public_v1",
        _debug: debug ? { body } : undefined
      });
    }

    return send(res, 200, {
      ok:true,
      price,
      source:"item",
      product_id: wid,
      item_id: wid,
      sold_winner: Number.isFinite(body?.sold_quantity) ? body.sold_quantity : null,
      sold_catalog_total: null,
      fetched_at: new Date().toISOString(),
      version:"wid_only_public_v1",
      _debug: debug ? { via: r.url.includes("?ids=") ? "bulk" : "direct" } : undefined
    });
  } catch (e) {
    return send(res, 200, { ok:false, error_code:"INTERNAL", http_status:500, message:String(e?.message||e), version:"wid_only_public_v1" });
  }
}
