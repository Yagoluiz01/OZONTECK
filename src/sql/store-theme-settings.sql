-- OZONTECK - Identidade visual da loja e paletas personalizadas
-- Rode este SQL no Supabase antes de salvar paletas pelo Admin.

create extension if not exists pgcrypto;

create table if not exists public.store_theme_settings (
  id text primary key default 'main',
  brand_name text not null default 'OZONTECK',
  brand_slogan text,
  logo_url text,
  favicon_url text,
  active_palette_id text default 'ozonteck_default',
  active_palette_type text default 'preset',
  primary_color text not null default '#11d1b2',
  secondary_color text not null default '#071014',
  accent_color text not null default '#d6ff59',
  background_color text not null default '#071014',
  text_color text not null default '#eaf4f7',
  button_color text not null default '#d6ff59',
  card_color text not null default '#0d1a20',
  price_color text not null default '#d6ff59',
  header_color text default '#050a0c',
  footer_color text default '#04080a',
  colors jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.store_color_palettes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'custom',
  description text,
  primary_color text not null,
  secondary_color text not null,
  accent_color text not null,
  background_color text not null,
  text_color text not null,
  button_color text not null,
  card_color text not null,
  price_color text not null,
  header_color text,
  footer_color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.store_theme_settings (
  id,
  brand_name,
  brand_slogan,
  active_palette_id,
  active_palette_type,
  primary_color,
  secondary_color,
  accent_color,
  background_color,
  text_color,
  button_color,
  card_color,
  price_color,
  header_color,
  footer_color,
  colors
)
values (
  'main',
  'OZONTECK',
  'Tecnologia em ozônio para sua rotina',
  'ozonteck_default',
  'preset',
  '#11d1b2',
  '#071014',
  '#d6ff59',
  '#071014',
  '#eaf4f7',
  '#d6ff59',
  '#0d1a20',
  '#d6ff59',
  '#050a0c',
  '#04080a',
  '{"primaryColor":"#11d1b2","secondaryColor":"#071014","accentColor":"#d6ff59","backgroundColor":"#071014","textColor":"#eaf4f7","buttonColor":"#d6ff59","cardColor":"#0d1a20","priceColor":"#d6ff59","headerColor":"#050a0c","footerColor":"#04080a"}'::jsonb
)
on conflict (id) do nothing;

create index if not exists idx_store_color_palettes_created_at
  on public.store_color_palettes (created_at desc);
