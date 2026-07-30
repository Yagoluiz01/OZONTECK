/**
 * Image Optimizer Service
 * 
 * Gera múltiplas versões otimizadas de imagens durante o upload:
 * - thumb (320px) - para listagens e catálogo
 * - card (480px) - para cards de produto
 * - detail (800px) - para página de detalhe
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
  thumb: { width: 320, quality: 75, suffix: "th" },
  card: { width: 480, quality: 80, suffix: "cd" },
  detail: { width: 800, quality: 82, suffix: "dt" },
  zoom: { width: 1200, quality: 85, suffix: "zm" },
};

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

  const metadata = await sharp(buffer).metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;

  const versions = {};

  // Gera LQIP (placeholder blur)
  versions.lqip = await generateLqip(buffer);

  // Gera cada tamanho
  for (const [name, config] of Object.entries(SIZES)) {
    // Só redimensiona se a imagem original for maior que o tamanho alvo
    const targetWidth = Math.min(config.width, originalWidth);
    
    if (targetWidth < 50) {
      // Imagem muito pequena, usa o tamanho original
      versions[name] = {
        buffer: await sharp(buffer)
          .rotate()
          .webp({ quality: config.quality })
          .toBuffer(),
        width: originalWidth,
        height: originalHeight,
      };
    } else {
      versions[name] = {
        buffer: await sharp(buffer)
          .rotate()
          .resize(targetWidth, null, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: config.quality })
          .toBuffer(),
        width: targetWidth,
        height: Math.round((originalHeight / originalWidth) * targetWidth),
      };
    }
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
      .webp({ quality: LQIP_QUALITY })
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

  // Remove EXIF e corrige orientação
  const cleanBuffer = await sharp(buffer)
    .rotate()
    .withMetadata({}) // objeto vazio = remove todos os metadados EXIF
    .toBuffer();

  // Gera todas as versões
  const versions = await generateOptimizedVersions(cleanBuffer);

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