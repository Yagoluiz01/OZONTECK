// Tenant Guard
// Compatível com a arquitetura atual do OZONTECK.
// Hoje o sistema é single-tenant.
// Se no futuro houver company_id/tenant_id, ele utilizará automaticamente.

function normalizeId(value) {
  if (value === undefined || value === null) return null;

  const id = String(value).trim();

  return id.length ? id : null;
}

export function enforceTenantGuard({ req, user, company } = {}) {
  // Se existir company/tenant utiliza normalmente.
  const tenantId =
    normalizeId(company) ||
    normalizeId(user?.company_id) ||
    normalizeId(user?.tenant_id) ||
    normalizeId(user?.companyId) ||
    normalizeId(user?.tenantId);

  // Multi-tenant (futuro)
  if (tenantId) {
    req.tenant = tenantId;

    return {
      ok: true,
      tenantId,
      mode: "multi-tenant",
    };
  }

  // Single-tenant (atual)
  // Apenas exige administrador autenticado.
  if (user?.id) {
    req.tenant = "default";

    return {
      ok: true,
      tenantId: "default",
      mode: "single-tenant",
    };
  }

  // Sem autenticação
  return {
    ok: false,
    reason: "unauthenticated",
    metadata: {
      security: "tenant_guard",
      required: true,
    },
  };
}