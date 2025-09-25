
import type { VercelRequest, VercelResponse } from '@vercel/node';
type Source = 'buy_box'|'catalog_offers'|'item';
interface MLApiResponse{ ok:boolean; price?:number; source?:Source; product_id?:string; item_id?:string|null; sold_winner?:number|null; sold_catalog_total?:number|null; fetched_at?:string; error_code?:string; message?:string; http_status?:number; details?:any; }
export default async function handler(req:VercelRequest,res:VercelResponse){
  res.setHeader('Content-Type','application/json'); res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(200).json({ok:true});
  if(req.method!=='GET') return res.status(200).json({ok:false,error_code:'METHOD_NOT_ALLOWED',message:'Only GET',http_status:405});
  const product_id=String(req.query.product_id||'').trim(); if(!product_id) return res.status(200).json({ok:false,error_code:'MISSING_PARAM',message:'product_id is required',http_status:400});
  try{ const result=await getProductInfo(product_id); return res.status(200).json(result);}catch(e:any){ return res.status(200).json({ok:false,error_code:'INTERNAL',message:e?.message||'Internal error',http_status:500,details:{stack:e?.stack?.split('\n').slice(0,3)}}); }
}
async function getProductInfo(mlId:string):Promise<MLApiResponse>{
  if(!/^MLB\d+$/.test(mlId)) return { ok:false,error_code:'INVALID_ID_FORMAT',message:'Use MLB + números',http_status:400 };
  const digits=mlId.replace('MLB',''); const isCatalog=digits.length<10; const base='https://api.mercadolibre.com'; const fetched_at=new Date().toISOString();
  if(isCatalog){
    const prodUrl=`${base}/products/${mlId}`; const prodRes=await fetch(prodUrl,{headers:{Accept:'application/json','User-Agent':'ImportCostControl/1.0'}});
    const ct=prodRes.headers.get('content-type')||''; if(!prodRes.ok){ if(prodRes.status===404) return {ok:false,error_code:'CATALOG_NOT_FOUND',message:'Catalog not found',http_status:404,details:{upstream_url:prodUrl,status:prodRes.status}}; return {ok:false,error_code:'UPSTREAM_ERROR',message:`Error ${prodRes.status} on products`,http_status:prodRes.status,details:{upstream_url:prodUrl,status:prodRes.status}} }
    if(!ct.includes('application/json')) return { ok:false,error_code:'UPSTREAM_JSON',message:'Invalid response (not JSON) on products',http_status:502,details:{upstream_url:prodUrl,content_type:ct} };
    const prod=await prodRes.json();
    if(prod?.buy_box_winner?.price){
      const itemId=prod.buy_box_winner.item_id||null; let soldWinner:null|number=null;
      if(itemId){ const item=await fetch(`${base}/items/${itemId}`,{headers:{Accept:'application/json','User-Agent':'ImportCostControl/1.0'}});
        const ict=item.headers.get('content-type')||''; if(item.ok&&ict.includes('application/json')){ const idata=await item.json(); soldWinner=typeof idata.sold_quantity==='number'?idata.sold_quantity:null; } }
      return { ok:true, price:prod.buy_box_winner.price, source:'buy_box', product_id:mlId, item_id:itemId, sold_winner:soldWinner, sold_catalog_total:null, fetched_at };
    }
    const offersUrl=`${base}/sites/MLB/search?product_id=${mlId}&limit=50&sort=price_asc`; const offRes=await fetch(offersUrl,{headers:{Accept:'application/json','User-Agent':'ImportCostControl/1.0'}});
    const oct=offRes.headers.get('content-type')||''; if(!offRes.ok) return {ok:false,error_code:'SEARCH_ERROR',message:`Error ${offRes.status} on offers`,http_status:offRes.status,details:{upstream_url:offersUrl,status:offRes.status}};
    if(!oct.includes('application/json')) return {ok:false,error_code:'UPSTREAM_JSON',message:'Invalid response (not JSON) on offers',http_status:502,details:{upstream_url:offersUrl,content_type:oct}};
    const data=await offRes.json(); const results=Array.isArray(data?.results)?data.results:[]; const active=results.filter((r:any)=>(r.status==='active'||!r.status)&&r.price>0);
    if(active.length===0) return {ok:false,error_code:'NO_ACTIVE_OFFERS',message:'Catalog found, but no active offers',http_status:404,details:{upstream_url:offersUrl,total_results:results.length}};
    const best=active[0]; const soldTotal=active.reduce((a:number,r:any)=>a+(typeof r.sold_quantity==='number'?r.sold_quantity:0),0);
    return { ok:true, price:best.price, source:'catalog_offers', product_id:mlId, item_id:best.id, sold_winner:null, sold_catalog_total:soldTotal, fetched_at };
  }
  const itemUrl=`${base}/items/${mlId}`; const itemRes=await fetch(itemUrl,{headers:{Accept:'application/json','User-Agent':'ImportCostControl/1.0'}});
  const ict=itemRes.headers.get('content-type')||''; if(!itemRes.ok){ if(itemRes.status===404) return {ok:false,error_code:'ITEM_NOT_FOUND',message:'Item not found',http_status:404,details:{upstream_url:itemUrl}}; return {ok:false,error_code:'UPSTREAM_ERROR',message:`Error ${itemRes.status} on item`,http_status:itemRes.status,details:{upstream_url:itemUrl}} }
  if(!ict.includes('application/json')) return {ok:false,error_code:'UPSTREAM_JSON',message:'Invalid response (not JSON) on item',http_status:502,details:{upstream_url:itemUrl,content_type:ict}};
  const item=await itemRes.json(); if(!(item?.price>0)) return {ok:false,error_code:'NO_PRICE',message:'Item has no price',http_status:404,details:{upstream_url:itemUrl}};
  return { ok:true, price:item.price, source:'item', product_id:mlId, item_id:mlId, sold_winner: typeof item.sold_quantity==='number'?item.sold_quantity:null, sold_catalog_total:null, fetched_at };
}
