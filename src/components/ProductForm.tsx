
import React, { useMemo, useState } from 'react';
import type { Product } from '../types';
import { fetchPrice } from '../services/mercadolivre';
function money(n:number){ return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) }
export default function ProductForm({ onSave }:{ onSave:(p:Product)=>void }){
  const [p,setP]=useState<Product>({ id:crypto.randomUUID(), sku:'', description:'', mlProductId:'', usdUnit:0, qty:1, freightUsd:0, declaredUsd:0, fx:5, commissionPct:12, shippingFee:15, revenueTaxPct:6, icmsPorDentro:true });
  const calc=useMemo(()=>{ const freteUnitUsd=(p.freightUsd||0)/Math.max(1,p.qty||1); const declUnitUsd=(p.declaredUsd||0)/Math.max(1,p.qty||1); const cif=(declUnitUsd+freteUnitUsd)*(p.fx||0); const ii=cif*0.60; const icms=p.icmsPorDentro?(((cif+ii)/(1-0.17))*0.17):(cif+ii)*0.17; const totalImp=ii+icms; const costUnitBrl=cif+ii+icms; const ml=p.mlPrice||0; const comm=ml*(p.commissionPct/100); const fatur=ml*(p.revenueTaxPct/100); const marginAbs=ml-(costUnitBrl+comm+(p.shippingFee||0)+fatur); const marginPct=ml>0?(marginAbs/ml)*100:0; return {freteUnitUsd,declUnitUsd,cif,ii,icms,totalImp,costUnitBrl,comm,fatur,marginAbs,marginPct}; },[p]);
  const update=(k:keyof Product,v:any)=>setP(prev=>({...prev,[k]:v}));
  const handleFetchML=async()=>{ if(!p.mlProductId) return alert('Informe o ID de catálogo MLB...'); const r=await fetchPrice(p.mlProductId); if(!r.ok){ alert(r.message||'Falha ao obter preço'); return; } setP(prev=>({...prev, mlPrice:r.price!, mlSource:r.source, mlItemId:r.item_id||null, soldWinner:r.sold_winner??null, soldCatalogTotal:r.sold_catalog_total??null, updatedAt:r.fetched_at||new Date().toISOString()})); };
  const save=()=>{ const payload:Product={...p, costUnitBrl:calc.costUnitBrl, marginAbs:calc.marginAbs, marginPct:calc.marginPct}; onSave(payload); setP(prev=>({...prev,id:crypto.randomUUID()})); };
  return <div className="card"><div className="grid">
    <div className="col-12"><h2>Novo Produto</h2></div>
    <div className="col-3"><label>SKU *</label><input value={p.sku} onChange={e=>update('sku',e.target.value)} /></div>
    <div className="col-4"><label>ID Mercado Livre (Catálogo MLB*) *</label><div style={{display:'flex',gap:8}}>
      <input style={{flex:1}} value={p.mlProductId} onChange={e=>update('mlProductId',e.target.value.trim())} placeholder="MLB35854070" />
      <button onClick={handleFetchML} title="Atualizar Preço ML">🔎</button></div></div>
    <div className="col-5"><label>Descrição *</label><input value={p.description} onChange={e=>update('description',e.target.value)} /></div>
    <div className="col-3"><label>Custo Unitário (USD) *</label><input type="number" value={p.usdUnit} onChange={e=>update('usdUnit',parseFloat(e.target.value||'0'))} /></div>
    <div className="col-3"><label>Quantidade *</label><input type="number" value={p.qty} onChange={e=>update('qty',parseInt(e.target.value||'1'))} /></div>
    <div className="col-3"><label>Frete Total (USD)</label><input type="number" value={p.freightUsd} onChange={e=>update('freightUsd',parseFloat(e.target.value||'0'))} /></div>
    <div className="col-3"><label>Valor Declarado (USD)</label><input type="number" value={p.declaredUsd} onChange={e=>update('declaredUsd',parseFloat(e.target.value||'0'))} /></div>
    <div className="col-3"><label>Cotação USD/BRL *</label><input type="number" value={p.fx} onChange={e=>update('fx',parseFloat(e.target.value||'5'))} /></div>
    <div className="col-3"><label>Comissão ML (%)</label><input type="number" value={p.commissionPct} onChange={e=>update('commissionPct',parseFloat(e.target.value||'12'))} /></div>
    <div className="col-3"><label>Envio ML (R$)</label><input type="number" value={p.shippingFee} onChange={e=>update('shippingFee',parseFloat(e.target.value||'0'))} /></div>
    <div className="col-3"><label>Imposto Faturamento (%)</label><input type="number" value={p.revenueTaxPct} onChange={e=>update('revenueTaxPct',parseFloat(e.target.value||'0'))} /></div>
    <div className="col-12"><label><input type="checkbox" checked={p.icmsPorDentro} onChange={e=>update('icmsPorDentro',e.target.checked)} /> ICMS por dentro (17% SP)</label></div>
    <div className="col-12 card"><div className="grid">
      <div className="col-3"><label>Frete Unitário USD</label><input readOnly value={calc.freteUnitUsd.toFixed(2)} /></div>
      <div className="col-3"><label>Decl. Unitário USD</label><input readOnly value={calc.declUnitUsd.toFixed(2)} /></div>
      <div className="col-3"><label>II 60%</label><input readOnly value={money(calc.ii)} /></div>
      <div className="col-3"><label>ICMS 17%</label><input readOnly value={money(calc.icms)} /></div>
      <div className="col-3"><label>Base CIF (BRL)</label><input readOnly value={money(calc.cif)} /></div>
      <div className="col-3"><label>Impostos Total</label><input readOnly value={money(calc.totalImp)} /></div>
      <div className="col-3"><label>Custo Unit. BRL</label><input readOnly value={money(calc.costUnitBrl)} /></div>
      <div className="col-3"><label>Preço Atual ML (R$)</label><input readOnly value={p.mlPrice ? p.mlPrice.toFixed(2) : ''} /></div>
      <div className="col-3"><label>Margem Líquida (R$)</label><input readOnly value={money(calc.marginAbs)} /></div>
      <div className="col-3"><label>Margem (%)</label><input readOnly value={calc.marginPct.toFixed(2)+'%'} /></div>
      <div className="col-3"><label>Origem do Preço</label><div>{p.mlSource ? <span className={`pill ${p.mlSource}`}>{p.mlSource}</span> : <span className="pill">--</span>}</div></div>
      <div className="col-3"><label>Vendas (Buy Box) / Catálogo</label><div>{(p.soldWinner ?? '-') + ' / ' + (p.soldCatalogTotal ?? '-')}</div></div>
    </div></div>
    <div className="col-12" style={{display:'flex',gap:10}}>
      <button onClick={save}>Salvar Produto</button>
      <button className="secondary" onClick={()=>setP({...p, mlPrice:undefined, mlSource:undefined, mlItemId:null})}>Limpar Preço ML</button>
      {p.mlItemId ? <a className="pill" target="_blank" href={`https://mercadolivre.com.br/item/${p.mlItemId}`}>Ver anúncio</a> : null}
    </div>
  </div></div>;
}
