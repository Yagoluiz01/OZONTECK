// src/controllers/report.controller.js

import ExcelJS from "exceljs";

export async function generateProductsReport(req, res) {
  try {
    const workbook = new ExcelJS.Workbook();

    const worksheet = workbook.addWorksheet("Produtos");

    worksheet.columns = [
      { header: "ID", key: "id", width: 40 },
      { header: "Nome", key: "name", width: 40 },
      { header: "Status", key: "status", width: 15 },
      { header: "Estoque", key: "stock", width: 15 },
    ];

    worksheet.addRow({
      id: "teste-1",
      name: "Produto Teste",
      status: "active",
      stock: 10,
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="relatorio-produtos.xlsx"'
    );

    await workbook.xlsx.write(res);

    res.end();
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Erro ao gerar relatório",
    });
  }
}