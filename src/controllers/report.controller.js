import ExcelJS from "exceljs";
import { env } from "../config/env.js";

async function fetchProducts() {
  const response = await fetch(
    `${env.supabaseUrl}/rest/v1/products?select=id,name,status,stock_quantity`,
    {
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error("Erro ao buscar produtos");
  }

  return response.json();
}

export async function generateProductsReport(req, res) {
  try {
    const products = await fetchProducts();

    const workbook = new ExcelJS.Workbook();

    workbook.creator = "OZONTECK";
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet("Produtos");

    worksheet.columns = [
      { header: "ID", key: "id", width: 40 },
      { header: "Produto", key: "name", width: 40 },
      { header: "Status", key: "status", width: 15 },
      { header: "Estoque", key: "stock_quantity", width: 15 },
    ];

    worksheet.getRow(1).font = {
      bold: true,
      size: 12,
    };

    products.forEach((product) => {
      worksheet.addRow({
        id: product.id,
        name: product.name,
        status: product.status,
        stock_quantity: product.stock_quantity,
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=produtos-${Date.now()}.xlsx`
    );

    await workbook.xlsx.write(res);

    res.end();
  } catch (error) {
    console.error("[REPORT_ERROR]", error);

    return res.status(500).json({
      success: false,
      message: "Erro ao gerar relatório.",
    });
  }
}