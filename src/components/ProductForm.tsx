// src/components/ProductForm.tsx
import React, { useMemo, useState } from 'react';
import type { Product } from '../types';
import { computeCosts } from '../lib/calculations';
import { fetchPriceSmart } from '../services/mercadolivre';

function money(n:number){ return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) }

export default function ProductForm({ onSave }:{ onSave:(p:Product)=>void }){
  const [p,setP]=useState<Product>({
    id: crypto.randomUUID(),
    sku: '',
    description: '',
    mlProductId: '',          // pode ser ID ou LINK do catálogo
    mlItemId: '',             // pode ser ID ou LINK do seu anúncio
    costUnitUsd: 0,
    qty: 1,
    freightUsd: 0,
    declaredUsd: 0,
    usdbrl: 5,
    icmsPorDentro: true,
    commissionPct: 12,
    shippingFee: 0,
    revenueTaxPct: 0
  });

  const calc = useMemo(()=>{
    const unit = Number(p.costUnitUsd||0);
    const qty = Number(p.qty||0);
    const freight = Number(p.freightUsd||0);
    const usdbrl = Number(p.usdbrl||0);
    const mlPrice = Number(p.mlPrice||0);
    const out = computeCosts({
      unitUsd: unit,
      qty,
      freightUsd: freight,
      usdbrl,
      icmsInside: !!p.icmsPorDentro,
      faturPct: Number(p.revenueTaxPct||0),
      commissionPct: Number(p.commissionPct||0),
      mlPrice,
      shippingMlBrl: Number(p.shippingFee||0),
    });
    return out;
  },[p]);

  const update=(k:keyof Product,v:any)=>setP(prev=>({...prev,[k]:v}));

  async function handleFetchML(){
    if(!p.mlProductId?.trim()){
      alert('Informe o ID ou link do catálogo (MLB...)');
      return;
    }
    const r = await fetchPriceSmart(p.mlProductId, p.mlItemId || undefined, true, true);
    if (r.ok && typeof r.price === 'number') {
      setP(prev=>({
        ...prev,
        mlPrice: r.price,
        mlSource: r.source,
        soldWinner: r.sold_winner ?? undefined,
        soldCatalogTotal: r.sold_catalog_total ?? undefined,
        updatedAt: r.fetched_at || new Date().toISOString()
      }));
    } else {
      alert(`Erro ML: ${r.error_code || 'UNKNOWN'} - ${r.message || 'sem detalhe'}`);
    }
  }

  function handleCompute(){
    // só força re-render do memo se necessário
    setP(prev=>({...prev}));
  }

  function save(){
    const payload: Product = {
      ...p,
      costUnitBrl: calc.custoUnitBrl,
      marginAbs: calc.margemBrl,
      marginPct: calc.margemPct,
      updatedAt: new Date().toISOString()
    };
    onSave(payload);
    // novo id para próximo cadastro
    setP(prev=>({ ...prev, id: crypto.randomUUID() }));
  }

  const sourceClass = !p.mlSource ? 'pill' : `pill ${p.mlSource}`;

  return (
    <div className="card">
      <div className="grid">
        <div className="col-12"><h2>Novo Produto</h2></div>

        <div className="col-3">
          <label>SKU *</label>
          <input value={p.sku} onChange={e=>update('sku',e.target.value)} />
        </div>

        <div className="col-6">
          <label>Descrição</label>
          <input value={p.description} onChange={e=>update('description',e.target.value)} />
        </div>

        <div className="col-6">
          <label>Catálogo (ID MLB ou link)</label>
          <input
            value={p.mlProductId}
            onChange={e=>update('mlProductId', e.target.value.trim())}
            placeholder="MLB35854070 ou https://.../p/MLB35854070#...wid=MLB..."
          />
          <p className="text-xs" style={{opacity:.7, marginTop:6}}>
            Se colar o link do catálogo com <code>#...wid=MLB...</code>, o sistema usa seu WID como fallback automaticamente.
          </p>
        </div>

        <div className="col-6">
          <label>Meu anúncio (opcional - ID MLB ou link)</label>
          <input
            value={p.mlItemId || ''}
            onChange={e=>update('mlItemId', e.target.value.trim())}
            placeholder="MLB1234567890123 ou https://produto.mercadolivre.com.br/MLB..."
          />
        </div>

        <div className="col-3">
          <label>Custo Unit. (USD)</label>
          <input type="number" step="0.01" value={p.costUnitUsd||0} onChange={e=>update('costUnitUsd', Number(e.target.value))} />
        </div>

        <div className="col-3">
          <label>Qtd.</label>
          <input type="number" value={p.qty||0} onChange={e=>update('qty', Number(e.target.value))} />
        </div>

        <div className="col-3">
          <label>Frete (USD)</label>
          <input type="number" step="0.01" value={p.freightUsd||0} onChange={e=>update('freightUsd', Number(e.target.value))} />
        </div>

        <div className="col-3">
          <label>Declarado (USD)</label>
          <input type="number" step="0.01" value={p.declaredUsd||0} onChange={e=>update('declaredUsd', Number(e.target.value))} />
        </div>

        <div className="col-3">
          <label>Câmbio (USD→BRL)</label>
          <input type="number" step="0.0001" value={p.usdbrl||0} onChange={e=>update('usdbrl', Number(e.target.value))} />
        </div>

        <div className="col-3">
          <label>% Comissão ML</label>
          <input type="number" step="0.01" value={p.commissionPct||0} onChange={e=>update('commissionPct', Number(e.target.value))} />
        </div>

        <div className="col-3">
          <label>Envio ML (R$)</label>
          <input type="number" step="0.01" value={p.shippingFee||0} onChange={e=>update('shippingFee', Number(e.target.value))} />
        </div>

        <div className="col-3">
          <label>% Imp. Faturamento</label>
          <input type="number" step="0.01" value={p.revenueTaxPct||0} onChange={e=>update('revenueTaxPct', Number(e.target.value))} />
        </div>

        <div className="col-12">
          <label><input type="checkbox" checked={p.icmsPorDentro} onChange={e=>update('icmsPorDentro', e.target.checked)} /> ICMS 17% por dentro (SP)</label>
        </div>

        <div className="col-12" style={{display:'flex', gap:10}}>
          <button onClick={handleFetchML}>Atualizar Preço ML</button>
          <button className="secondary" onClick={handleCompute}>Calcular Margem</button>
          <button className="secondary" onClick={()=>setP(prev=>({...prev, mlPrice: undefined, mlSource: undefined, soldWinner: undefined, soldCatalogTotal: undefined}))}>Limpar Preço ML</button>
          <button onClick={save}>Salvar Produto</button>
          {p.mlItemId && /^MLB\d{10,}$/i.test(p.mlItemId) ? (
            <a className="pill" target="_blank" href={`https://produto.mercadolivre.com.br/${p.mlItemId}`}>Ver anúncio</a>
          ) : null}
        </div>

        <div className="col-3">
          <label>CIF (R$)</label>
          <input readOnly value={money(calc.cifBrl)} />
        </div>
        <div className="col-3">
          <label>II 60% (R$)</label>
          <input readOnly value={money(calc.ii)} />
        </div>
        <div className="col-3">
          <label>ICMS (R$)</label>
          <input readOnly value={money(calc.icms)} />
        </div>
        <div className="col-3">
          <label>Impostos (R$)</label>
          <input readOnly value={money(calc.impostos)} />
        </div>

        <div className="col-3">
          <label>Custo Unit. BRL</label>
          <input readOnly value={money(calc.custoUnitBrl)} />
        </div>
        <div className="col-3">
          <label>Preço Atual ML (R$)</label>
          <input readOnly value={p.mlPrice ? p.mlPrice.toFixed(2) : ''} />
        </div>
        <div className="col-3">
          <label>Margem Líquida (R$)</label>
          <input readOnly value={money(calc.margemBrl)} />
        </div>
        <div className="col-3">
          <label>Margem (%)</label>
          <input readOnly value={calc.margemPct.toFixed(2)+'%'} />
        </div>

        <div className="col-3">
          <label>Origem do Preço</label>
          <div>{p.mlSource ? <span className={sourceClass}>{p.mlSource}</span> : <span className="pill">--</span>}</div>
        </div>
        <div className="col-3">
          <label>Vendas (winner/catalog)</label>
          <div>{(p.soldWinner ?? '-') + ' / ' + (p.soldCatalogTotal ?? '-')}</div>
        </div>
      </div>
    </div>
  );
}
