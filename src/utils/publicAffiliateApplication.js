const SAFE_APPLICATION_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
]);

export function toPublicAffiliateApplication(application = {}) {
  const status = String(application?.status || "pending").trim().toLowerCase();

  return {
    id: application?.id || null,
    status: SAFE_APPLICATION_STATUSES.has(status) ? status : "pending",
    created_at: application?.created_at || null,
  };
}
