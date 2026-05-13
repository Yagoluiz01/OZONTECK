import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { env } from "../config/env.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

async function getUserFromToken(token) {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: env.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function findAdminByEmail(email) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/get_admin_by_email`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_email: email,
    }),
  });

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token não enviado",
      });
    }

    const appToken = authHeader.split(" ")[1];
    const decoded = jwt.verify(appToken, env.jwtSecret);

    if (!decoded.supabase_access_token) {
      return res.status(401).json({
        success: false,
        message: "Sessão inválida",
      });
    }

    const userResponse = await getUserFromToken(decoded.supabase_access_token);

    if (!userResponse.ok || !userResponse.data?.email) {
      return res.status(401).json({
        success: false,
        message: "Sessão expirada ou inválida",
      });
    }

    const normalizedEmail = String(userResponse.data.email).trim().toLowerCase();
    const adminResponse = await findAdminByEmail(normalizedEmail);

    const admin = Array.isArray(adminResponse.data)
      ? adminResponse.data[0]
      : adminResponse.data;

    if (!adminResponse.ok || !admin) {
      return res.status(403).json({
        success: false,
        message: "Usuário sem acesso ao painel",
      });
    }

    if (!admin.is_active) {
      return res.status(403).json({
        success: false,
        message: "Usuário inativo",
      });
    }

    req.auth = {
      admin,
      appToken,
      supabaseAccessToken: decoded.supabase_access_token,
    };

    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Token inválido ou expirado",
    });
  }
}

function sanitizeFileName(name = "arquivo") {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function parseNonNegativeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

async function uploadImageToStorage(file) {
  if (!file) return null;

  const fileName = `${Date.now()}-${sanitizeFileName(file.originalname)}`;
  const bucketName = "product-images";
  const uploadUrl = `${env.supabaseUrl}/storage/v1/object/${bucketName}/${fileName}`;

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": file.mimetype || "application/octet-stream",
      "x-upsert": "false",
    },
    body: file.buffer,
  });

  const rawText = await uploadResponse.text();
  let uploadData = null;

  try {
    uploadData = rawText ? JSON.parse(rawText) : null;
  } catch {
    uploadData = rawText;
  }

  console.log("STORAGE UPLOAD STATUS:", uploadResponse.status);
  console.log("STORAGE UPLOAD RESPONSE:", uploadData);

  if (!uploadResponse.ok) {
    throw new Error(
      uploadData?.message ||
        uploadData?.error ||
        (typeof uploadData === "string" ? uploadData : null) ||
        "Erro ao enviar imagem para o storage"
    );
  }

  return `${env.supabaseUrl}/storage/v1/object/public/${bucketName}/${fileName}`;
}

function getUploadedFile(req, fieldName) {
  const list = req.files?.[fieldName];
  return Array.isArray(list) && list[0] ? list[0] : null;
}

async function getProductById(productId) {
  const response = await fetch(
    `${env.supabaseUrl}/rest/v1/products?select=*&id=eq.${productId}`,
    {
      method: "GET",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  const products = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error("Erro ao buscar produto atual");
  }

  const list = Array.isArray(products) ? products : [];
  return list[0] || null;
}

async function getProductBySku(sku) {
  const normalizedSku = String(sku || "").trim();

  if (!normalizedSku) return null;

  const response = await fetch(
    `${env.supabaseUrl}/rest/v1/products?select=*&sku=eq.${encodeURIComponent(
      normalizedSku
    )}`,
    {
      method: "GET",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error("Erro ao validar SKU");
  }

  const product = Array.isArray(data) ? data[0] : data;
  return product || null;
}

function validateProductPayload(body) {
  const {
    name,
    sku,
    category,
    price,
    compare_at_price,
    stock_quantity,
    status,
    short_description,
    weight_kg,
    height_cm,
    width_cm,
    length_cm,
  } = body;

  if (!name || !sku) {
    return { ok: false, message: "Nome e SKU são obrigatórios" };
  }

  const parsedPrice = Number(price || 0);
  const parsedCompareAtPriceInput = Number(compare_at_price || 0);
  const parsedCompareAtPrice =
    parsedPrice > 0 &&
    Number.isFinite(parsedCompareAtPriceInput) &&
    parsedCompareAtPriceInput > parsedPrice
      ? parsedCompareAtPriceInput
      : parsedPrice > 0
        ? Number((parsedPrice + 1).toFixed(2))
        : 0;
  const parsedStock = Number(stock_quantity || 0);
  const normalizedStatus = String(status || "draft").trim().toLowerCase();

  const parsedWeight = parseNonNegativeNumber(weight_kg, 0);
  const parsedHeight = parseNonNegativeNumber(height_cm, 0);
  const parsedWidth = parseNonNegativeNumber(width_cm, 0);
  const parsedLength = parseNonNegativeNumber(length_cm, 0);

  if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
    return { ok: false, message: "Preço inválido" };
  }

  if (Number.isNaN(parsedStock) || parsedStock < 0) {
    return { ok: false, message: "Estoque inválido" };
  }

  if (!["active", "inactive", "draft"].includes(normalizedStatus)) {
    return { ok: false, message: "Status inválido" };
  }

  return {
    ok: true,
    data: {
      name: String(name).trim(),
      sku: String(sku).trim(),
      category: String(category || "").trim(),
      price: parsedPrice,
      compare_at_price: parsedCompareAtPrice,
      stock_quantity: parsedStock,
      status: normalizedStatus,
      short_description: String(short_description || "").trim(),
      weight_kg: parsedWeight,
      height_cm: parsedHeight,
      width_cm: parsedWidth,
      length_cm: parsedLength,
    },
  };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const category = String(req.query.category || "all").trim().toLowerCase();

    const response = await fetch(
      `${env.supabaseUrl}/rest/v1/products?select=*&order=created_at.desc.nullslast`,
      {
        method: "GET",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    const products = await response.json().catch(() => []);

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar produtos",
        details: products,
      });
    }

    let filtered = Array.isArray(products) ? products : [];

    if (search) {
      filtered = filtered.filter((product) => {
        const name = String(product.name || "").toLowerCase();
        const sku = String(product.sku || "").toLowerCase();
        const productCategory = String(product.category || "").toLowerCase();

        return (
          name.includes(search) ||
          sku.includes(search) ||
          productCategory.includes(search)
        );
      });
    }

    if (status !== "all") {
      filtered = filtered.filter(
        (product) => String(product.status || "").toLowerCase() === status
      );
    }

    if (category !== "all") {
      filtered = filtered.filter(
        (product) => String(product.category || "").trim().toLowerCase() === category
      );
    }

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      products: filtered.map((product) => ({
        id: product.id,
        name: product.name,
        shortDescription: product.short_description || "-",
        sku: product.sku || "-",
        category: product.category || "-",
        price: Number(product.price || 0).toLocaleString("pt-BR", {
          style: "currency",
          currency: "BRL",
        }),
        stock: Number(product.stock_quantity || 0),
        status: product.status || "draft",
        imageUrl: product.image_url || "",
        imageUrl2: product.image_url_2 || "",
        currentPrice: Number(product.price || 0),
        rawPrice: Number(product.price || 0),
        compareAtPrice: Number(product.compare_at_price || 0),
        rawCompareAtPrice: Number(product.compare_at_price || 0),
        stockQuantity: Number(product.stock_quantity || 0),
        short_description: product.short_description || "",
        image_url: product.image_url || "",
        image_url_2: product.image_url_2 || "",
        weight_kg: Number(product.weight_kg || 0),
        height_cm: Number(product.height_cm || 0),
        width_cm: Number(product.width_cm || 0),
        length_cm: Number(product.length_cm || 0),

        installment_count: Number(product.installment_count || 12),
        installmentCount: Number(product.installment_count || 12),
        installment_value: product.installment_value ?? null,
        installmentValue: product.installment_value ?? null,
        installment_label: product.installment_label || "",
        installmentLabel: product.installment_label || "",
        payment_method_simulated: product.payment_method_simulated || "credit_card",
        paymentMethodSimulated: product.payment_method_simulated || "credit_card",
        payment_fee_value: product.payment_fee_value ?? null,
        paymentFeeValue: product.payment_fee_value ?? null,
        payment_net_value: product.payment_net_value ?? null,
        paymentNetValue: product.payment_net_value ?? null,
        pricing_updated_at: product.pricing_updated_at || null,
        pricingUpdatedAt: product.pricing_updated_at || null,
      })),
    });
  } catch (error) {
    console.error("ERRO AO LISTAR PRODUTOS:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao listar produtos",
    });
  }
});

router.post(
  "/",
  requireAuth,
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "image2", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const validation = validateProductPayload(req.body);

      if (!validation.ok) {
        return res.status(400).json({
          success: false,
          message: validation.message,
        });
      }

      const {
        name,
        sku,
        category,
        price,
        compare_at_price,
        stock_quantity,
        status,
        short_description,
        weight_kg,
        height_cm,
        width_cm,
        length_cm,
      } = validation.data;

      const existingProduct = await getProductBySku(sku);

      if (existingProduct) {
        return res.status(409).json({
          success: false,
          message: "Já existe um produto com esse SKU",
        });
      }

      let uploadedImageUrl = "";
      let uploadedImageUrl2 = "";

      const image1File = getUploadedFile(req, "image");
      const image2File = getUploadedFile(req, "image2");

      if (image1File) {
        try {
          uploadedImageUrl = (await uploadImageToStorage(image1File)) || "";
        } catch (error) {
          console.error("ERRO NO UPLOAD DA IMAGEM 1:", error.message);
          uploadedImageUrl = "";
        }
      }

      if (image2File) {
        try {
          uploadedImageUrl2 = (await uploadImageToStorage(image2File)) || "";
        } catch (error) {
          console.error("ERRO NO UPLOAD DA IMAGEM 2:", error.message);
          uploadedImageUrl2 = "";
        }
      }

      const createPayload = {
        name,
        sku,
        category,
        price,
        compare_at_price,
        stock_quantity,
        status,
        short_description,
        weight_kg,
        height_cm,
        width_cm,
        length_cm,
        image_url: uploadedImageUrl || "",
        image_url_2: uploadedImageUrl2 || "",
      };

      const response = await fetch(`${env.supabaseUrl}/rest/v1/products`, {
        method: "POST",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(createPayload),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        console.error("ERRO AO CRIAR PRODUTO:", data);

        return res.status(500).json({
          success: false,
          message: "Erro ao criar produto",
          details: data,
        });
      }

      const created = Array.isArray(data) ? data[0] : data;

      return res.status(201).json({
        success: true,
        message: "Produto criado com sucesso",
        product: created,
        imageUploaded: Boolean(uploadedImageUrl),
        image2Uploaded: Boolean(uploadedImageUrl2),
      });
    } catch (error) {
      console.error("ERRO INTERNO AO CRIAR PRODUTO:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Erro interno ao criar produto",
      });
    }
  }
);

router.put(
  "/:id",
  requireAuth,
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "image2", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: "ID do produto é obrigatório",
        });
      }

      const validation = validateProductPayload(req.body);

      if (!validation.ok) {
        return res.status(400).json({
          success: false,
          message: validation.message,
        });
      }

      const currentProduct = await getProductById(id);

      if (!currentProduct) {
        return res.status(404).json({
          success: false,
          message: "Produto não encontrado",
        });
      }

      const {
        name,
        sku,
        category,
        price,
        compare_at_price,
        stock_quantity,
        status,
        short_description,
        weight_kg,
        height_cm,
        width_cm,
        length_cm,
      } = validation.data;

      const existingProduct = await getProductBySku(sku);

      if (existingProduct && String(existingProduct.id) !== String(id)) {
        return res.status(409).json({
          success: false,
          message: "Já existe outro produto com esse SKU",
        });
      }

      let finalImageUrl = currentProduct.image_url || "";
      let finalImageUrl2 = currentProduct.image_url_2 || "";

      const image1File = getUploadedFile(req, "image");
      const image2File = getUploadedFile(req, "image2");

      if (image1File) {
        try {
          finalImageUrl = (await uploadImageToStorage(image1File)) || finalImageUrl;
        } catch (error) {
          console.error("ERRO NO UPLOAD DA NOVA IMAGEM 1:", error.message);
        }
      }

      if (image2File) {
        try {
          finalImageUrl2 = (await uploadImageToStorage(image2File)) || finalImageUrl2;
        } catch (error) {
          console.error("ERRO NO UPLOAD DA NOVA IMAGEM 2:", error.message);
        }
      }

      const updatePayload = {
        name,
        sku,
        category,
        price,
        compare_at_price,
        stock_quantity,
        status,
        short_description,
        weight_kg,
        height_cm,
        width_cm,
        length_cm,
        image_url: finalImageUrl || "",
        image_url_2: finalImageUrl2 || "",
      };

      const response = await fetch(`${env.supabaseUrl}/rest/v1/products?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(updatePayload),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        console.error("ERRO AO ATUALIZAR PRODUTO:", data);

        return res.status(500).json({
          success: false,
          message: "Erro ao atualizar produto",
          details: data,
        });
      }

      const updated = Array.isArray(data) ? data[0] : data;

      return res.status(200).json({
        success: true,
        message: "Produto atualizado com sucesso",
        product: updated,
        imageUpdated: Boolean(image1File),
        image2Updated: Boolean(image2File),
      });
    } catch (error) {
      console.error("ERRO INTERNO AO ATUALIZAR PRODUTO:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Erro interno ao atualizar produto",
      });
    }
  }
);

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID do produto é obrigatório",
      });
    }

    const currentProduct = await getProductById(id);

    if (!currentProduct) {
      return res.status(404).json({
        success: false,
        message: "Produto não encontrado",
      });
    }

    const response = await fetch(`${env.supabaseUrl}/rest/v1/products?id=eq.${id}`, {
      method: "DELETE",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);

      return res.status(500).json({
        success: false,
        message: "Erro ao excluir produto",
        details: data,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Produto excluído com sucesso",
      deletedId: id,
    });
  } catch (error) {
    console.error("ERRO INTERNO AO EXCLUIR PRODUTO:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao excluir produto",
    });
  }
});

export default router;