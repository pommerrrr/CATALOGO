
import React, { useEffect, useState } from 'react';
import ProductForm from './components/ProductForm';
import ProductList from './components/ProductList';
import type { Product } from './types';
export default function App(){
  const [items,setItems]=useState<Product[]>([]);
  useEffect(()=>{ const raw=localStorage.getItem('products'); if(raw) setItems(JSON.parse(raw)); },[]);
  useEffect(()=>{ localStorage.setItem('products', JSON.stringify(items)); },[items]);
  const handleSave=(p:Product)=>{ setItems(prev=>[p,...prev]); alert('Produto salvo!'); };
  const handleDelete=(id:string)=> setItems(prev=> prev.filter(x=>x.id!==id));
  return (<div className="container">
    <h1>Controle de Custos de Importação</h1>
    <p className="notice">MVP: dados salvos no navegador. API interna consulta Mercado Livre (Buy Box / ofertas).</p>
    <ProductForm onSave={handleSave} />
    <h2>Lista de Produtos</h2>
    <ProductList items={items} onDelete={handleDelete} />
  </div>);
}
