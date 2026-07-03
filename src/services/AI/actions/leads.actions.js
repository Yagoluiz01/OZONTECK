export const leadsActions = {
  getLeadsSummary: async ({ knowledge }) => {
    const data = knowledge.leads?.summary ?? {};

    return {
      total: data.total ?? 0,
      qualified: data.qualified ?? 0,
      converted: data.converted ?? 0,
    };
  },

  analyzeLeads: async ({ knowledge }) => {
    const data = knowledge.leads?.summary ?? {};

    return {
      total: data.total ?? 0,
      qualified: data.qualified ?? 0,
      converted: data.converted ?? 0,
      recommendation: "Priorizar leads qualificados para aumentar conversão.",
    };
  },

  conversionRate: async ({ knowledge }) => {
    const data = knowledge.leads?.summary ?? {};

    const total = data.total ?? 0;
    const converted = data.converted ?? 0;

    return {
      rate: total === 0 ? 0 : ((converted / total) * 100).toFixed(2),
    };
  },
};