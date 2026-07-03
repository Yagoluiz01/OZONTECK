import { reportsActions } from "../actions/reports.actions.js";

export async function generateReportsAction({ message, format = "excel" }) {
  // por enquanto: apenas suporte ao report de produtos (LEVRA PERFUME)
  // com max cuidado, só retornamos dados prontos e URLs do sistema.

  const lower = String(message || "").toLowerCase();

  const isProducts = lower.includes("produto") || lower.includes("produtos") || lower.includes("estoque");
  if (!isProducts) {
    return {
      success: false,
      error: true,
      message: "Somente relatório de produtos está habilitado nesta fase.",
    };
  }

  const fmt = String(format || "excel").toLowerCase();

  if (fmt === "pdf") {
    return {
      success: true,
      reportType: "products",
      format: "pdf",
      downloadUrl: "/api/reports/products/pdf",
    };
  }

  return {
    success: true,
    reportType: "products",
    format: "excel",
    downloadUrl: "/api/reports/products/excel",
  };
}

