-- OZONTECK | Permissão de exclusão controlada do histórico
-- Execute uma única vez no SQL Editor do Supabase.
-- A rota de exclusão permanece protegida pela autenticação e pela regra master da API.

grant delete on table public.admin_audit_logs to service_role;

comment on table public.admin_audit_logs is
  'Registro das ações administrativas críticas da OZONTECK, com exclusão controlada pelo administrador master.';
