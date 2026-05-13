-- OZONTECK - Módulo Fiscal do Admin
-- Rode este SQL no Supabase antes de usar os cadastros manuais da aba Fiscal.
-- As telas de resumo funcionam com estimativas mesmo antes de cadastrar obrigações fiscais.

create table if not exists public.fiscal_settings (
  id uuid primary key default gen_random_uuid(),
  company_name text,
  company_document text,
  tax_regime text default 'simples_nacional',
  main_cnae text,
  secondary_cnaes jsonb default '[]'::jsonb,
  estimated_simples_percent numeric(10,4) default 4.0000,
  estimated_inss_pf_percent numeric(10,4) default 11.0000,
  estimated_irrf_enabled boolean default true,
  estimated_iss_enabled boolean default false,
  estimated_iss_pf_percent numeric(10,4) default 0,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.fiscal_obligations (
  id uuid primary key default gen_random_uuid(),
  obligation_type text not null,
  competence_month date not null,
  description text,
  estimated_amount numeric(12,2) default 0,
  final_amount numeric(12,2),
  due_date date,
  paid_at timestamptz,
  status text default 'PENDENTE',
  receipt_url text,
  notes text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.affiliate_tax_records (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid,
  affiliate_name text,
  affiliate_document text,
  competence_month date not null,
  gross_commission_amount numeric(12,2) default 0,
  estimated_inss_amount numeric(12,2) default 0,
  estimated_irrf_amount numeric(12,2) default 0,
  estimated_iss_amount numeric(12,2) default 0,
  net_amount numeric(12,2) default 0,
  payment_status text default 'PENDENTE',
  paid_at timestamptz,
  pix_receipt_url text,
  document_type text default 'RECIBO_RPA',
  document_url text,
  notes text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.order_invoice_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid,
  order_number text,
  customer_name text,
  customer_document text,
  invoice_status text default 'NAO_EMITIDA',
  invoice_number text,
  invoice_key text,
  invoice_url text,
  issued_at timestamptz,
  cancelled_at timestamptz,
  total_amount numeric(12,2) default 0,
  shipping_amount numeric(12,2) default 0,
  notes text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_fiscal_obligations_competence
  on public.fiscal_obligations (competence_month);

create index if not exists idx_affiliate_tax_records_competence
  on public.affiliate_tax_records (competence_month);

create index if not exists idx_order_invoice_records_order
  on public.order_invoice_records (order_id, order_number);
