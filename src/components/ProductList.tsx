
import React from 'react';
import type { Product } from '../types';
function money(n:number){ return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) }
export default function ProductList({items,onDelete}:{items:Product[];onDelete:(id:string)=>void}){
  if(items.length===0) return <div className="notice">Nenhum produto salvo.</div>;
  return <div className="card"><table><thead><tr>
    <th>SKU</th><th>Descrição</th><th>ID ML</th><th>Preço ML</th><th>Custo Unit.</th><th>Margem</th><th>Atualizado</th><th>Ações</th>
  </tr></thead><tbody>{items.map(p=>(<tr key={p.id}>
    <td>{p.sku}</td><td>{p.description}</td><td>{p.mlProductId}</td>
    <td>{p.mlPrice?money(p.mlPrice):'-'}</td><td>{p.costUnitBrl?money(p.costUnitBrl):'-'}</td>
    <td>{p.marginPct!==undefined?p.marginPct!.toFixed(1)+'%':'-'}</td>
    <td>{p.updatedAt?new Date(p.updatedAt).toLocaleString('pt-BR'):'-'}</td>
    <td><button className="secondary" onClick={()=>onDelete(p.id)}>Excluir</button></td>
  </tr>))}</tbody></table></div>
}
