-- Configuração global das comissões do programa de afiliados.
-- Compatível com a migration anterior de comissão fixa direta.
-- Não altera regras antigas até que cada chave global seja explicitamente ativada.

create table if not exists public.affiliate_commission_settings (
  id text primary key,
  fixed_commission_enabled boolean not null default false,
  fixed_commission_percent numeric(5,2),
  fixed_recruitment_commission_enabled boolean not null default false,
  fixed_recruitment_commission_percent numeric(5,2),
  updated_by_admin_id text,
  updated_at timestamptz not null default now(),
  constraint affiliate_commission_settings_fixed_percent_check
    check (fixed_commission_percent is null or (fixed_commission_percent >= 0 and fixed_commission_percent <= 100)),
  constraint affiliate_commission_settings_fixed_required_check
    check (not fixed_commission_enabled or fixed_commission_percent is not null),
  constraint affiliate_commission_settings_recruitment_percent_check
    check (fixed_recruitment_commission_percent is null or (fixed_recruitment_commission_percent >= 0 and fixed_recruitment_commission_percent <= 100)),
  constraint affiliate_commission_settings_recruitment_required_check
    check (not fixed_recruitment_commission_enabled or fixed_recruitment_commission_percent is not null)
);

alter table public.affiliate_commission_settings
  add column if not exists fixed_recruitment_commission_enabled boolean not null default false;

alter table public.affiliate_commission_settings
  add column if not exists fixed_recruitment_commission_percent numeric(5,2);

-- Em bancos onde a tabela veio da migration anterior, cria as restrições novas de forma idempotente.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'affiliate_commission_settings_recruitment_percent_check'
      and conrelid = 'public.affiliate_commission_settings'::regclass
  ) then
    alter table public.affiliate_commission_settings
      add constraint affiliate_commission_settings_recruitment_percent_check
      check (fixed_recruitment_commission_percent is null or (fixed_recruitment_commission_percent >= 0 and fixed_recruitment_commission_percent <= 100));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'affiliate_commission_settings_recruitment_required_check'
      and conrelid = 'public.affiliate_commission_settings'::regclass
  ) then
    alter table public.affiliate_commission_settings
      add constraint affiliate_commission_settings_recruitment_required_check
      check (not fixed_recruitment_commission_enabled or fixed_recruitment_commission_percent is not null);
  end if;
end $$;

insert into public.affiliate_commission_settings (
  id,
  fixed_commission_enabled,
  fixed_recruitment_commission_enabled
)
values ('global', false, false)
on conflict (id) do nothing;

comment on column public.affiliate_commission_settings.fixed_recruitment_commission_enabled is
  'Quando true, novas comissões de rede/recrutamento usam o percentual global e a precificação usa a mesma regra.';

comment on column public.affiliate_commission_settings.fixed_recruitment_commission_percent is
  'Percentual global da comissão de recrutamento. Na precificação, o custo é calculado em R$ por unidade vendida (preço unitário x percentual).';
