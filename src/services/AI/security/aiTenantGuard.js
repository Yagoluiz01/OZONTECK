// Tenant Guard
// Compatível com a arquitetura atual do OZONTECK.
// Hoje o sistema é single-tenant.
// Se no futuro houver company_id/tenant_id, ele utilizará automaticamente.

export function enforceTenantGuard({ req, user } = {}) {
  // Single-tenant (atual): apenas exige administrador autenticado.
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
