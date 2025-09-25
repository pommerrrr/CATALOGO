
import type { MLResponse } from '../types';
export async function fetchPrice(productId: string): Promise<MLResponse> {
  const url = `/api/ml/preco?product_id=${encodeURIComponent(productId)}`;
  const res = await fetch(url, { method: 'GET' });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return { ok:false, error_code:'NON_JSON', message:'Resposta não-JSON da API interna', http_status:500 };
  const data: MLResponse = await res.json();
  return data;
}
