export const affiliatesActions = {
  getAffiliatesSummary: async ({ knowledge }) => {
    const data = knowledge.affiliates?.summary ?? {};

    return {
      total: data.total ?? 0,
      active: data.active ?? 0,
      inactive: data.inactive ?? 0,
      topAffiliates: data.topAffiliates ?? [],
    };
  },

  analyzeAffiliates: async ({ knowledge }) => {
    const data = knowledge.affiliates?.summary ?? {};

    return {
      total: data.total ?? 0,
      active: data.active ?? 0,
      recommendation:
        "Incentivar afiliados ativos com campanhas e bonificações.",
    };
  },

  rankingAffiliates: async ({ knowledge }) => {
    return knowledge.affiliates?.topAffiliates ?? [];
  },
};