// api/preco_wid.js (no-auth WID-only)
const ML_BASE = "https://api.mercadolibre.com";
const isWID = s => !!s && /^MLB\d{10,}$/i.test(String(s).trim());
const widFromHash = (url)=>{ if(!url) return null; try{ const h=String(url).split("#")[1]||""; const m=h.match(/wid=(MLB\d{10,})/i); return m?m[1].toUpperCase():null; }catch{ return null; } };
const send=(res,code,body)=>{ res.statusCode=code; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify(body)); };
async function getJson(url){ const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"WidOnly/1.0"}}); const ct=r.headers.get("content-type")||""; let data=null; if(ct.includes("application/json")){ try{ data=await r.json(); }catch{} } return {ok:r.ok,status:r.status,data,url}; }
module.exports = async (req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Cache-Control","no-store");
  if(req.method==="OPTIONS") return send(res,200,{ok:true});
  if(req.method!=="GET") return send(res,200,{ok:false,error_code:"METHOD_NOT_ALLOWED",http_status:405});
  const q=req.query||{}; const input=String(q.product_id||"").trim();
  let wid=isWID(input)?input.toUpperCase():widFromHash(input);
  if(!isWID(wid)) return send(res,200,{ok:false,error_code:"MISSING_WID",message:"Passe WID (MLB...) ou link com #...wid=MLB..."});
  const url=`${ML_BASE}/items/${wid}?attributes=price,status,sold_quantity,permalink`;
  const r=await getJson(url);
  if(!r.ok) return send(res,200,{ok:false,error_code:"UPSTREAM_ERROR",message:`Erro ${r.status} em /items/{id}`,http_status:r.status,details:{upstream_url:r.url}});
  const body=r.data||{}; const price=Number(body.price||0);
  if(!price) return send(res,200,{ok:false,error_code:"NO_PRICE",message:"Anúncio sem preço disponível",http_status:404});
  return send(res,200,{ok:true,price,source:"item",product_id:wid,item_id:wid,sold_winner:Number.isFinite(body.sold_quantity)?body.sold_quantity:null,fetched_at:new Date().toISOString()});
};
