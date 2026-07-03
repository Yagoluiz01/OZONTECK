export const modulesRegistry = {
  products: {
    name: "Produtos",
    contexts: ["products"],
    intents: [
      "produto",
      "produtos",
      "estoque",
      "catálogo",
      "reposição",
    ],
  },

  financial: {
    name: "Financeiro",
    contexts: ["financial"],
    intents: [
      "financeiro",
      "lucro",
      "receita",
      "despesa",
      "faturamento",
      "caixa",
    ],
  },

  orders: {
    name: "Pedidos",
    contexts: ["orders"],
    intents: [
      "pedido",
      "pedidos",
      "compra",
    ],
  },

  customers: {
    name: "Clientes",
    contexts: ["customers"],
    intents: [
      "cliente",
      "clientes",
    ],
  },

  affiliates: {
    name: "Afiliados",
    contexts: ["affiliates"],
    intents: [
      "afiliado",
      "afiliados",
      "comissão",
      "comissões",
      "meta",
      "bônus",
    ],
  },

  leads: {
    name: "Leads",
    contexts: ["leads"],
    intents: [
      "lead",
      "leads",
      "campanha",
      "landing page",
      "conversão",
    ],
  },

  dashboard: {
    name: "Dashboard",
    contexts: ["dashboard"],
    intents: [
      "dashboard",
      "indicadores",
      "gráficos",
      "performance",
    ],
  },

  reports: {
    name: "Relatórios",
    contexts: ["reports"],
    intents: [
      "relatório",
      "excel",
      "pdf",
      "exportar",
    ],
  },
};