export const actionsRegistry = {
  getProductsSummary: {
    name: "getProductsSummary",
    intents: [
      "produto",
      "produtos",
      "catálogo",
    ],
  },

  analyzeStock: {
    name: "analyzeStock",
    intents: [
      "estoque",
      "sem estoque",
      "estoque baixo",
    ],
  },

  recommendRestock: {
    name: "recommendRestock",
    intents: [
      "reposição",
      "repor",
      "comprar estoque",
    ],
  },
};