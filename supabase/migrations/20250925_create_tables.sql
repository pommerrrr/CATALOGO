-- supabase/migrations/20250925_create_tables.sql
create extension if not exists pgcrypto;

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  sku text,
  description text,
  catalog_id text not null,
  my_item_id text,
  commission_ml numeric not null default 12,
  shipping_ml_brl numeric not null default 0,
  faturamento_pct numeric not null default 0,
  cost_unit_usd numeric not null default 0,
  qty integer not null default 1,
  freight_usd numeric not null default 0,
  declared_usd numeric not null default 0,
  usd_brl numeric not null default 5,
  icms_inside boolean not null default true,
  ml_price_brl numeric,
  ml_source text,
  margin_brl numeric,
  margin_pct numeric,
  computed jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists products_catalog_id_idx on products(catalog_id);

create table if not exists product_price_history (
  id bigint generated always as identity primary key,
  product_id uuid references products(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  ml_price_brl numeric,
  ml_source text,
  taxes_brl numeric,
  unit_cost_brl numeric,
  margin_brl numeric,
  margin_pct numeric,
  meta jsonb
);

create index if not exists pph_product_id_idx on product_price_history(product_id);
