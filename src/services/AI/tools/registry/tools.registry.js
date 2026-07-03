import { generateProductsReportTool } from "../reports/products.tool.js";

export const aiTools = {

  generateProductsReport: {

    description:
      "Gerar relatório de produtos.",

    keywords: [
      "relatório",
      "excel",
      "pdf",
      "produto",
      "produtos",
      "exportar"
    ],

    execute: generateProductsReportTool

  }

};