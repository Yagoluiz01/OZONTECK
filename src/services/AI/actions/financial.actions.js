export const financialActions = {
  getFinancialSummary: async ({ knowledge }) => {
    const data = knowledge.financial?.summary ?? {};

    return {
      revenue: data.revenue ?? 0,
      expenses: data.expenses ?? 0,
      balance: data.balance ?? 0,
      accountsReceivable: data.accountsReceivable ?? 0,
      accountsPayable: data.accountsPayable ?? 0,
    };
  },

  analyzeFinancial: async ({ knowledge }) => {
    const data = knowledge.financial?.summary ?? {};

    return {
      revenue: data.revenue ?? 0,
      expenses: data.expenses ?? 0,
      profit: (data.revenue ?? 0) - (data.expenses ?? 0),
      recommendation: "Controlar despesas e acompanhar fluxo de caixa.",
    };
  },

  cashFlowAnalysis: async ({ knowledge }) => {
    const data = knowledge.financial?.summary ?? {};

    return {
      balance: (data.revenue ?? 0) - (data.expenses ?? 0),
    };
  },
};