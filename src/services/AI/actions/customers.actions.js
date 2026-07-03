export const customersActions = {
  getCustomersSummary: async ({ knowledge }) => {
    const data = knowledge.customers?.summary ?? {};

    return {
      total: data.total ?? 0,
      active: data.active ?? 0,
      inactive: data.inactive ?? 0,
      newCustomers: data.newCustomers ?? 0,
    };
  },

  analyzeCustomers: async ({ knowledge }) => {
    const data = knowledge.customers?.summary ?? {};

    return {
      total: data.total ?? 0,
      active: data.active ?? 0,
      inactive: data.inactive ?? 0,
      recommendation:
        "Trabalhar reativação de clientes inativos e fidelização dos ativos.",
    };
  },

  topCustomers: async ({ knowledge }) => {
    return knowledge.customers?.list ?? [];
  },
};