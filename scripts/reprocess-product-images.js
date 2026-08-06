/**
 * Script de Reprocessamento de Imagens de Produtos
 * 
 * Objetivo: Gerar versões otimizadas (thumb, card, detail, zoom, lqip)
 * para TODOS os produtos que ainda não possuem essas versões.
 * 
 * Uso:
 *   node scripts/reprocess-product-images.js
 *   node scripts/reprocess-product-images.js --limit=10
 *   node scripts/reprocess-product-images.js --product-id=abc-123
 *   node scripts/reprocess-product-images.js --dry-run
 * 
 * Flags:
 *   --limit=N       Processa apenas N produtos (para teste)
 *   --product-id=X  Processa apenas um produto específico
 *   --dry-run       Apenas lista o que seria processado, sem alterar nada
 *   --force         Reprocessa mesmo se já tiver versões
 * 
 * Requer:
 *   - Variáveis de ambiente configuradas (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 *   - sharp instalado (já está nas dependências)
 */

import sharp from "sharp";
import crypto from "crypto";
import { createInterface } from "readline";

// Configuração - usa as mesmas variáveis da API
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET_NAME = "product-images";

// Tamanhos a gerar
const SIZES = {
  thumb: { width: 320, quality: 78, suffix: "th" },
  card: { width: 480, quality: 83, suffix: "cd" },
  detail: { width: 800, quality: 86, suffix: "dt" },
  zoom: { width: 1200, quality: 88, suffix: "zm" },
};

function getWebpOptions(quality) {
  return {
    quality,
    alphaQuality: 92,
    effort: 5,
    smartSubsample: true,
    preset: "picture",
  };
}

const LQIP_SIZE = 20;
const LQIP_QUALITY = 20;

// Stats
const stats = {
  total: 0,
  processed: 0,
  skipped: 0,
  errors: 0,
  totalOriginalBytes: 0,
  totalOptimizedBytes: 0,
};

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--force") args.force = true;
    if (arg.startsWith("--limit=")) args.limit = parseInt(arg.split("=")[1], 10);
    if (arg.startsWith("--product-id=")) args.productId = arg.split("=")[1];
  });
  return args;
}

function log(message, type = "info") {
  const prefix = {
    info: "[INFO]",
    ok: "[OK]",
    warn: "[WARN]",
    error: "[ERRO]",
    skip: "[SKIP]",
  }[type] || "[INFO]";

  console.log(`${prefix} ${message}`);
}

async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { ok: response.ok, status: response.status, data };
}

async function fetchProductsToReprocess(args) {
  let url = `/rest/v1/products?select=id,name,sku,image_url,image_url_2,image_thumb_url,image_card_url,image_detail_url,image_zoom_url,image_lqip,image_2_thumb_url,image_2_card_url,image_2_detail_url,image_2_zoom_url,image_2_lqip&order=created_at.desc`;

  if (args.productId) {
    url += `&id=eq.${args.productId}`;
  }

  const { ok, data } = await supabaseFetch(url);

  if (!ok || !Array.isArray(data)) {
    throw new Error("Falha ao buscar produtos do Supabase");
  }

  let products = data;

  if (!args.force) {
    // Filtra apenas produtos que PRECISAM de reprocessamento
    products = products.filter((p) => {
      const needsImage1 = p.image_url && !p.image_thumb_url;
      const needsImage2 = p.image_url_2 && !p.image_2_thumb_url;
      return needsImage1 || needsImage2;
    });
  }

  if (args.limit && args.limit > 0) {
    products = products.slice(0, args.limit);
  }

  return products;
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao baixar imagem: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

async function generateLqip(buffer) {
  try {
    const lqipBuffer = await sharp(buffer)
      .rotate()
      .resize(LQIP_SIZE, null, { fit: "inside" })
      .webp({ quality: LQIP_QUALITY, effort: 4 })
      .toBuffer();
    return `data:image/webp;base64,${lqipBuffer.toString("base64")}`;
  } catch {
    return "";
  }
}

async function generateVersions(buffer) {
  await sharp(buffer, { failOn: "warning" }).metadata();

  const versions = {};
  versions.lqip = await generateLqip(buffer);

  for (const [name, config] of Object.entries(SIZES)) {
    const { data, info } = await sharp(buffer, { failOn: "warning" })
      .rotate()
      .resize({
        width: config.width,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp(getWebpOptions(config.quality))
      .toBuffer({ resolveWithObject: true });

    versions[name] = {
      buffer: data,
      width: info.width,
      height: info.height,
      size: data.length,
    };
  }

  return versions;
}

async function uploadVersion(buffer, fileName) {
  const uploadUrl = `/storage/v1/object/${BUCKET_NAME}/${fileName}`;

  const { ok, status, data } = await supabaseFetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "image/webp",
      "x-upsert": "true",
      "cache-control": "public, max-age=31536000, immutable",
    },
    body: buffer,
  });

  if (!ok) {
    throw new Error(`Upload falhou (${status}): ${JSON.stringify(data)}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${fileName}`;
}

function extractBaseFileName(url) {
  if (!url) return null;
  const parts = url.split("/");
  const fileName = parts[parts.length - 1];
  // Remove sufixo de tamanho se existir (-th, -cd, -dt, -zm)
  return fileName.replace(/-(th|cd|dt|zm)\.webp$/i, "").replace(/\.webp$/i, "");
}

async function processSingleImage(imageUrl, prefix, args) {
  if (!imageUrl) return {};

  const baseName = extractBaseFileName(imageUrl);
  if (!baseName) {
    log(`URL inválida: ${imageUrl.substring(0, 60)}...`, "warn");
    return {};
  }

  log(`Baixando imagem original: ${imageUrl.substring(0, 60)}...`);

  let originalBuffer;
  try {
    originalBuffer = await downloadImage(imageUrl);
  } catch (error) {
    log(`Falha ao baixar: ${error.message}`, "error");
    return {};
  }

  stats.totalOriginalBytes += originalBuffer.length;
  log(`Original: ${(originalBuffer.length / 1024).toFixed(1)} KB`);

  // Gera as versões diretamente do arquivo baixado para evitar dupla compressão.
  const versions = await generateVersions(originalBuffer);

  const urls = {};

  if (args.dryRun) {
    log(`[DRY-RUN] Upload simulado para ${baseName}`);
    for (const [name, data] of Object.entries(versions)) {
      if (name === "lqip") {
        log(`  LQIP: ${data.substring(0, 40)}... (${data.length} chars)`);
      } else {
        log(`  ${name} (${SIZES[name].width}px): ${(data.buffer.length / 1024).toFixed(1)} KB`);
        stats.totalOptimizedBytes += data.buffer.length;
      }
    }
    return versions; // Retorna os buffers mesmo em dry-run para calcular stats
  }

  // Upload de cada versão
  for (const [name, data] of Object.entries(versions)) {
    if (name === "lqip") {
      urls.lqip = data;
      continue;
    }

    const fileName = `${baseName}-${SIZES[name].suffix}.webp`;
    try {
      const publicUrl = await uploadVersion(data.buffer, fileName);
      urls[name] = publicUrl;
      stats.totalOptimizedBytes += data.buffer.length;
      log(`  ${name} (${SIZES[name].width}px): ${(data.buffer.length / 1024).toFixed(1)} KB → OK`);
    } catch (error) {
      log(`  ${name}: ERRO - ${error.message}`, "error");
    }
  }

  return urls;
}

async function updateProductInDatabase(productId, updateFields) {
  if (Object.keys(updateFields).length === 0) return true;

  const { ok } = await supabaseFetch(`/rest/v1/products?id=eq.${productId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(updateFields),
  });

  return ok;
}

async function main() {
  const args = parseArgs();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios", "error");
    log("Configure as variáveis de ambiente ou execute via API", "error");
    process.exit(1);
  }

  log("=== REPROCESSAMENTO DE IMAGENS DE PRODUTOS ===");
  log(`Modo: ${args.dryRun ? "DRY-RUN (sem alterações)" : args.force ? "FORCE (reprocessar todos)" : "NORMAL (apenas sem versões)"}`);
  if (args.limit) log(`Limite: ${args.limit} produtos`);
  if (args.productId) log(`Produto específico: ${args.productId}`);
  log("");

  // Buscar produtos
  log("Buscando produtos...");
  let products;
  try {
    products = await fetchProductsToReprocess(args);
  } catch (error) {
    log(`Falha ao buscar produtos: ${error.message}`, "error");
    process.exit(1);
  }

  log(`Encontrados ${products.length} produtos para processar`);
  stats.total = products.length;

  if (products.length === 0) {
    log("Nenhum produto precisa de reprocessamento!");
    log('Use --force para reprocessar todos ou --product-id para um específico');
    return;
  }

  if (!args.dryRun) {
    log("");
    log("ATENÇÃO: Este script fará upload de múltiplas versões de imagem para o Storage");
    log("e atualizará o banco de dados. Deseja continuar? (s/N)");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question("> ", (a) => {
        rl.close();
        resolve(a.trim().toLowerCase());
      });
    });

    if (answer !== "s" && answer !== "sim") {
      log("Operação cancelada pelo usuário.");
      return;
    }
  }

  log("");
  log("Processando produtos...");
  log("");

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    log(`[${i + 1}/${products.length}] ${product.name || product.sku || product.id}`);

    try {
      const updateFields = {};

      // Processa imagem 1
      if (product.image_url && (args.force || !product.image_thumb_url)) {
        log("  Imagem 1:");
        const urls1 = await processSingleImage(product.image_url, "img1", args);
        if (urls1.thumb) updateFields.image_thumb_url = urls1.thumb;
        if (urls1.card) updateFields.image_card_url = urls1.card;
        if (urls1.detail) updateFields.image_detail_url = urls1.detail;
        if (urls1.zoom) updateFields.image_zoom_url = urls1.zoom;
        if (urls1.lqip) updateFields.image_lqip = urls1.lqip;
      } else {
        log("  Imagem 1: já possui versões (skipped)");
        stats.skipped++;
      }

      // Processa imagem 2
      if (product.image_url_2 && (args.force || !product.image_2_thumb_url)) {
        log("  Imagem 2:");
        const urls2 = await processSingleImage(product.image_url_2, "img2", args);
        if (urls2.thumb) updateFields.image_2_thumb_url = urls2.thumb;
        if (urls2.card) updateFields.image_2_card_url = urls2.card;
        if (urls2.detail) updateFields.image_2_detail_url = urls2.detail;
        if (urls2.zoom) updateFields.image_2_zoom_url = urls2.zoom;
        if (urls2.lqip) updateFields.image_2_lqip = urls2.lqip;
      } else {
        log("  Imagem 2: já possui versões ou não existe (skipped)");
      }

      // Atualiza banco
      if (!args.dryRun && Object.keys(updateFields).length > 0) {
        const updated = await updateProductInDatabase(product.id, updateFields);
        if (updated) {
          stats.processed++;
          log("  ✅ Banco atualizado");
        } else {
          stats.errors++;
          log("  ❌ Falha ao atualizar banco", "error");
        }
      } else if (args.dryRun && Object.keys(updateFields).length > 0) {
        stats.processed++;
        log("  [DRY-RUN] Campos que seriam atualizados:", "info");
        Object.keys(updateFields).forEach((key) => {
          const val = updateFields[key];
          const display = val?.substring ? val.substring(0, 50) + "..." : String(val).substring(0, 50);
          log(`    ${key}: ${display}`);
        });
      } else {
        stats.skipped++;
      }
    } catch (error) {
      stats.errors++;
      log(`  ❌ Erro: ${error.message}`, "error");
    }

    log("");
  }

  // Relatório final
  log("=== RELATÓRIO FINAL ===");
  log(`Total de produtos analisados: ${stats.total}`);
  log(`Produtos processados: ${stats.processed}`);
  log(`Produtos ignorados (já tinham versões): ${stats.skipped}`);
  log(`Erros: ${stats.errors}`);

  if (stats.totalOriginalBytes > 0) {
    const originalMB = (stats.totalOriginalBytes / 1024 / 1024).toFixed(2);
    const optimizedMB = (stats.totalOptimizedBytes / 1024 / 1024).toFixed(2);
    const reduction = stats.totalOriginalBytes > 0
      ? ((1 - stats.totalOptimizedBytes / stats.totalOriginalBytes) * 100).toFixed(1)
      : 0;

    log("");
    log("Economia de banda (apenas versões geradas):");
    log(`  Original total: ${originalMB} MB`);
    log(`  Versões otimizadas: ${optimizedMB} MB`);
    log(`  Redução: ${reduction}%`);
  }

  if (args.dryRun) {
    log("");
    log("⚠️  DRY-RUN: Nenhuma alteração foi feita no Storage ou no banco.");
    log("   Execute sem --dry-run para aplicar as alterações.");
  }
}

main().catch((error) => {
  console.error("ERRO FATAL:", error);
  process.exit(1);
});