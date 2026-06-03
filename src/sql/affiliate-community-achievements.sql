-- Comunidade de Conquistas dos Afiliados
-- Rode este SQL no Supabase antes de subir a nova tela em produção.

create table if not exists public.affiliate_level_achievements (
  id uuid primary key default gen_random_uuid(),

  affiliate_id uuid not null,
  affiliate_name text not null,
  affiliate_avatar_url text,

  level_order integer not null default 1,
  level_name text not null,

  sales_count integer not null default 0,
  month_gain numeric(12,2) not null default 0,
  total_gain numeric(12,2) not null default 0,

  headline text,
  message text,

  is_public boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint affiliate_level_achievements_unique_level unique (affiliate_id, level_order)
);

create table if not exists public.affiliate_level_achievement_congrats (
  id uuid primary key default gen_random_uuid(),

  achievement_id uuid not null references public.affiliate_level_achievements(id) on delete cascade,
  affiliate_id uuid not null,
  affiliate_name text,
  affiliate_avatar_url text,

  created_at timestamptz not null default now(),

  constraint affiliate_level_achievement_congrats_unique unique (achievement_id, affiliate_id)
);

create index if not exists idx_affiliate_level_achievements_public_order
  on public.affiliate_level_achievements(is_public, level_order desc, created_at desc);

create index if not exists idx_affiliate_level_achievements_affiliate
  on public.affiliate_level_achievements(affiliate_id);

create index if not exists idx_affiliate_level_achievement_congrats_achievement
  on public.affiliate_level_achievement_congrats(achievement_id, created_at desc);

create or replace function public.set_affiliate_level_achievements_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_affiliate_level_achievements_updated_at
  on public.affiliate_level_achievements;

create trigger trg_affiliate_level_achievements_updated_at
before update on public.affiliate_level_achievements
for each row
execute function public.set_affiliate_level_achievements_updated_at();

alter table public.affiliate_level_achievements enable row level security;
alter table public.affiliate_level_achievement_congrats enable row level security;

revoke all on public.affiliate_level_achievements from anon;
revoke all on public.affiliate_level_achievements from authenticated;
revoke all on public.affiliate_level_achievement_congrats from anon;
revoke all on public.affiliate_level_achievement_congrats from authenticated;


-- Segurança da comunidade:
-- A comunidade mostra somente conquistas a partir do segundo nível.
-- Remove qualquer registro antigo de Iniciante/nível inicial criado em testes anteriores.
delete from public.affiliate_level_achievement_congrats
where achievement_id in (
  select id
  from public.affiliate_level_achievements
  where coalesce(level_order, 1) < 2
     or lower(coalesce(level_name, '')) in ('iniciante', 'inicial', 'nivel inicial', 'nível inicial')
);

delete from public.affiliate_level_achievements
where coalesce(level_order, 1) < 2
   or lower(coalesce(level_name, '')) in ('iniciante', 'inicial', 'nivel inicial', 'nível inicial');
