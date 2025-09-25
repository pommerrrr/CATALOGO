import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAccessToken } from './token'

type Source = 'buy_box' | 'catalog_offers' | 'item'

interface MLApiResponse {
  ok: boolean
  price?: number
  source?: Source
  product_id?: string
  item_id?: string | null
  sold_winner?: number | null
  sold_catalog_total?: number | null
  fetched_at?: string
  error_code?: string
  message?: string
  http_status?: number
  details?: any
}

/** Monta headers concretos (sem union) aceitos por fetch */
function buildHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'ImportCostControl/1.0 (server)',
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true })
  }
  if (req.method !== 'GET') {
    return res.status(200).json({
      ok: false,
      error_code: 'METHOD_NOT_ALLOWED',
      message: 'Only GET',
      http_status: 405
    })
  }

  const mlId = String(req.query.product_id || '').trim()
  if (!mlId) {
    return res.status(200).json({
      ok: false,
      error_code: 'MISSING_PARAM',
      message: 'product_id is required',
      http_status: 400
    })
  }

  try {
    const result = await getProductInfo(mlId)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(200).json({
      ok: false,
      error_code: 'INTERNAL',
      message: e?.message || 'Internal error',
      http_status: 500,
      details: { stack: e?.stack?.split('\n').slice(0, 3) }
    })
  }
}

async function getProductInfo(mlId: string): Promise<MLApiResponse> {
  if (!/^MLB\d+$/.test(mlId)) {
    return {
      ok: false,
      error_code: 'INVALID_ID_FORMAT',
      message: 'Use MLB + números (ex.: MLB35854070)',
      http_status: 400
    }
  }

  const base = 'https://api.mercadolibre.com'
  const fetched_at = new Date().toISOString()
  const digits = mlId.replace('MLB', '')
  const isCatalog = digits.length < 10

  // Access token via refresh_token
  const token: string | null = await getAccessToken().catch(() => null)

  if (isCatalog) {
    // 1) /products (requer token) → tenta Buy Box Winner
    const prodUrl = `${base}/products/${mlId}`
    const prodRes = await fetch(prodUrl, {
      method: 'GET',
      headers: buildHeaders(token || undefined)
    })
    const prodCT = prodRes.headers.get('content-type') || ''

    if (!prodRes.ok) {
      // 401/403 → fallback para ofertas
      if (prodRes.status === 401 || prodRes.status === 403) {
        return getCatalogOffers(mlId, base, fetched_at)
      }
      if (prodRes.status === 404) {
        return {
          ok: false,
          error_code: 'CATALOG_NOT_FOUND',
          message: 'Catalog not found',
          http_status: 404,
          details: { upstream_url: prodUrl, status: prodRes.status }
        }
      }
      return {
        ok: false,
        error_code: 'UPSTREAM_ERROR',
        message: `Error ${prodRes.status} on products`,
        http_status: prodRes.status,
        details: { upstream_url: prodUrl, status: prodRes.status }
      }
    }

    if (!prodCT.includes('application/json')) {
      return {
        ok: false,
        error_code: 'UPSTREAM_JSON',
        message: 'Invalid response (not JSON) on products',
        http_status: 502,
        details: { upstream_url: prodUrl, content_type: prodCT }
      }
    }

    const prod = await prodRes.json()

    // 2) Buy Box Winner
    if (prod?.buy_box_winner?.price) {
      const price = prod.buy_box_winner.price
      const itemId = prod.buy_box_winner.item_id || null

      // sold_quantity do item vencedor (opcional)
      let soldWinner: number | null = null
      if (itemId) {
        const itemUrl = `${base}/items/${itemId}`
        const itemRes = await fetch(itemUrl, {
          method: 'GET',
          headers: buildHeaders(token || undefined)
        })
        const itemCT = itemRes.headers.get('content-type') || ''
        if (itemRes.ok && itemCT.includes('application/json')) {
          const itemData = await itemRes.json()
          soldWinner =
            typeof itemData.sold_quantity === 'number'
              ? itemData.sold_quantity
              : null
        }
      }

      return {
        ok: true,
        price,
        source: 'buy_box',
        product_id: mlId,
        item_id: itemId,
        sold_winner: soldWinner,
        sold_catalog_total: null,
        fetched_at
      }
    }

    // 3) Sem Buy Box → ofertas
    return getCatalogOffers(mlId, base, fetched_at)
  }

  // Item direto (não catálogo) — requer token
  const itemUrl = `${base}/items/${mlId}`
  const itemRes = await fetch(itemUrl, {
    method: 'GET',
    headers: buildHeaders(token || undefined)
  })
  const itemCT = itemRes.headers.get('content-type') || ''
  if (!itemRes.ok) {
    if (itemRes.status === 404) {
      return {
        ok: false,
        error_code: 'ITEM_NOT_FOUND',
        message: 'Item not found',
        http_status: 404,
        details: { upstream_url: itemUrl, status: itemRes.status }
      }
    }
    return {
      ok: false,
      error_code: 'UPSTREAM_ERROR',
      message: `Error ${itemRes.status} on item`,
      http_status: itemRes.status,
      details: { upstream_url: itemUrl, status: itemRes.status }
    }
  }
  if (!itemCT.includes('application/json')) {
    return {
      ok: false,
      error_code: 'UPSTREAM_JSON',
      message: 'Invalid response (not JSON) on item',
      http_status: 502,
      details: { upstream_url: itemUrl, content_type: itemCT }
    }
  }

  const item = await itemRes.json()
  if (!(item?.price > 0)) {
    return {
      ok: false,
      error_code: 'NO_PRICE',
      message: 'Item has no price',
      http_status: 404,
      details: { upstream_url: itemUrl }
    }
  }

  return {
    ok: true,
    price: item.price,
    source: 'item',
    product_id: mlId,
    item_id: mlId,
    sold_winner:
      typeof item.sold_quantity === 'number' ? item.sold_quantity : null,
    sold_catalog_total: null,
    fetched_at
  }
}

async function getCatalogOffers(
  mlId: string,
  base: string,
  fetched_at: string
): Promise<MLApiResponse> {
  const offersUrl = `${base}/sites/MLB/search?product_id=${mlId}&limit=50&sort=price_asc`
  const offRes = await fetch(offersUrl, {
    method: 'GET',
    headers: buildHeaders() // sem token aqui (pode usar também)
  })
  const oct = offRes.headers.get('content-type') || ''

  if (!offRes.ok) {
    return {
      ok: false,
      error_code: 'SEARCH_ERROR',
      message: `Error ${offRes.status} on offers`,
      http_status: offRes.status,
      details: { upstream_url: offersUrl, status: offRes.status }
    }
  }
  if (!oct.includes('application/json')) {
    return {
      ok: false,
      error_code: 'UPSTREAM_JSON',
      message: 'Invalid response (not JSON) on offers',
      http_status: 502,
      details: { upstream_url: offersUrl, content_type: oct }
    }
  }

  const data = await offRes.json()
  const results = Array.isArray(data?.results) ? data.results : []
  const active = results.filter(
    (r: any) => (r.status === 'active' || !r.status) && r.price > 0
  )
  if (active.length === 0) {
    return {
      ok: false,
      error_code: 'NO_ACTIVE_OFFERS',
      message: 'Catalog found, but no active offers',
      http_status: 404,
      details: { upstream_url: offersUrl, total_results: results.length }
    }
  }

  const best = active[0]
  const soldTotal = active.reduce(
    (acc: number, r: any) =>
      acc + (typeof r.sold_quantity === 'number' ? r.sold_quantity : 0),
    0
  )

  return {
    ok: true,
    price: best.price,
    source: 'catalog_offers',
    product_id: mlId,
    item_id: best.id,
    sold_winner: null,
    sold_catalog_total: soldTotal,
    fetched_at
  }
}
