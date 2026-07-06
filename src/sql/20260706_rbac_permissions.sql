-- RBAC definitivo (permissions_catalog + admin_permissions + is_master)
-- Compatível com arquitetura atual (single-tenant)
-- Não remove nem quebra roles existentes; permissões complementam o modelo atual.

begin;

alter table if exists public.admins
  add column if not exists is_master boolean not null default false;

create table if not exists public.permissions_catalog (
  key text primary key,
  label text not null,
  module text not null,
  description text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_permissions (
  admin_id uuid not null,
  permission_key text not null,
  created_at timestamptz not null default now(),
  primary key (admin_id, permission_key),
  constraint fk_admin_permissions_admin
    foreign key (admin_id)
    references public.admins(id)
    on delete cascade,
  constraint fk_admin_permissions_permission
    foreign key (permission_key)
    references public.permissions_catalog(key)
    on delete cascade
);

create index if not exists idx_permissions_catalog_module
  on public.permissions_catalog(module);

create index if not exists idx_admin_permissions_admin_id
  on public.admin_permissions(admin_id);

create index if not exists idx_admin_permissions_permission_key
  on public.admin_permissions(permission_key);

insert into public.permissions_catalog (key, label, module, description, is_active)
values
  ('dashboard.view', 'Visualizar Dashboard', 'dashboard', 'Permite visualizar métricas e cards do dashboard.', true),

  ('orders.view', 'Visualizar pedidos', 'orders', 'Permite listar e visualizar pedidos.', true),
  ('orders.edit', 'Editar pedidos', 'orders', 'Permite alterar dados de pedidos.', true),
  ('orders.delete', 'Excluir pedidos', 'orders', 'Permite remover pedidos.', true),
  ('orders.status', 'Alterar status de pedidos', 'orders', 'Permite alterar status operacional dos pedidos.', true),

  ('products.view', 'Visualizar produtos', 'products', 'Permite listar e visualizar produtos.', true),
  ('products.create', 'Criar produtos', 'products', 'Permite criar novos produtos.', true),
  ('products.edit', 'Editar produtos', 'products', 'Permite editar produtos existentes.', true),
  ('products.delete', 'Excluir produtos', 'products', 'Permite excluir produtos.', true),
  ('products.pricing', 'Alterar preços', 'products', 'Permite alterar preço e regras de preço.', true),

  ('customers.view', 'Visualizar clientes', 'customers', 'Permite listar e visualizar clientes.', true),
  ('customers.edit', 'Editar clientes', 'customers', 'Permite editar dados de clientes.', true),
  ('customers.delete', 'Excluir clientes', 'customers', 'Permite excluir clientes.', true),

  ('financial.view', 'Financeiro (visualizar)', 'financial', 'Permite visualizar módulo financeiro.', true),
  ('financial.payables', 'Contas a pagar', 'financial', 'Permite gerenciar contas a pagar.', true),
  ('financial.receivables', 'Contas a receber', 'financial', 'Permite gerenciar contas a receber.', true),
  ('financial.fiscal', 'Fiscal', 'financial', 'Permite acessar recursos fiscais.', true),
  ('financial.billing', 'Faturamento', 'financial', 'Permite acessar faturamento.', true),
  ('financial.edit', 'Financeiro (editar)', 'financial', 'Permite operações de edição financeira.', true),

  ('pricing.view', 'Precificação (visualizar)', 'pricing', 'Permite visualizar módulo de precificação.', true),
  ('pricing.edit', 'Precificação (editar)', 'pricing', 'Permite alterar dados de precificação.', true),

  ('notifications.view', 'Notificações (visualizar)', 'notifications', 'Permite visualizar notificações administrativas.', true),
  ('notifications.edit', 'Notificações (editar)', 'notifications', 'Permite ações administrativas em notificações.', true),

  ('audit.view', 'Auditoria (visualizar)', 'audit', 'Permite visualizar logs de auditoria.', true),
  ('audit.export', 'Auditoria (exportar)', 'audit', 'Permite exportar dados de auditoria.', true),

  ('ai.use', 'Utilizar IA', 'ai', 'Permite uso do assistente IA.', true),
  ('ai.config', 'Configurar IA', 'ai', 'Permite alterar configurações da IA.', true),
  ('ai.history', 'Visualizar histórico IA', 'ai', 'Permite visualizar histórico da IA.', true),

  ('admins.view', 'Visualizar administradores', 'admins', 'Permite listar administradores.', true),
  ('admins.create', 'Criar administradores', 'admins', 'Permite criar administradores.', true),
  ('admins.edit', 'Editar administradores', 'admins', 'Permite editar administradores.', true),
  ('admins.delete', 'Excluir administradores', 'admins', 'Permite excluir administradores.', true),
  ('admins.approve_requests', 'Aprovar solicitações', 'admins', 'Permite aprovar/reprovar solicitações de acesso.', true),
  ('admins.permissions', 'Gerenciar permissões', 'admins', 'Permite alterar permissões administrativas.', true),

  ('settings.view', 'Configurações (visualizar)', 'settings', 'Permite visualizar configurações.', true),
  ('settings.edit', 'Configurações (editar)', 'settings', 'Permite editar configurações.', true),

  ('reports.view', 'Relatórios (visualizar)', 'reports', 'Permite visualizar relatórios.', true),
  ('reports.export', 'Relatórios (exportar)', 'reports', 'Permite exportar relatórios.', true),

  ('uploads.manage', 'Gerenciar uploads', 'uploads', 'Permite upload/remoção de arquivos administrativos.', true)
on conflict (key) do update
set
  label = excluded.label,
  module = excluded.module,
  description = excluded.description,
  is_active = excluded.is_active,
  updated_at = now();

update public.admins
set is_master = true
where lower(coalesce(role, '')) in ('master', 'owner', 'super_admin', 'superadmin');

commit;
