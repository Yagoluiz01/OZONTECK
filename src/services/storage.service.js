/**
 * Storage Service - Gerenciamento de armazenamento Supabase
 * Validações, verificações e operações de storage
 */

import { env } from "../config/env.js";

const BUCKET_NAME = "banner-images";

/**
 * Verifica se o bucket existe e cria se necessário
 */
export async function verifyBucketExists() {
  try {
    const response = await fetch(
      `${env.supabaseUrl}/storage/v1/bucket/${BUCKET_NAME}`,
      {
        method: "GET",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        },
      }
    );

    if (response.ok) {
      return { exists: true, message: "Bucket encontrado", created: false };
    }

    if (response.status === 404) {
      // Tentar criar bucket automaticamente
      console.log("Bucket não encontrado. Tentando criar automaticamente...");
      const createResponse = await fetch(
        `${env.supabaseUrl}/storage/v1/bucket`,
        {
          method: "POST",
          headers: {
            apikey: env.supabaseServiceRoleKey,
            Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: BUCKET_NAME,
            name: BUCKET_NAME,
            public: true,
            file_size_limit: 104857600, // 100MB
            allowed_mime_types: [
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/avif",
              "image/gif",
              "video/mp4",
              "video/webm",
              "video/quicktime",
            ],
          }),
        }
      );

      if (createResponse.ok) {
        console.log("Bucket criado com sucesso!");
        return { exists: true, message: "Bucket criado automaticamente", created: true };
      }

      const errorText = await createResponse.text();
      console.error("Erro ao criar bucket:", errorText);
      
      let userMessage = "O bucket de armazenamento de banners não foi encontrado";
      let detailedHelp = "";
      
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.includes("permission") || errorJson.error?.includes("authorization")) {
          detailedHelp = "Sua chave SERVICE_ROLE não tem permissão para criar buckets. Acesse o painel Supabase > Storage > Create bucket, ou execute a SQL migration manualmente.";
        } else if (errorJson.error?.includes("exist")) {
          detailedHelp = "O bucket já existe mas não está acessível. Verifique as políticas RLS no painel Supabase > Storage > Policies.";
        } else {
          detailedHelp = `Erro do Supabase: ${errorJson.error || errorJson.message || errorText}`;
        }
      } catch {
        detailedHelp = `Resposta inesperada: ${errorText}`;
      }
      
      return {
        exists: false,
        message: userMessage,
        code: "BUCKET_NOT_FOUND",
        details: {
          bucketName: BUCKET_NAME,
          supabaseUrl: env.supabaseUrl,
          possibleCauses: [
            "Migration 025_create_banner_storage.sql não foi executada",
            "Chave SERVICE_ROLE sem permissão de admin",
            "Bucket foi excluído manualmente",
          ],
          solution: detailedHelp,
          action: {
            label: "Configurar Storage",
            description: "Abrir painel Supabase para criar/configurar o bucket",
            url: `${env.supabaseUrl}/project/default/storage/buckets`,
          },
        },
      };
    }

    const errorText = await response.text();
    return {
      exists: false,
      message: `Erro ao verificar bucket: ${errorText}`,
      code: "STORAGE_ERROR",
    };
  } catch (error) {
    return {
      exists: false,
      message: `Storage indisponível: ${error.message}`,
      code: "STORAGE_UNAVAILABLE",
    };
  }
}

/**
 * Valida permissões do storage
 */
export async function validateStoragePermissions() {
  try {
    // Tentar fazer upload de um arquivo de teste
    const testContent = "test";
    const testPath = `permissions-test-${Date.now()}.txt`;

    const response = await fetch(
      `${env.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${testPath}`,
      {
        method: "POST",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "Content-Type": "text/plain",
        },
        body: testContent,
      }
    );

    if (response.ok) {
      // Remover arquivo de teste
      await fetch(
        `${env.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${testPath}`,
        {
          method: "DELETE",
          headers: {
            apikey: env.supabaseServiceRoleKey,
            Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          },
        }
      );

      return { valid: true, message: "Permissões OK" };
    }

    const errorText = await response.text();
    return {
      valid: false,
      message: `Permissão insuficiente: ${errorText}`,
      code: "PERMISSION_DENIED",
    };
  } catch (error) {
    return {
      valid: false,
      message: `Erro ao validar permissões: ${error.message}`,
      code: "PERMISSION_ERROR",
    };
  }
}

/**
 * Sanitiza nome de arquivo removendo caracteres perigosos
 */
export function sanitizeFileName(fileName) {
  if (!fileName) return `file-${Date.now()}`;
  
  // Remove extensão para sanitizar o base name
  const parts = fileName.split(".");
  const ext = parts.length > 1 ? parts.pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  let baseName = parts.join(".");
  
  // Remove caracteres perigosos (path traversal, shell injection, etc)
  baseName = baseName
    .replace(/[^a-zA-Z0-9_\-\u00C0-\u024F\s]/g, "") // Remove caracteres especiais perigosos
    .replace(/\.\./g, "") // Remove path traversal
    .replace(/[/\\]/g, "") // Remove barras
    .trim()
    .substring(0, 100); // Limita tamanho
  
  if (!baseName) baseName = `file-${Date.now()}`;
  
  return ext ? `${baseName}.${ext}` : baseName;
}

/**
 * Valida se o arquivo é realmente do tipo que declara ser
 * Verifica magic bytes (assinatura do arquivo)
 */
export function validateFileMagicBytes(buffer, mimeType) {
  if (!buffer || buffer.length < 4) return false;
  
  const header = Array.from(new Uint8Array(buffer.slice(0, 4)));
  
  const magicBytes = {
    "image/jpeg": [[0xFF, 0xD8, 0xFF]],
    "image/png": [[0x89, 0x50, 0x4E, 0x47]],
    "image/gif": [[0x47, 0x49, 0x46, 0x38]],
    "image/webp": [[0x52, 0x49, 0x46, 0x46]],
    "video/mp4": [[0x00, 0x00, 0x00], [0x66, 0x74, 0x79, 0x70]],
    "video/webm": [[0x1A, 0x45, 0xDF, 0xA3]],
  };
  
  const signatures = magicBytes[mimeType];
  if (!signatures) return true; // Se não temos magic bytes conhecidos, confia no MIME
  
  return signatures.some(sig => 
    sig.every((byte, i) => header[i] === byte)
  );
}

/**
 * Valida arquivo antes do upload
 */
export function validateFile(file, type = "image") {
  const errors = [];

  if (!file) {
    errors.push("Arquivo não fornecido");
    return { valid: false, errors };
  }

  // Validar tipo MIME
  const allowedImageTypes = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];
  const allowedVideoTypes = ["video/mp4", "video/webm", "video/quicktime"];
  const allowedTypes = type === "video" ? allowedVideoTypes : allowedImageTypes;

  if (!allowedTypes.includes(file.mimetype || file.type)) {
    errors.push(
      `Tipo de arquivo inválido: ${file.mimetype || file.type}. Permitidos: ${allowedTypes.join(", ")}`
    );
  }

  // Validar extensão
  const fileName = file.originalname || file.name || "";
  const extension = fileName.split(".").pop()?.toLowerCase();

  const allowedExtensions = type === "video"
    ? ["mp4", "webm", "mov"]
    : ["jpg", "jpeg", "png", "webp", "avif", "gif"];

  if (!allowedExtensions.includes(extension)) {
    errors.push(
      `Extensão inválida: .${extension}. Permitidas: ${allowedExtensions.join(", ")}`
    );
  }

  // Validar magic bytes (assinatura do arquivo)
  if (file.buffer && file.buffer.length > 0) {
    const validMagic = validateFileMagicBytes(file.buffer, file.mimetype || file.type);
    if (!validMagic) {
      errors.push("Arquivo corrompido ou com extensão incorreta (magic bytes não conferem)");
    }
  }

  // Validar tamanho
  const maxSize = type === "video" ? 80 * 1024 * 1024 : 10 * 1024 * 1024; // 80MB ou 10MB
  if (file.size > maxSize) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    const maxMB = maxSize / 1024 / 1024;
    errors.push(`Arquivo muito grande: ${sizeMB}MB. Máximo: ${maxMB}MB`);
  }

  // Validar nome de arquivo
  if (!fileName || fileName.length < 2) {
    errors.push("Nome de arquivo inválido");
  }

  // Sanitizar nome do arquivo
  const sanitizedName = sanitizeFileName(fileName);
  if (sanitizedName !== fileName) {
    file.sanitizedName = sanitizedName;
  }

  return {
    valid: errors.length === 0,
    errors,
    fileType: type,
    fileSize: file.size,
    fileName,
    sanitizedName: sanitizeFileName(fileName),
  };
}

/**
 * Verifica se o storage está saudável
 */
export async function healthCheck() {
  const bucketCheck = await verifyBucketExists();

  if (!bucketCheck.exists) {
    return {
      healthy: false,
      message: bucketCheck.message,
      code: bucketCheck.code,
    };
  }

  const permissionsCheck = await validateStoragePermissions();

  if (!permissionsCheck.valid) {
    return {
      healthy: false,
      message: permissionsCheck.message,
      code: permissionsCheck.code,
    };
  }

  return {
    healthy: true,
    message: "Storage funcionando corretamente",
    bucket: BUCKET_NAME,
  };
}

/**
 * Remove arquivo do storage
 */
export async function deleteFile(filePath) {
  try {
    if (!filePath || typeof filePath !== "string") {
      return {
        success: false,
        message: "Caminho do arquivo não informado",
      };
    }

    // Sanitizar path para evitar path traversal
    const sanitizedPath = filePath
      .replace(/\.\./g, "")
      .replace(/[/\\]/g, "/")
      .replace(/^\/+/, "");
    
    const encodedPath = sanitizedPath.split("/").map(segment => encodeURIComponent(segment)).join("/");
    
    const response = await fetch(
      `${env.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${encodedPath}`,
      {
        method: "DELETE",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        message: `Erro ao remover arquivo: ${errorText}`,
      };
    }

    return { success: true, message: "Arquivo removido com sucesso" };
  } catch (error) {
    return {
      success: false,
      message: `Erro ao remover arquivo: ${error.message}`,
    };
  }
}

/**
 * Lista arquivos em uma pasta
 */
export async function listFiles(folder) {
  try {
    const response = await fetch(
      `${env.supabaseUrl}/storage/v1/object/list/${BUCKET_NAME}`,
      {
        method: "POST",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prefix: folder,
          limit: 1000,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        message: `Erro ao listar arquivos: ${errorText}`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      files: data || [],
    };
  } catch (error) {
    return {
      success: false,
      message: `Erro ao listar arquivos: ${error.message}`,
    };
  }
}