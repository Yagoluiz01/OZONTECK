-- OZONTECK - Feed/Mural dos Afiliados
-- Versão segura com moderação admin e imagens WEBP.
-- Cria somente tabelas, índices, trigger e bucket novos.
-- Não altera pedidos, comissões, pagamentos, login, árvore genealógica ou afiliados existentes.

create extension if not exists "pgcrypto";

create table if not exists affiliate_feed_posts (
  id uuid primary key default gen_random_uuid(),

  affiliate_id uuid not null,
  affiliate_name text,
  affiliate_avatar_url text,

  post_type text not null default 'tip'
    check (post_type in ('result', 'tip', 'ad', 'announcement', 'other')),

  content text not null
    check (char_length(content) >= 3 and char_length(content) <= 2000),

  -- image_path é sempre caminho privado no Supabase Storage.
  -- A API converte/salva as imagens como WEBP.
  image_path text,
  image_url text,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'hidden', 'banned')),

  is_pinned boolean not null default false,
  is_official boolean not null default false,

  likes_count integer not null default 0 check (likes_count >= 0),

  approved_at timestamptz,
  approved_by uuid,
  rejected_reason text,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table affiliate_feed_posts add column if not exists image_path text;
alter table affiliate_feed_posts add column if not exists image_url text;
alter table affiliate_feed_posts add column if not exists rejected_reason text;
alter table affiliate_feed_posts add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Atualiza a regra de status com segurança caso a versão anterior já tenha sido criada.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'affiliate_feed_posts_status_check'
      and conrelid = 'affiliate_feed_posts'::regclass
  ) then
    alter table affiliate_feed_posts drop constraint affiliate_feed_posts_status_check;
  end if;
end $$;

alter table affiliate_feed_posts
add constraint affiliate_feed_posts_status_check
check (status in ('pending', 'approved', 'rejected', 'hidden', 'banned'));

create table if not exists affiliate_feed_likes (
  id uuid primary key default gen_random_uuid(),

  post_id uuid not null references affiliate_feed_posts(id) on delete cascade,
  affiliate_id uuid not null,

  created_at timestamptz not null default now(),

  unique(post_id, affiliate_id)
);

create index if not exists idx_affiliate_feed_posts_status_created
on affiliate_feed_posts(status, created_at desc);

create index if not exists idx_affiliate_feed_posts_affiliate
on affiliate_feed_posts(affiliate_id);

create index if not exists idx_affiliate_feed_posts_pinned
on affiliate_feed_posts(is_pinned, created_at desc);

create index if not exists idx_affiliate_feed_likes_post
on affiliate_feed_likes(post_id);

create index if not exists idx_affiliate_feed_likes_affiliate
on affiliate_feed_likes(affiliate_id);

create or replace function update_affiliate_feed_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_affiliate_feed_posts_updated_at on affiliate_feed_posts;

create trigger trg_affiliate_feed_posts_updated_at
before update on affiliate_feed_posts
for each row
execute function update_affiliate_feed_updated_at();

-- Defesa extra: sem acesso direto por anon/authenticated.
-- A API usa service role no servidor e bypassa RLS; o navegador não consulta essas tabelas diretamente.
alter table affiliate_feed_posts enable row level security;
alter table affiliate_feed_likes enable row level security;

revoke all on table affiliate_feed_posts from anon, authenticated;
revoke all on table affiliate_feed_likes from anon, authenticated;

-- Bucket privado para imagens do feed.
-- A API salva como WEBP e entrega ao painel apenas URLs assinadas temporárias.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'affiliate-feed-images',
  'affiliate-feed-images',
  false,
  3145728,
  array['image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = 3145728,
    allowed_mime_types = array['image/webp'];


-- Stories em vídeo da Comunidade dos Afiliados
create table if not exists public.affiliate_feed_stories (
  id uuid primary key default gen_random_uuid(),

  affiliate_id uuid,
  affiliate_name text,
  affiliate_avatar_url text,

  title text not null check (char_length(title) >= 3 and char_length(title) <= 90),
  description text check (char_length(coalesce(description, '')) <= 700),

  video_url text not null,
  thumbnail_url text,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'hidden', 'banned')),

  is_pinned boolean not null default false,
  is_official boolean not null default false,

  approved_at timestamptz,
  approved_by uuid,
  rejected_reason text,

  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_affiliate_feed_stories_status_created
  on public.affiliate_feed_stories(status, created_at desc);

create index if not exists idx_affiliate_feed_stories_affiliate
  on public.affiliate_feed_stories(affiliate_id);

create index if not exists idx_affiliate_feed_stories_pinned
  on public.affiliate_feed_stories(is_pinned, created_at desc);

create index if not exists idx_affiliate_feed_stories_expires
  on public.affiliate_feed_stories(expires_at);

create or replace function public.update_affiliate_feed_stories_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_affiliate_feed_stories_updated_at on public.affiliate_feed_stories;

create trigger trg_affiliate_feed_stories_updated_at
before update on public.affiliate_feed_stories
for each row
execute function public.update_affiliate_feed_stories_updated_at();

alter table public.affiliate_feed_stories enable row level security;

revoke all on public.affiliate_feed_stories from anon;
revoke all on public.affiliate_feed_stories from authenticated;


-- Upload direto de vídeo curto para Stories
alter table if exists public.affiliate_feed_stories
  add column if not exists video_path text;

alter table if exists public.affiliate_feed_stories
  add column if not exists video_mime_type text;

alter table if exists public.affiliate_feed_stories
  add column if not exists video_size_bytes integer;

alter table if exists public.affiliate_feed_stories
  add column if not exists video_source text not null default 'link'
    check (video_source in ('link', 'upload'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'affiliate-story-videos',
  'affiliate-story-videos',
  false,
  20971520,
  array['video/mp4', 'video/webm']
)
on conflict (id) do update
set public = false,
    file_size_limit = 20971520,
    allowed_mime_types = array['video/mp4', 'video/webm'];


-- Stories 24h: validade curta e limpeza do banco
alter table if exists public.affiliate_feed_stories
  add column if not exists expires_at timestamptz;

update public.affiliate_feed_stories
set expires_at = coalesce(expires_at, created_at + interval '24 hours')
where expires_at is null;

create index if not exists idx_affiliate_feed_stories_expires_cleanup
  on public.affiliate_feed_stories(expires_at);

create or replace function public.cleanup_expired_affiliate_feed_stories()
returns integer
language plpgsql
security definer
as $$
declare
  deleted_count integer := 0;
begin
  delete from public.affiliate_feed_stories
  where expires_at is not null
    and expires_at < now();

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
