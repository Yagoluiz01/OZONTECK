begin;

alter table public.affiliates
  add column if not exists auth_token_version integer not null default 1;

alter table public.affiliates
  add column if not exists password_changed_at timestamptz null;

update public.affiliates
set auth_token_version = 1
where auth_token_version is null or auth_token_version < 1;

with ranked_active_resets as (
  select
    id,
    row_number() over (
      partition by affiliate_id
      order by created_at desc, id desc
    ) as position
  from public.affiliate_password_resets
  where used_at is null
)
update public.affiliate_password_resets as reset_row
set used_at = now()
from ranked_active_resets as ranked
where reset_row.id = ranked.id
  and ranked.position > 1;

create unique index if not exists uq_affiliate_password_resets_token_hash
  on public.affiliate_password_resets (token_hash);

create unique index if not exists uq_affiliate_password_resets_one_active
  on public.affiliate_password_resets (affiliate_id)
  where used_at is null;

create or replace function public.reset_affiliate_password_atomic(
  p_token_hash text,
  p_password_hash text
)
returns table (
  affiliate_id uuid,
  auth_token_version integer,
  password_changed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reset_id uuid;
  v_affiliate_id uuid;
  v_now timestamptz := now();
begin
  if nullif(trim(p_token_hash), '') is null then
    return;
  end if;

  if nullif(trim(p_password_hash), '') is null then
    return;
  end if;

  select reset_row.id, reset_row.affiliate_id
  into v_reset_id, v_affiliate_id
  from public.affiliate_password_resets as reset_row
  where reset_row.token_hash = p_token_hash
    and reset_row.used_at is null
    and reset_row.expires_at > v_now
  order by reset_row.created_at desc
  limit 1
  for update skip locked;

  if v_reset_id is null or v_affiliate_id is null then
    return;
  end if;

  update public.affiliate_password_resets
  set used_at = v_now
  where id = v_reset_id
    and used_at is null;

  if not found then
    return;
  end if;

  update public.affiliates as affiliate_row
  set
    password_hash = p_password_hash,
    auth_token_version = greatest(
      coalesce(affiliate_row.auth_token_version, 1),
      1
    ) + 1,
    password_changed_at = v_now,
    updated_at = v_now
  where affiliate_row.id = v_affiliate_id
  returning
    affiliate_row.id,
    affiliate_row.auth_token_version,
    affiliate_row.password_changed_at
  into affiliate_id, auth_token_version, password_changed_at;

  if affiliate_id is null then
    raise exception 'Afiliado do token de redefinição não encontrado.';
  end if;

  return next;
end;
$$;

revoke all on function public.reset_affiliate_password_atomic(text, text)
  from public, anon, authenticated;

grant execute on function public.reset_affiliate_password_atomic(text, text)
  to service_role;

commit;

