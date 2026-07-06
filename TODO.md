# TODO - RBAC profissional (backend + frontend + testes)

## Backend
- [x] Criar base RBAC (`permissions_catalog`, `admin_permissions`, `admins.is_master`) em `src/sql/20260706_rbac_permissions.sql`.
- [x] Criar repositório/serviço/cache/middleware de permissões.
- [x] Criar e registrar rotas administrativas de permissões.
- [x] Integrar aprovação de acesso admin com `is_master` + `permissions[]` em `adminAccessRequests.routes.js`.
- [ ] Substituir `requireMasterAdmin` por `requirePermission(...)` em rotas administrativas críticas.
- [ ] Garantir mapeamento consistente de permissões por módulo/ação.

## Frontend (ozonteck-admin)
- [ ] Modal profissional de permissões na aprovação de admin.
- [ ] Tela/fluxo de edição posterior de permissões de administradores.
- [ ] Ocultação de menus/ações por permissão (backend continua source of truth).
- [ ] Tratamento UX para 403 (mensagem clara de falta de permissão).

## Testes (thorough)
- [x] Validar proteção sem token (401) em endpoint de permissões.
- [x] Validar 403 com token sem permissão em `/api/admin/permissions/catalog`.
- [x] Validar IA com token válido em `/api/admin/ai/chat` (200 + orchestrator).
- [ ] Validar todas as rotas admin críticas (401/403/200 conforme cenário).
- [ ] Validar fluxo completo approve com `is_master=true`.
- [ ] Validar fluxo approve com `permissions[]`.
- [ ] Validar rejeição de permissões inválidas.
- [ ] Relatório final de homologação para produção.
