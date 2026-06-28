import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
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

const activeProducts = products.filter(
  (p) => p.status === "active"
);

const inactiveProducts = products.filter(
  (p) => p.status === "inactive"
);

const draftProducts = products.filter(
  (p) => p.status === "draft"
);

const lowStockProducts = products.filter((p) => {
  const stock = Number(p.stock_quantity || 0);
  return stock > 0 && stock <= 5;
});

const outOfStockProducts = products.filter((p) => {
  return Number(p.stock_quantity || 0) === 0;
});


const reportDate = new Date().toLocaleString("pt-BR");




    console.log("================================");
    console.log("TOTAL PRODUTOS:", products.length);
    console.log("PRIMEIRO PRODUTO:", products[0]);
    console.log("================================");

    const workbook = new ExcelJS.Workbook();

    workbook.creator = "LEVRA PERFUME";
    workbook.company = "LEVRA PERFUME";
    
    
   
    const worksheet = workbook.addWorksheet("Produtos");

    worksheet.mergeCells("A1:D1");
worksheet.getCell("A1").value = "LEVRA PERFUME";
worksheet.getCell("A1").font = {
  bold: true,
  size: 20,
  color: { argb: "FFFFFFFF" },
};

worksheet.getCell("A1").fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF0F172A" },
};

worksheet.getCell("A1").alignment = {
  horizontal: "center",
  vertical: "middle",
};

worksheet.getRow(1).height = 30;


worksheet.mergeCells("A2:D2");

worksheet.getCell("A2").value =
  "Relatório Geral de Produtos";

worksheet.getCell("A2").font = {
  bold: true,
  size: 13,
};

worksheet.getCell("A2").alignment = {
  horizontal: "center",
};
    
    

   worksheet.mergeCells("A6:B6");

worksheet.getCell("A6").value =
  "RESUMO EXECUTIVO";


  for (let i = 7; i <= 12; i++) {
  worksheet.getCell(`B${i}`).font = {
    bold: true,
    size: 12,
  };
}

worksheet.getCell("A6").font = {
  bold: true,
  size: 14,
  color: { argb: "FFFFFFFF" },
};

worksheet.getCell("A6").fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF2563EB" },
};

worksheet.getCell("A6").alignment = {
  horizontal: "center",
};

worksheet.getCell("A7").value = "Total de Produtos";
worksheet.getCell("B7").value = products.length;

worksheet.getCell("A8").value = "Produtos Ativos";
worksheet.getCell("B8").value = activeProducts.length;

worksheet.getCell("A9").value = "Produtos Inativos";
worksheet.getCell("B9").value = inactiveProducts.length;

worksheet.getCell("A10").value = "Produtos Draft";
worksheet.getCell("B10").value = draftProducts.length;

worksheet.getCell("A11").value = "Estoque Baixo";
worksheet.getCell("B11").value = lowStockProducts.length;

worksheet.getCell("A12").value = "Sem Estoque";
worksheet.getCell("B12").value = outOfStockProducts.length;


worksheet.getCell("A3").value =
  `Gerado em: ${reportDate}`;


  worksheet.getCell("A3").font = {
  italic: true,
  size: 10,
};


   worksheet.views = [
  {
    state: "frozen",
    ySplit: 14,
  },
];

    worksheet.columns = [
  { header: "ID", key: "id", width: 40 },
  { header: "Produto", key: "name", width: 45 },
  { header: "Status", key: "status", width: 15 },
  { header: "Estoque", key: "stock_quantity", width: 15 },
];

worksheet.getRow(14).values = [
  "ID",
  "Produto",
  "Status",
  "Estoque",
];

    const headerRow = worksheet.getRow(14);

    headerRow.font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
      size: 12,
    };

    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F2937" },
    };

    headerRow.alignment = {
      vertical: "middle",
      horizontal: "center",
    };

    headerRow.height = 25;

    
console.log("================================");
console.log("TOTAL PRODUTOS:", products.length);
console.log("PRIMEIRO PRODUTO:", products[0]);
console.log("================================");



products.forEach((product) => {
  const row = worksheet.addRow({
    id: product.id,
    name: product.name,
    status: product.status,
    stock_quantity: product.stock_quantity ?? 0,
  });

  row.getCell(3).alignment = {
    horizontal: "center",
  };

  row.getCell(4).alignment = {
    horizontal: "center",
  };
});
    worksheet.autoFilter = {
  from: "A14",
  to: "D14",
};

    
   worksheet.eachRow((row) => {
  row.alignment = {
    vertical: "middle",
  };

  row.eachCell((cell) => {
    cell.border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
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



export async function generateProductsPdf(req, res) {
  try {
    
    const products = await fetchProducts();

    const activeProducts = products.filter(
  (p) => p.status === "active"
);

const inactiveProducts = products.filter(
  (p) => p.status === "inactive"
);

const draftProducts = products.filter(
  (p) => p.status === "draft"
);

const lowStockProducts = products.filter((p) => {
  const stock = Number(p.stock_quantity || 0);
  return stock > 0 && stock <= 5;
});

const outOfStockProducts = products.filter((p) => {
  return Number(p.stock_quantity || 0) === 0;
});

const reportDate = new Date().toLocaleString("pt-BR");

    console.log("================================");
    console.log("TOTAL PRODUTOS:", products.length);
    console.log("PRIMEIRO PRODUTO:", products[0]);
    console.log("================================");

    const doc = new PDFDocument({
      margin: 40,
      size: "A4",
    });

    res.setHeader(
      "Content-Type",
      "application/pdf"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=produtos-${Date.now()}.pdf`
    );

    doc.pipe(res);

    doc.fontSize(22)
   .fillColor("#1E3A8A")
   .text("LEVRA PERFUME", {
     align: "center",
   });

doc.moveDown(0.5);

doc.fontSize(16)
   .fillColor("black")
   .text("Relatório Geral de Produtos", {
     align: "center",
   });

doc.moveDown(0.5);

doc.fontSize(10)
   .fillColor("gray")
   .text(`Gerado em: ${reportDate}`, {
     align: "center",
   });

doc.moveDown(2);

doc.fontSize(12).fillColor("black");

doc.roundedRect(40, 140, 220, 110, 6).stroke();

doc.font("Helvetica-Bold")
   .text("RESUMO EXECUTIVO", 50, 150);

doc.font("Helvetica")
   .text(`Total de Produtos: ${products.length}`, 50, 170)
   .text(`Produtos Ativos: ${activeProducts.length}`, 50, 188)
   .text(`Produtos Inativos: ${inactiveProducts.length}`, 50, 206)
   .text(`Sem Estoque: ${outOfStockProducts.length}`, 50, 224);

doc.moveDown(6);

    products.forEach((product, index) => {
  doc.font("Helvetica-Bold")
     .text(`${index + 1}. ${product.name}`);

  doc.font("Helvetica")
     .text(`Status: ${product.status}`);

  doc.text(`Estoque: ${product.stock_quantity ?? 0}`);

  doc.moveDown(0.6);
});

    doc.end();
  } catch (error) {
    console.error("[PDF_REPORT_ERROR]", error);

    return res.status(500).json({
      success: false,
      message: "Erro ao gerar PDF.",
    });
  }
}