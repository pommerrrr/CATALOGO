
export type Source = 'buy_box' | 'catalog_offers' | 'item';
export interface MLResponse { ok:boolean; price?:number; source?:Source; product_id?:string; item_id?:string|null; sold_winner?:number|null; sold_catalog_total?:number|null; fetched_at?:string; error_code?:string; message?:string; http_status?:number; details?:any; }
export interface Product { id:string; sku:string; description:string; mlProductId:string; usdUnit:number; qty:number; freightUsd:number; declaredUsd:number; fx:number; commissionPct:number; shippingFee:number; revenueTaxPct:number; icmsPorDentro:boolean; mlPrice?:number; mlSource?:Source; mlItemId?:string|null; soldWinner?:number|null; soldCatalogTotal?:number|null; costUnitBrl?:number; marginAbs?:number; marginPct?:number; updatedAt?:string; }
