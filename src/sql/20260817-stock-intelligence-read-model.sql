-- Read model de histórico pago para o módulo Estoque Inteligente.
-- Aplicado em 2026-08-17 no projeto Sistema-ozonteck.
-- Mantém a autorização no backend: somente service_role pode executar.

create or replace function public.get_admin_stock_sales_history(p_history_start timestamptz)
returns table (
  product_id uuid,
  quantity integer,
  unit_price numeric,
  sold_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    oi.product_id,
    oi.quantity,
    oi.unit_price,
    coalesce(o.paid_at, o.created_at, oi.created_at) as sold_at
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.product_id is not null
    and lower(coalesce(o.payment_status, '')) in ('paid','approved','pago','aprovado')
    and coalesce(o.paid_at, o.created_at) >= p_history_start
  order by coalesce(o.paid_at, o.created_at, oi.created_at) desc;
$$;

revoke all on function public.get_admin_stock_sales_history(timestamptz) from public;
revoke all on function public.get_admin_stock_sales_history(timestamptz) from anon;
revoke all on function public.get_admin_stock_sales_history(timestamptz) from authenticated;
grant execute on function public.get_admin_stock_sales_history(timestamptz) to service_role;
