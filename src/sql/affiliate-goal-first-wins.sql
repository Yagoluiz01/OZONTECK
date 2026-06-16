-- OZONTECK — Correção de metas alternativas (primeiro caminho vence)
-- Regra: para cada afiliado + nível, a meta padrão OU a meta específica do produto
-- libera um único bônus. O primeiro caminho concluído fecha o outro e avança o ciclo.

create extension if not exists pgcrypto;

create table if not exists public.affiliate_level_reward_claims (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  affiliate_level_id uuid not null references public.affiliate_levels(id) on delete restrict,
  level_order integer not null,
  level_name text null,
  winning_path text not null check (winning_path in ('standard_goal','product_goal')),
  target_id uuid null references public.affiliate_product_goal_targets(id) on delete set null,
  product_id uuid null references public.products(id) on delete set null,
  completion_id uuid null references public.affiliate_product_goal_completions(id) on delete set null,
  product_conversion_id uuid null references public.affiliate_conversions(id) on delete set null,
  standard_bonus_id text null,
  status text not null default 'processing'
    check (status in ('processing','released','paid','cancelled','review_required')),
  won_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint affiliate_level_reward_claims_affiliate_level_key
    unique (affiliate_id, affiliate_level_id)
);

create index if not exists idx_affiliate_level_reward_claims_affiliate
  on public.affiliate_level_reward_claims (affiliate_id, level_order, updated_at desc);

alter table public.affiliate_level_reward_claims enable row level security;
revoke all on table public.affiliate_level_reward_claims from anon;
revoke all on table public.affiliate_level_reward_claims from authenticated;
grant select, insert, update, delete on table public.affiliate_level_reward_claims to service_role;

-- Amplia apenas os estados técnicos da conclusão específica.
alter table public.affiliate_product_goal_completions
  drop constraint if exists affiliate_product_goal_completions_status_check;

alter table public.affiliate_product_goal_completions
  add constraint affiliate_product_goal_completions_status_check
  check (status in (
    'processing','released','completed_without_bonus','cancelled','review_required',
    'superseded_by_standard'
  ));

-- Localiza, de forma compatível, a tabela física usada pela view de bônus padrão.
create or replace function public.oz_find_affiliate_level_bonus_table()
returns regclass
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table regclass;
begin
  if to_regclass('public.affiliate_level_bonuses') is not null then
    return to_regclass('public.affiliate_level_bonuses');
  end if;

  if to_regclass('public.affiliate_bonuses') is not null then
    return to_regclass('public.affiliate_bonuses');
  end if;

  if to_regclass('public.affiliate_bonus_overview') is null then
    return null;
  end if;

  select c.oid::regclass
    into v_table
  from pg_rewrite r
  join pg_depend d on d.objid = r.oid
  join pg_class c on c.oid = d.refobjid
  join pg_namespace n on n.oid = c.relnamespace
  where r.ev_class = to_regclass('public.affiliate_bonus_overview')
    and c.relkind in ('r','p')
    and n.nspname = 'public'
    and exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'affiliate_id'
        and a.attnum > 0 and not a.attisdropped
    )
    and exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'status'
        and a.attnum > 0 and not a.attisdropped
    )
    and exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname in ('bonus_amount','amount')
        and a.attnum > 0 and not a.attisdropped
    )
  order by (
    select count(*)
    from pg_attribute a
    where a.attrelid = c.oid
      and a.attname in (
        'affiliate_id','affiliate_level_id','level_id','level_order','level_name',
        'bonus_amount','amount','bonus_type','status','released_at','approved_at',
        'paid_at','admin_notes','metadata'
      )
      and a.attnum > 0 and not a.attisdropped
  ) desc
  limit 1;

  return v_table;
end;
$$;

-- Cria um marcador técnico de valor zero no mecanismo padrão.
-- Esse marcador permite que o ciclo/patente avance sem pagar o bônus duas vezes.
create or replace function public.oz_create_product_goal_level_marker(
  p_affiliate_id uuid,
  p_level_id uuid,
  p_level_order integer,
  p_level_name text,
  p_bonus_type text,
  p_required_units integer,
  p_product_id uuid,
  p_target_id uuid,
  p_completion_id uuid,
  p_conversion_id uuid,
  p_order_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table regclass;
  v_cols text[] := array[]::text[];
  v_vals text[] := array[]::text[];
  v_sql text;
  v_id text;
  v_unknown_required text;
  v_has_id boolean := false;
  v_metadata jsonb;
begin
  v_table := public.oz_find_affiliate_level_bonus_table();
  if v_table is null then
    return null;
  end if;

  v_metadata := jsonb_build_object(
    'source', 'product_goal_level_marker',
    'product_id', p_product_id,
    'target_id', p_target_id,
    'completion_id', p_completion_id,
    'product_conversion_id', p_conversion_id,
    'required_units', p_required_units,
    'zero_value_marker', true
  );

  select exists (
    select 1 from pg_attribute
    where attrelid = v_table and attname = 'id'
      and attnum > 0 and not attisdropped
  ) into v_has_id;

  -- Não tenta inserir se existir alguma coluna obrigatória desconhecida sem default.
  select string_agg(a.attname, ', ' order by a.attnum)
    into v_unknown_required
  from pg_attribute a
  left join pg_attrdef d
    on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = v_table
    and a.attnum > 0
    and not a.attisdropped
    and a.attnotnull
    and d.oid is null
    and coalesce(a.attidentity, '') = ''
    and coalesce(a.attgenerated, '') = ''
    and a.attname not in (
      'affiliate_id','affiliate_level_id','level_id','level_order','level_name',
      'bonus_amount','amount','bonus_type','status','released_at','approved_at',
      'paid_at','completed_at','admin_notes','notes','description','source','metadata',
      'created_at','updated_at','order_id','required_conversions','goal_sales_quantity'
    );

  if v_unknown_required is not null then
    return null;
  end if;

  if exists (select 1 from pg_attribute where attrelid=v_table and attname='affiliate_id' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'affiliate_id');
    v_vals := array_append(v_vals, format('%L::uuid', p_affiliate_id));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='affiliate_level_id' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'affiliate_level_id');
    v_vals := array_append(v_vals, format('%L::uuid', p_level_id));
  elsif exists (select 1 from pg_attribute where attrelid=v_table and attname='level_id' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'level_id');
    v_vals := array_append(v_vals, format('%L::uuid', p_level_id));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='level_order' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'level_order');
    v_vals := array_append(v_vals, coalesce(p_level_order, 1)::text);
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='level_name' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'level_name');
    v_vals := array_append(v_vals, format('%L', coalesce(p_level_name, 'Nível')));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='bonus_amount' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'bonus_amount');
    v_vals := array_append(v_vals, '0');
  elsif exists (select 1 from pg_attribute where attrelid=v_table and attname='amount' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'amount');
    v_vals := array_append(v_vals, '0');
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='bonus_type' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'bonus_type');
    v_vals := array_append(v_vals, format('%L', coalesce(nullif(p_bonus_type,''), 'money')));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='status' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'status');
    v_vals := array_append(v_vals, quote_literal('paid'));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='required_conversions' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'required_conversions');
    v_vals := array_append(v_vals, greatest(coalesce(p_required_units,1),1)::text);
  elsif exists (select 1 from pg_attribute where attrelid=v_table and attname='goal_sales_quantity' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'goal_sales_quantity');
    v_vals := array_append(v_vals, greatest(coalesce(p_required_units,1),1)::text);
  end if;
  if p_order_id is not null and exists (select 1 from pg_attribute where attrelid=v_table and attname='order_id' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'order_id');
    v_vals := array_append(v_vals, format('%L::uuid', p_order_id));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='released_at' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'released_at'); v_vals := array_append(v_vals, 'now()');
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='approved_at' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'approved_at'); v_vals := array_append(v_vals, 'now()');
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='paid_at' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'paid_at'); v_vals := array_append(v_vals, 'now()');
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='completed_at' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'completed_at'); v_vals := array_append(v_vals, 'now()');
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='admin_notes' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'admin_notes');
    v_vals := array_append(v_vals, quote_literal('[PRODUCT_GOAL_MARKER] Nível concluído pelo caminho da meta específica. Bônus financeiro registrado separadamente.'));
  elsif exists (select 1 from pg_attribute where attrelid=v_table and attname='notes' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'notes');
    v_vals := array_append(v_vals, quote_literal('[PRODUCT_GOAL_MARKER] Nível concluído pelo caminho da meta específica. Bônus financeiro registrado separadamente.'));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='source' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'source'); v_vals := array_append(v_vals, quote_literal('product_goal_level_marker'));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='metadata' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'metadata'); v_vals := array_append(v_vals, format('%L::jsonb', v_metadata::text));
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='created_at' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'created_at'); v_vals := array_append(v_vals, 'now()');
  end if;
  if exists (select 1 from pg_attribute where attrelid=v_table and attname='updated_at' and attnum>0 and not attisdropped) then
    v_cols := array_append(v_cols, 'updated_at'); v_vals := array_append(v_vals, 'now()');
  end if;

  if array_length(v_cols,1) is null then return null; end if;

  v_sql := format(
    'insert into %s (%s) values (%s) on conflict do nothing%s',
    v_table,
    array_to_string(array(select quote_ident(col) from unnest(v_cols) as u(col)), ', '),
    array_to_string(v_vals, ', '),
    case when v_has_id then ' returning id::text' else '' end
  );

  if v_has_id then
    execute v_sql into v_id;
  else
    execute v_sql;
    v_id := v_table::text;
  end if;

  return v_id;
exception when others then
  raise warning 'OZONTECK product goal marker was not created: %', sqlerrm;
  return null;
end;
$$;

create or replace function public.oz_cancel_product_goal_level_marker(
  p_marker_id text,
  p_reason text default 'product_goal_reopened'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table regclass;
  v_sql text;
begin
  if nullif(trim(coalesce(p_marker_id,'')), '') is null then return false; end if;
  v_table := public.oz_find_affiliate_level_bonus_table();
  if v_table is null then return false; end if;

  if not exists (select 1 from pg_attribute where attrelid=v_table and attname='id' and attnum>0 and not attisdropped) then
    return false;
  end if;

  v_sql := format(
    'update %s set status = %L%s%s where id::text = %L',
    v_table,
    'cancelled',
    case when exists (select 1 from pg_attribute where attrelid=v_table and attname='admin_notes' and attnum>0 and not attisdropped)
      then format(', admin_notes = trim(coalesce(admin_notes, '''') || %L)', E'\n[PRODUCT_GOAL_MARKER_CANCELLED] ' || coalesce(p_reason,'')) else '' end,
    case when exists (select 1 from pg_attribute where attrelid=v_table and attname='updated_at' and attnum>0 and not attisdropped)
      then ', updated_at = now()' else '' end,
    p_marker_id
  );
  execute v_sql;
  return true;
exception when others then
  raise warning 'OZONTECK product goal marker was not cancelled: %', sqlerrm;
  return false;
end;
$$;

-- Migra conclusões específicas já liberadas antes desta correção para a trava por nível.
do $$
declare
  r record;
  v_claim_id uuid;
  v_marker_id text;
begin
  for r in
    select
      c.id as completion_id,
      c.affiliate_id,
      c.target_id,
      c.product_id,
      c.affiliate_level_id,
      c.required_units,
      c.conversion_id,
      c.status,
      c.completed_at,
      c.released_at,
      c.completion_order_id,
      l.level_order,
      l.name as level_name,
      l.bonus_type
    from public.affiliate_product_goal_completions c
    join public.affiliate_levels l on l.id = c.affiliate_level_id
    where c.status in ('released','completed_without_bonus')
    order by coalesce(c.released_at,c.completed_at,c.created_at) asc
  loop
    insert into public.affiliate_level_reward_claims (
      affiliate_id, affiliate_level_id, level_order, level_name,
      winning_path, target_id, product_id, completion_id,
      product_conversion_id, status, won_at, metadata
    ) values (
      r.affiliate_id, r.affiliate_level_id, r.level_order, r.level_name,
      'product_goal', r.target_id, r.product_id, r.completion_id,
      r.conversion_id, 'released', coalesce(r.released_at,r.completed_at,now()),
      jsonb_build_object('migrated_from_existing_completion', true)
    )
    on conflict (affiliate_id, affiliate_level_id) do nothing
    returning id into v_claim_id;

    if v_claim_id is not null then
      v_marker_id := public.oz_create_product_goal_level_marker(
        r.affiliate_id, r.affiliate_level_id, r.level_order, r.level_name,
        r.bonus_type, r.required_units, r.product_id, r.target_id,
        r.completion_id, r.conversion_id, r.completion_order_id
      );

      update public.affiliate_level_reward_claims
         set standard_bonus_id = v_marker_id,
             updated_at = now()
       where id = v_claim_id;
    end if;
  end loop;
end;
$$;

-- Wrapper seguro para a meta padrão. A API deve chamar esta função no lugar da função legada.
create or replace function public.process_affiliate_level_progress_first_wins(
  p_affiliate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level public.affiliate_levels%rowtype;
  v_goal_order integer := 1;
  v_goal_name text := null;
  v_claim public.affiliate_level_reward_claims%rowtype;
  v_legacy_result jsonb := '{}'::jsonb;
  v_bonus jsonb := null;
  v_bonus_id text := null;
begin
  if p_affiliate_id is null then
    return jsonb_build_object('success', false, 'reason', 'missing_affiliate_id');
  end if;

  select coalesce(current_level_order,1), current_level_name
    into v_goal_order, v_goal_name
  from public.affiliate_goal_overview
  where affiliate_id = p_affiliate_id
  limit 1;

  select l.* into v_level
  from public.affiliate_levels l
  where l.is_active = true
    and l.level_order >= coalesce(v_goal_order,1)
    and not exists (
      select 1
      from public.affiliate_level_reward_claims c
      where c.affiliate_id = p_affiliate_id
        and c.affiliate_level_id = l.id
        and c.status in ('processing','released','paid','review_required')
    )
  order by l.level_order asc
  limit 1;

  if v_level.id is null then
    select l.* into v_level
    from public.affiliate_levels l
    where l.is_active = true
      and not exists (
        select 1
        from public.affiliate_level_reward_claims c
        where c.affiliate_id = p_affiliate_id
          and c.affiliate_level_id = l.id
          and c.status in ('processing','released','paid','review_required')
      )
    order by l.level_order asc
    limit 1;
  end if;

  if v_level.id is null then
    return jsonb_build_object('success', true, 'reason', 'active_level_not_found');
  end if;

  select * into v_claim
  from public.affiliate_level_reward_claims
  where affiliate_id = p_affiliate_id
    and affiliate_level_id = v_level.id
    and status in ('processing','released','paid','review_required')
  limit 1;

  if v_claim.id is not null and v_claim.winning_path = 'product_goal' then
    return jsonb_build_object(
      'success', true,
      'status', 'skipped',
      'reason', 'product_goal_already_won_level',
      'affiliate_id', p_affiliate_id,
      'level_id', v_level.id,
      'level_name', v_level.name,
      'winning_path', 'product_goal'
    );
  end if;

  begin
    execute 'select to_jsonb(x) from public.process_affiliate_level_progress($1) as x limit 1'
      into v_legacy_result using p_affiliate_id;
  exception when others then
    raise;
  end;

  select to_jsonb(b)
    into v_bonus
  from public.affiliate_bonus_overview b
  where b.affiliate_id = p_affiliate_id
    and coalesce(b.level_order,0) = coalesce(v_level.level_order,0)
    and lower(coalesce(b.status,'')) not in ('cancelled','canceled','cancelado','cancelada')
    and coalesce(b.admin_notes,'') not like '[PRODUCT_GOAL_MARKER]%'
  order by coalesce(b.released_at,b.approved_at,b.created_at) asc nulls last
  limit 1;

  if v_bonus is not null then
    v_bonus_id := v_bonus->>'id';

    insert into public.affiliate_level_reward_claims (
      affiliate_id, affiliate_level_id, level_order, level_name,
      winning_path, standard_bonus_id, status, won_at, metadata
    ) values (
      p_affiliate_id, v_level.id, v_level.level_order, v_level.name,
      'standard_goal', v_bonus_id,
      case when lower(coalesce(v_bonus->>'status','')) in ('paid','pago') then 'paid' else 'released' end,
      coalesce((v_bonus->>'released_at')::timestamptz, (v_bonus->>'approved_at')::timestamptz, now()),
      jsonb_build_object('legacy_bonus', v_bonus, 'source', 'standard_goal_wrapper')
    )
    on conflict (affiliate_id, affiliate_level_id) do nothing;

    select * into v_claim
    from public.affiliate_level_reward_claims
    where affiliate_id = p_affiliate_id and affiliate_level_id = v_level.id
    limit 1;

    if v_claim.winning_path = 'product_goal' and v_bonus_id is not null
       and lower(coalesce(v_bonus->>'status','')) not in ('paid','pago') then
      begin
        execute 'select public.update_affiliate_level_bonus_status($1,$2,$3)'
          using v_bonus_id::uuid, 'cancelled',
          'Cancelado automaticamente: a meta específica do produto concluiu este nível primeiro.';
      exception when others then
        raise warning 'OZONTECK could not cancel duplicate standard bonus: %', sqlerrm;
      end;
    end if;
  end if;

  return jsonb_build_object(
    'success', true,
    'legacy_result', coalesce(v_legacy_result,'{}'::jsonb),
    'affiliate_id', p_affiliate_id,
    'level_id', v_level.id,
    'level_name', v_level.name,
    'winning_path', case when v_claim.id is not null then v_claim.winning_path else null end
  );
end;
$$;

revoke all on function public.process_affiliate_level_progress_first_wins(uuid) from public;
grant execute on function public.process_affiliate_level_progress_first_wins(uuid) to service_role;

comment on table public.affiliate_level_reward_claims is
  'Trava única por afiliado e nível. A meta padrão ou a meta específica que concluir primeiro ganha o único bônus do nível.';
comment on function public.process_affiliate_level_progress_first_wins(uuid) is
  'Executa a meta padrão somente se a meta específica ainda não venceu e registra o caminho vencedor.';
create or replace function public.process_affiliate_product_goal_bonuses(
  p_affiliate_id uuid,
  p_order_id uuid default null,
  p_source text default 'order_lifecycle'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_affiliate public.affiliates%rowtype;
  v_level public.affiliate_levels%rowtype;
  v_target record;
  v_completion public.affiliate_product_goal_completions%rowtype;
  v_units integer := 0;
  v_bonus numeric(14,2) := 0;
  v_conversion_id uuid;
  v_conversion_status text;
  v_events jsonb := '[]'::jsonb;
  v_goal_order integer := 1;
  v_goal_name text := null;
  v_created boolean := false;
  v_claim_created boolean := false;
  v_claim public.affiliate_level_reward_claims%rowtype;
  v_standard_bonus jsonb := null;
  v_marker_id text := null;
begin
  if p_affiliate_id is null then
    return jsonb_build_object('success', false, 'reason', 'missing_affiliate_id', 'events', v_events);
  end if;

  select * into v_affiliate
  from public.affiliates
  where id = p_affiliate_id
  limit 1;

  if not found then
    return jsonb_build_object('success', false, 'reason', 'affiliate_not_found', 'events', v_events);
  end if;

  select
    coalesce(current_level_order, 1),
    current_level_name
  into v_goal_order, v_goal_name
  from public.affiliate_goal_overview
  where affiliate_id = p_affiliate_id
  limit 1;

  select l.* into v_level
  from public.affiliate_levels l
  where l.is_active = true
    and l.level_order >= coalesce(v_goal_order, 1)
    and not exists (
      select 1
      from public.affiliate_level_reward_claims c
      where c.affiliate_id = p_affiliate_id
        and c.affiliate_level_id = l.id
        and c.status in ('processing','released','paid','review_required')
    )
  order by l.level_order asc
  limit 1;

  if not found then
    select l.* into v_level
    from public.affiliate_levels l
    where l.is_active = true
      and not exists (
        select 1
        from public.affiliate_level_reward_claims c
        where c.affiliate_id = p_affiliate_id
          and c.affiliate_level_id = l.id
          and c.status in ('processing','released','paid','review_required')
      )
    order by l.level_order asc
    limit 1;
  end if;

  if v_level.id is null then
    return jsonb_build_object('success', true, 'reason', 'active_level_not_found', 'events', v_events);
  end if;

  -- Se a meta padrão deste nível já gerou bônus, ela venceu e fecha a rota específica.
  select to_jsonb(b)
    into v_standard_bonus
  from public.affiliate_bonus_overview b
  where b.affiliate_id = p_affiliate_id
    and coalesce(b.level_order,0) = coalesce(v_level.level_order,0)
    and lower(coalesce(b.status,'')) not in ('cancelled','canceled','cancelado','cancelada')
    and coalesce(b.admin_notes,'') not like '[PRODUCT_GOAL_MARKER]%'
  order by coalesce(b.released_at,b.approved_at,b.created_at) asc nulls last
  limit 1;

  if v_standard_bonus is not null then
    insert into public.affiliate_level_reward_claims (
      affiliate_id, affiliate_level_id, level_order, level_name,
      winning_path, standard_bonus_id, status, won_at, metadata
    ) values (
      p_affiliate_id, v_level.id, v_level.level_order, v_level.name,
      'standard_goal', v_standard_bonus->>'id',
      case when lower(coalesce(v_standard_bonus->>'status','')) in ('paid','pago') then 'paid' else 'released' end,
      coalesce((v_standard_bonus->>'released_at')::timestamptz, (v_standard_bonus->>'approved_at')::timestamptz, v_now),
      jsonb_build_object('legacy_bonus', v_standard_bonus, 'source', p_source)
    )
    on conflict (affiliate_id, affiliate_level_id) do nothing;
  end if;

  select * into v_claim
  from public.affiliate_level_reward_claims
  where affiliate_id = p_affiliate_id
    and affiliate_level_id = v_level.id
    and status in ('processing','released','paid','review_required')
  limit 1;

  if v_claim.id is not null and v_claim.winning_path = 'standard_goal' then
    return jsonb_build_object(
      'success', true,
      'reason', 'standard_goal_already_won_level',
      'affiliate_id', p_affiliate_id,
      'current_level_id', v_level.id,
      'current_level_name', v_level.name,
      'winning_path', 'standard_goal',
      'events', jsonb_build_array(jsonb_build_object(
        'action', 'closed_by_standard',
        'affiliate_id', p_affiliate_id,
        'affiliate_level_id', v_level.id,
        'level_name', v_level.name
      ))
    );
  end if;

  -- Primeiro reconcilia conclusões existentes. Isso permite invalidar bônus ainda não pagos
  -- se um pedido for cancelado/estornado posteriormente.
  for v_completion in
    select c.*
    from public.affiliate_product_goal_completions c
    where c.affiliate_id = p_affiliate_id
  loop
    select coalesce(sum(greatest(coalesce(oi.quantity, 0)::integer, 0)), 0)::integer
      into v_units
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.affiliate_product_goal_targets t on t.id = v_completion.target_id
    where o.affiliate_id = p_affiliate_id
      and oi.product_id = v_completion.product_id
      and coalesce(o.created_at, o.delivered_at, v_now) >= t.applied_at
      and (
        o.delivered_at is not null
        or lower(coalesce(o.order_status, '')) in (
          'delivered','entregue','received','recebido','delivery_completed',
          'completed_delivery','finalizado','delivered_to_recipient',
          'entrega_realizada','objeto_entregue'
        )
      )
      and lower(coalesce(o.order_status, '')) not in (
        'cancelled','canceled','cancelado','cancelada','refunded','estornado',
        'estornada','charged_back','chargeback','rejected','failed'
      )
      and lower(coalesce(o.payment_status, '')) not in (
        'cancelled','canceled','cancelado','cancelada','refunded','estornado',
        'estornada','charged_back','chargeback','rejected','failed'
      );

    update public.affiliate_product_goal_completions
       set confirmed_units = v_units,
           updated_at = v_now,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'last_recalculated_at', v_now,
             'last_recalculated_source', p_source
           )
     where id = v_completion.id;

    if v_units < v_completion.required_units
       and v_completion.status in ('released','completed_without_bonus') then
      select lower(coalesce(status, '')) into v_conversion_status
      from public.affiliate_conversions
      where id = v_completion.conversion_id
      limit 1;

      if v_conversion_status in ('paid','pago') then
        update public.affiliate_product_goal_completions
           set status = 'review_required',
               review_required_at = v_now,
               updated_at = v_now,
               metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                 'review_reason', 'confirmed_units_below_target_after_paid_bonus',
                 'confirmed_units_after_recalculation', v_units
               )
         where id = v_completion.id;

        update public.affiliate_level_reward_claims
           set status = 'review_required', updated_at = v_now,
               metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
                 'review_reason','product_units_below_target_after_paid_bonus'
               )
         where affiliate_id = p_affiliate_id
           and completion_id = v_completion.id
           and winning_path = 'product_goal';

        v_events := v_events || jsonb_build_array(jsonb_build_object(
          'action', 'review_required',
          'completion_id', v_completion.id,
          'target_id', v_completion.target_id,
          'product_id', v_completion.product_id,
          'affiliate_id', p_affiliate_id,
          'confirmed_units', v_units,
          'required_units', v_completion.required_units,
          'bonus_amount', v_completion.bonus_amount
        ));
      else
        if v_completion.conversion_id is not null then
          update public.affiliate_conversions
             set status = 'cancelled',
                 released_at = null,
                 metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                   'cancelled_by_product_goal_recalculation', true,
                   'cancelled_at', v_now,
                   'cancelled_source', p_source,
                   'confirmed_units_after_recalculation', v_units
                 ),
                 notes = trim(coalesce(notes, '') || E'\nBônus da meta específica cancelado após recálculo das unidades válidas.')
           where id = v_completion.conversion_id;
        end if;

        select standard_bonus_id into v_marker_id
        from public.affiliate_level_reward_claims
        where affiliate_id = p_affiliate_id
          and completion_id = v_completion.id
          and winning_path = 'product_goal'
        limit 1;

        perform public.oz_cancel_product_goal_level_marker(
          v_marker_id,
          'Unidades válidas ficaram abaixo da meta específica.'
        );

        delete from public.affiliate_level_reward_claims
        where affiliate_id = p_affiliate_id
          and completion_id = v_completion.id
          and winning_path = 'product_goal'
          and status <> 'paid';

        update public.affiliate_product_goal_completions
           set status = 'cancelled',
               cancelled_at = v_now,
               released_at = null,
               updated_at = v_now
         where id = v_completion.id;

        v_events := v_events || jsonb_build_array(jsonb_build_object(
          'action', 'cancelled',
          'completion_id', v_completion.id,
          'target_id', v_completion.target_id,
          'product_id', v_completion.product_id,
          'affiliate_id', p_affiliate_id,
          'confirmed_units', v_units,
          'required_units', v_completion.required_units,
          'bonus_amount', v_completion.bonus_amount
        ));
      end if;
    end if;
  end loop;

  -- Cria/libera somente metas específicas do nível atual do afiliado.
  for v_target in
    select t.*
    from public.affiliate_product_goal_targets t
    where t.affiliate_level_id = v_level.id
      and t.is_active = true
    order by
      case when p_order_id is not null and exists (
        select 1 from public.order_items oi
        where oi.order_id = p_order_id and oi.product_id = t.product_id
      ) then 0 else 1 end,
      t.applied_at asc,
      t.id asc
  loop
    select coalesce(sum(greatest(coalesce(oi.quantity, 0)::integer, 0)), 0)::integer
      into v_units
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.affiliate_id = p_affiliate_id
      and oi.product_id = v_target.product_id
      and coalesce(o.created_at, o.delivered_at, v_now) >= v_target.applied_at
      and (
        o.delivered_at is not null
        or lower(coalesce(o.order_status, '')) in (
          'delivered','entregue','received','recebido','delivery_completed',
          'completed_delivery','finalizado','delivered_to_recipient',
          'entrega_realizada','objeto_entregue'
        )
      )
      and lower(coalesce(o.order_status, '')) not in (
        'cancelled','canceled','cancelado','cancelada','refunded','estornado',
        'estornada','charged_back','chargeback','rejected','failed'
      )
      and lower(coalesce(o.payment_status, '')) not in (
        'cancelled','canceled','cancelado','cancelada','refunded','estornado',
        'estornada','charged_back','chargeback','rejected','failed'
      );

    if v_units < v_target.required_units then
      continue;
    end if;

    -- Trava única por afiliado + nível: o primeiro caminho que concluir vence.
    v_claim_created := false;
    insert into public.affiliate_level_reward_claims (
      affiliate_id, affiliate_level_id, level_order, level_name,
      winning_path, target_id, product_id, status, won_at, metadata
    ) values (
      p_affiliate_id, v_level.id, v_level.level_order, v_level.name,
      'product_goal', v_target.id, v_target.product_id, 'processing', v_now,
      jsonb_build_object('source', p_source, 'required_units', v_target.required_units)
    )
    on conflict (affiliate_id, affiliate_level_id) do nothing
    returning * into v_claim;

    if v_claim.id is not null then
      v_claim_created := true;
    else
      select * into v_claim
      from public.affiliate_level_reward_claims
      where affiliate_id = p_affiliate_id and affiliate_level_id = v_level.id
      limit 1;
    end if;

    if not v_claim_created and v_claim.winning_path = 'standard_goal' then
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'action', 'closed_by_standard',
        'target_id', v_target.id,
        'product_id', v_target.product_id,
        'affiliate_id', p_affiliate_id,
        'affiliate_level_id', v_level.id,
        'level_name', v_level.name,
        'confirmed_units', v_units,
        'required_units', v_target.required_units
      ));
      continue;
    end if;

    if not v_claim_created
       and v_claim.winning_path = 'product_goal'
       and v_claim.target_id is distinct from v_target.id then
      continue;
    end if;

    v_bonus := case
      when lower(coalesce(v_level.bonus_type, 'fixed')) = 'manual' then 0
      else greatest(coalesce(v_level.bonus_amount, 0), 0)
    end;

    v_created := false;
    insert into public.affiliate_product_goal_completions (
      affiliate_id,
      target_id,
      product_id,
      affiliate_level_id,
      required_units,
      confirmed_units,
      bonus_amount,
      completion_order_id,
      status,
      source,
      metadata,
      completed_at,
      created_at,
      updated_at
    ) values (
      p_affiliate_id,
      v_target.id,
      v_target.product_id,
      v_target.affiliate_level_id,
      v_target.required_units,
      v_units,
      v_bonus,
      p_order_id,
      'processing',
      p_source,
      jsonb_build_object(
        'level_name', v_level.name,
        'level_order', v_level.level_order,
        'target_applied_at', v_target.applied_at,
        'reference_price', v_target.reference_price,
        'safe_contribution_per_unit', v_target.safe_contribution_per_unit,
        'source', p_source
      ),
      v_now,
      v_now,
      v_now
    )
    on conflict (affiliate_id, target_id) do nothing
    returning * into v_completion;

    if v_completion.id is not null then
      v_created := true;
    else
      select * into v_completion
      from public.affiliate_product_goal_completions
      where affiliate_id = p_affiliate_id
        and target_id = v_target.id
      limit 1;
    end if;

    if not v_created then
      update public.affiliate_product_goal_completions
         set confirmed_units = v_units,
             updated_at = v_now
       where id = v_completion.id;

      if v_completion.status in ('released','completed_without_bonus') then
        v_marker_id := public.oz_create_product_goal_level_marker(
          p_affiliate_id, v_level.id, v_level.level_order, v_level.name,
          v_level.bonus_type, v_target.required_units, v_target.product_id,
          v_target.id, v_completion.id, v_completion.conversion_id, p_order_id
        );

        update public.affiliate_level_reward_claims
           set completion_id = v_completion.id,
               product_conversion_id = v_completion.conversion_id,
               standard_bonus_id = coalesce(v_marker_id, standard_bonus_id),
               status = 'released',
               updated_at = v_now
         where id = v_claim.id;
        continue;
      end if;

      if v_completion.status = 'cancelled' and v_completion.conversion_id is not null then
        select lower(coalesce(status, '')) into v_conversion_status
        from public.affiliate_conversions
        where id = v_completion.conversion_id
        limit 1;

        if v_conversion_status not in ('paid','pago') then
          update public.affiliate_conversions
             set status = 'released',
                 approved_at = coalesce(approved_at, v_now),
                 released_at = v_now,
                 metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                   'reactivated_by_product_goal', true,
                   'reactivated_at', v_now,
                   'reactivated_source', p_source,
                   'confirmed_units_after_recalculation', v_units
                 ),
                 notes = trim(coalesce(notes, '') || E'\nBônus reativado após novas unidades entregues atingirem novamente a meta específica.')
           where id = v_completion.conversion_id;

          update public.affiliate_product_goal_completions
             set status = 'released',
                 released_at = v_now,
                 cancelled_at = null,
                 updated_at = v_now
           where id = v_completion.id;

          v_marker_id := public.oz_create_product_goal_level_marker(
            p_affiliate_id, v_level.id, v_level.level_order, v_level.name,
            v_level.bonus_type, v_target.required_units, v_target.product_id,
            v_target.id, v_completion.id, v_completion.conversion_id, p_order_id
          );

          update public.affiliate_level_reward_claims
             set completion_id = v_completion.id,
                 product_conversion_id = v_completion.conversion_id,
                 standard_bonus_id = coalesce(v_marker_id, standard_bonus_id),
                 status = 'released', updated_at = v_now
           where id = v_claim.id;

          v_events := v_events || jsonb_build_array(jsonb_build_object(
            'action', 'released',
            'reactivated', true,
            'completion_id', v_completion.id,
            'conversion_id', v_completion.conversion_id,
            'target_id', v_target.id,
            'product_id', v_target.product_id,
            'affiliate_id', p_affiliate_id,
            'confirmed_units', v_units,
            'required_units', v_target.required_units,
            'level_name', v_level.name,
            'bonus_amount', v_completion.bonus_amount
          ));
        end if;
      end if;

      continue;
    end if;

    if v_bonus <= 0 then
      update public.affiliate_product_goal_completions
         set status = 'completed_without_bonus',
             released_at = null,
             updated_at = v_now
       where id = v_completion.id;

      v_marker_id := public.oz_create_product_goal_level_marker(
        p_affiliate_id, v_level.id, v_level.level_order, v_level.name,
        v_level.bonus_type, v_target.required_units, v_target.product_id,
        v_target.id, v_completion.id, null, p_order_id
      );

      update public.affiliate_level_reward_claims
         set completion_id = v_completion.id,
             standard_bonus_id = v_marker_id,
             status = 'released', updated_at = v_now
       where id = v_claim.id;

      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'action', 'completed_without_bonus',
        'completion_id', v_completion.id,
        'target_id', v_target.id,
        'product_id', v_target.product_id,
        'affiliate_id', p_affiliate_id,
        'confirmed_units', v_units,
        'required_units', v_target.required_units,
        'level_name', v_level.name,
        'bonus_amount', 0
      ));
      continue;
    end if;

    insert into public.affiliate_conversions (
      affiliate_id,
      order_id,
      customer_id,
      ref_code,
      coupon_code,
      order_total,
      commission_rate,
      commission_amount,
      conversion_type,
      status,
      approved_at,
      released_at,
      metadata,
      notes
    ) values (
      p_affiliate_id,
      p_order_id,
      null,
      coalesce(v_affiliate.ref_code, ''),
      coalesce(v_affiliate.coupon_code, ''),
      0,
      0,
      v_bonus,
      'product_goal_bonus',
      'released',
      v_now,
      v_now,
      jsonb_build_object(
        'source', 'affiliate_product_goal_bonus',
        'lifecycle_source', p_source,
        'completion_id', v_completion.id,
        'target_id', v_target.id,
        'product_id', v_target.product_id,
        'affiliate_level_id', v_level.id,
        'level_name', v_level.name,
        'level_order', v_level.level_order,
        'required_units', v_target.required_units,
        'confirmed_units', v_units,
        'bonus_amount', v_bonus,
        'release_policy', 'after_delivered_units',
        'released_by_product_goal', true
      ),
      format(
        'Bônus de %s liberado automaticamente após atingir %s unidades entregues da meta específica do produto.',
        to_char(v_bonus, 'FM999999990D00'),
        v_target.required_units
      )
    )
    returning id into v_conversion_id;

    update public.affiliate_product_goal_completions
       set conversion_id = v_conversion_id,
           status = 'released',
           released_at = v_now,
           updated_at = v_now,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'conversion_id', v_conversion_id,
             'released_at', v_now,
             'winning_path', 'product_goal',
             'other_path_closed', true
           )
     where id = v_completion.id;

    v_marker_id := public.oz_create_product_goal_level_marker(
      p_affiliate_id, v_level.id, v_level.level_order, v_level.name,
      v_level.bonus_type, v_target.required_units, v_target.product_id,
      v_target.id, v_completion.id, v_conversion_id, p_order_id
    );

    update public.affiliate_level_reward_claims
       set completion_id = v_completion.id,
           product_conversion_id = v_conversion_id,
           standard_bonus_id = v_marker_id,
           status = 'released',
           updated_at = v_now,
           metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'released_at', v_now,
             'other_path_closed', true,
             'level_advanced_by_marker', v_marker_id is not null
           )
     where id = v_claim.id;

    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'action', 'released',
      'completion_id', v_completion.id,
      'conversion_id', v_conversion_id,
      'target_id', v_target.id,
      'product_id', v_target.product_id,
      'affiliate_id', p_affiliate_id,
      'confirmed_units', v_units,
      'required_units', v_target.required_units,
      'level_name', v_level.name,
      'bonus_amount', v_bonus,
      'winning_path', 'product_goal',
      'other_path_closed', true,
      'level_advanced', v_marker_id is not null
    ));
  end loop;

  return jsonb_build_object(
    'success', true,
    'affiliate_id', p_affiliate_id,
    'current_level_id', v_level.id,
    'current_level_name', v_level.name,
    'winning_path', case when exists (select 1 from public.affiliate_level_reward_claims c where c.affiliate_id=p_affiliate_id and c.affiliate_level_id=v_level.id) then (select c.winning_path from public.affiliate_level_reward_claims c where c.affiliate_id=p_affiliate_id and c.affiliate_level_id=v_level.id limit 1) else null end,
    'events', v_events
  );
end;
$$;

revoke all on function public.process_affiliate_product_goal_bonuses(uuid, uuid, text) from public;
grant execute on function public.process_affiliate_product_goal_bonuses(uuid, uuid, text) to service_role;

comment on function public.process_affiliate_product_goal_bonuses(uuid, uuid, text) is
  'Libera a meta específica somente se ela vencer primeiro. Registra uma trava única por afiliado e nível e fecha a meta padrão do mesmo nível.';
