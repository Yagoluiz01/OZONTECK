// Tenant Guard (hardening)
// Mantém a arquitetura existente e só adiciona validações defensivas.
// Objetivo: reduzir risco de leitura/escrita cruzada entre empresas quando
// o tenant (companyId) não estiver explícito.

function normalizeId(v) {
  const s = v === undefined || v === null ? null : String(v).trim();
  return s && s.length ? s : null;
}

function hasTenant({ user, company } = {}) {
  // Preferência: company explícito vindo do contexto/auth.
  const companyId = normalizeId(company);
  const userCompany = normalizeId(user?.company_id || user?.tenant_id || user?.companyId || user?.tenantId);
  return companyId || userCompany;
}

export function enforceTenantGuard({ req, user, company } = {}) {
  // Se o sistema atual não informa tenant, bloqueamos para evitar risco de cross-tenant.
  // Isso é intencionalmente mais restritivo (security-first).
  const tenantId = hasTenant({ user, company });

  if (!tenantId) {
    return {
      ok: false,
      reason: "missing_tenant",
      metadata: {
        security: "tenant_guard",
        required: true,
      },
    };
  }

  // Insere no req para downstream providers/repositories usarem (se existir suporte).
  req.tenant = tenantId;

  return {
    ok: true,
    tenantId,
  };
}

