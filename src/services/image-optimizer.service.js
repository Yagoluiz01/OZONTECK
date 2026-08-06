/**
 * Image Optimizer Service
 * 
 * Gera múltiplas versões otimizadas de imagens durante o upload:
 * - thumb (320px) - para listagens e catálogo
 * - card (480px) - para cards de produto
 * - detail (800px) - para página de detalhe e telas de alta densidade
 * - zoom (1200px) - para zoom/lightbox
 * - lqip (20px) - placeholder de baixa qualidade (base64 blur)
 * 
 * Todas as versões são WebP com qualidade otimizada.
 * Estrutura preparada para suporte futuro a AVIF.
 */

import sharp from "sharp";
import crypto from "crypto";
import { env } from "../config/env.js";

const SIZES = {
  // Thumb continua pequeno para listagens compactas.
  thumb: { width: 320, quality: 78, suffix: "th" },
  card: { width: 480, quality: 83, suffix: "cd" },
  // A versão de 800 px também atende cards em telas mobile de alta densidade.
  detail: { width: 800, quality: 86, suffix: "dt" },
  // Mantém o limite anterior para não aumentar excessivamente o peso da loja.
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

const BUCKET_NAME = "product-images";

/**
 * Gera todas as versões otimizadas de uma imagem
 */
export async function generateOptimizedVersions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    throw new Error("Buffer de imagem inválido");
  }

  // Valida a imagem antes de iniciar os encodes. Cada versão é gerada
  // diretamente do arquivo recebido para evitar uma recompressão intermediária.
  await sharp(buffer, { failOn: "warning" }).metadata();

  const versions = {};

  // Gera LQIP (placeholder blur). Ele nunca deve ser usado como imagem final.
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

/**
 * Gera placeholder de baixa qualidade (LQIP) em base64
 */
async function generateLqip(buffer) {
  try {
    const lqipBuffer = await sharp(buffer)
      .rotate()
      .resize(LQIP_SIZE, null, { fit: "inside" })
      .webp({ quality: LQIP_QUALITY, effort: 4 })
      .toBuffer();

    return `data:image/webp;base64,${lqipBuffer.toString("base64")}`;
  } catch (error) {
    console.warn("Falha ao gerar LQIP:", error.message);
    return "";
  }
}

/**
 * Faz upload de todas as versões para o Supabase Storage
 * Retorna um mapa com as URLs de cada tamanho
 */
export async function uploadOptimizedVersions(versions, baseFileName) {
  const urls = {};

  for (const [name, data] of Object.entries(versions)) {
    if (name === "lqip") {
      urls.lqip = data;
      continue;
    }

    const fileName = `${baseFileName}-${SIZES[name].suffix}.webp`;
    const uploadUrl = `${env.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${fileName}`;

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "image/webp",
        "x-upsert": "true",
        "cache-control": "public, max-age=31536000, immutable",
      },
      body: data.buffer,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Falha ao fazer upload da versão ${name}:`, errorText);
      throw new Error(`Erro ao fazer upload da versão ${name}: ${errorText}`);
    }

    urls[name] = `${env.supabaseUrl}/storage/v1/object/public/${BUCKET_NAME}/${fileName}`;
  }

  return urls;
}

/**
 * Processa e faz upload de uma imagem do produto, gerando todas as versões
 * 
 * @param {Buffer} buffer - Buffer da imagem original
 * @param {string} originalName - Nome original do arquivo
 * @returns {Object} URLs de todas as versões
 */
export async function processAndUploadProductImage(buffer, originalName = "imagem") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Imagem vazia ou inválida");
  }

  // Gera todas as versões diretamente do arquivo original.
  // O Sharp remove metadados na saída WebP por padrão e a rotação é aplicada
  // em cada versão. Isso evita dupla compressão e preserva mais detalhes.
  const versions = await generateOptimizedVersions(buffer);

  // Nome base para os arquivos
  const sanitizedName = sanitizeFileName(originalName)
    .replace(/\.[a-z0-9]+$/i, "") || "imagem";
  const baseFileName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}-${sanitizedName}`;

  // Upload de todas as versões
  const urls = await uploadOptimizedVersions(versions, baseFileName);

  return urls;
}

/**
 * Sanitiza nome de arquivo
 */
function sanitizeFileName(name = "arquivo") {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

/**
 * Retorna a configuração de tamanhos para uso no frontend (srcset)
 */
export function getSrcsetConfig() {
  return Object.entries(SIZES).map(([name, config]) => ({
    name,
    width: config.width,
    suffix: config.suffix,
  }));
}

export { SIZES };