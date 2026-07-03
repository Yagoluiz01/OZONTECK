import { affiliatesRepository } from "../repositories/affiliates.repository.js";

export async function loadAffiliatesContext() {
  const affiliates = await affiliatesRepository.getAll();

  const active = affiliates.filter(a => a.status === "active");
  const inactive = affiliates.filter(a => a.status === "inactive");

  const topAffiliates = affiliates
    .sort((a, b) => (b.sales || 0) - (a.sales || 0))
    .slice(0, 10);

  return {
    summary: {
      total: affiliates.length,
      active: active.length,
      inactive: inactive.length,
      topAffiliates: topAffiliates.length,
    },

    list: affiliates,
    active,
    inactive,
    topAffiliates,
  };
}