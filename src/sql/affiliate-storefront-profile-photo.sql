-- OZONTECK - foto de perfil da loja do afiliado
-- Rode no Supabase SQL Editor antes de testar o upload da foto.

alter table public.affiliate_storefronts
add column if not exists profile_photo_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'affiliate-profile-photos',
  'affiliate-profile-photos',
  true,
  3145728,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
