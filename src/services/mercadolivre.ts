// src/services/mercadolivre.ts
export type Source = 'buy_box' | 'my_item' | 'item';
export interface MLResponse {
  ok: boolean;
  price?: number;
  source?: Source;
  product_id?: string;
  item_id?: string | null;
  fetched_at?: string;
  sold_winner?: number | null;
  sold_catalog_total?: number | null;
  error_code?: string;
  message?: string;
  http_status?: number;
  details?: any;
  _debug?: any;
}

/** extrai MLB... de uma string (ID ou URL) */
function extractId(raw: string | undefined | null, minDigits = 1): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const rx = new RegExp(`MLB\\d{${minDigits},}`, 'i');
  const m = s.match(rx);
  return m ? m[0].toUpperCase() : null;
}

/** extrai wid=MLB... do fragmento #... */
function extractWidFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const hash = url.split('#')[1] || '';
    const m = hash.match(/wid=(MLB\d{10,})/i);
    return m ? m[1].toUpperCase() : null;
  } catch { return null; }
}

/**
 * Consulta preço do catálogo (buy box) com fallback do seu anúncio.
 * @param catalogInput ID (MLB...) OU link do catálogo (/p/MLB...)
 * @param myItemInput (opcional) ID do seu anúncio (MLB...) OU link do anúncio
 * @param preferWid Se true, tenta extrair 'wid=' do link do catálogo (hash) como my_item_id
 */
export async function fetchPriceSmart(catalogInput: string, myItemInput?: string, preferWid = true, debug = false): Promise<MLResponse> {
  const catId = extractId(catalogInput, 1); // curto também casa
  if (!catId) return { ok:false, error_code:'INVALID_CATALOG', message:'Não foi possível extrair o MLB do catálogo', http_status:400 };

  let myItemId: string | null = null;
  if (preferWid) myItemId = extractWidFromUrl(catalogInput);
  if (!myItemId && myItemInput) myItemId = extractId(myItemInput, 10);

  const qs = new URLSearchParams({ product_id: catId });
  if (myItemId) qs.set('my_item_id', myItemId);
  if (debug) qs.set('debug', '1');

  const res = await fetch(`/api/ml/preco?${qs.toString()}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return { ok:false, error_code:'NON_JSON', message:'Resposta não-JSON da API interna', http_status:500 };
  }
  return res.json();
}

/** Backward-compat: apenas com ID do catálogo (sem fallback). */
export async function fetchPrice(productId: string): Promise<MLResponse> {
  return fetchPriceSmart(productId, undefined, true, false);
}
