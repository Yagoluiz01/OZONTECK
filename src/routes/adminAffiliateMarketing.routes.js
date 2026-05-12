import express from 'express';
import { env } from '../config/env.js';

const router = express.Router();

const SUPABASE_URL =
  env.supabaseUrl ||
  process.env.SUPABASE_URL ||
  process.env.supabaseUrl;

const SUPABASE_SERVICE_ROLE_KEY =
  env.supabaseServiceRoleKey ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.supabaseServiceRoleKey;

function getSupabaseHeaders(extraHeaders = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Configuração do Supabase ausente na API.');
  }

  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extraHeaders
  };
}

function normalizeError(error) {
  return {
    success: false,
    message: error?.message || 'Erro interno no Marketing de Afiliados.'
  };
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: getSupabaseHeaders(options.headers || {})
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      `Erro na consulta Supabase: ${response.status}`;

    throw new Error(message);
  }

  return data;
}

function toBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * =========================================================
 * ASSETS — imagens, vídeos, banners, stories, reels etc.
 * =========================================================
 */

/**
 * GET /api/admin/affiliate-marketing/assets
 */
router.get('/assets', async (req, res) => {
  try {
    const {
      product_id,
      asset_type,
      channel,
      is_active
    } = req.query;

    const filters = ['select=*'];

    if (product_id) filters.push(`product_id=eq.${encodeURIComponent(product_id)}`);
    if (asset_type) filters.push(`asset_type=eq.${encodeURIComponent(asset_type)}`);
    if (channel) filters.push(`channel=eq.${encodeURIComponent(channel)}`);
    if (is_active !== undefined) filters.push(`is_active=eq.${toBoolean(is_active)}`);

    filters.push('order=is_featured.desc,sort_order.asc,created_at.desc');

    const data = await supabaseRequest(
      `affiliate_marketing_assets?${filters.join('&')}`
    );

    return res.json({
      success: true,
      data: data || []
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MARKETING ASSETS LIST ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * POST /api/admin/affiliate-marketing/assets
 */
router.post('/assets', async (req, res) => {
  try {
    const {
      product_id,
      title,
      description,
      asset_type,
      channel,
      file_url,
      thumbnail_url,
      content_text,
      sort_order,
      is_featured,
      is_active
    } = req.body || {};

    if (!title || !asset_type) {
      return res.status(400).json({
        success: false,
        message: 'title e asset_type são obrigatórios.'
      });
    }

    const payload = {
      product_id: product_id || null,
      title,
      description: description || null,
      asset_type,
      channel: channel || 'general',
      file_url: file_url || null,
      thumbnail_url: thumbnail_url || null,
      content_text: content_text || null,
      sort_order: toInteger(sort_order, 0),
      is_featured: toBoolean(is_featured, false),
      is_active: toBoolean(is_active, true)
    };

    const data = await supabaseRequest('affiliate_marketing_assets', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    return res.status(201).json({
      success: true,
      message: 'Material cadastrado com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MARKETING ASSET CREATE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * PUT /api/admin/affiliate-marketing/assets/:id
 */
router.put('/assets/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const allowedFields = [
      'product_id',
      'title',
      'description',
      'asset_type',
      'channel',
      'file_url',
      'thumbnail_url',
      'content_text',
      'sort_order',
      'is_featured',
      'is_active'
    ];

    const payload = {};

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        payload[field] = req.body[field];
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'sort_order')) {
      payload.sort_order = toInteger(payload.sort_order, 0);
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'is_featured')) {
      payload.is_featured = toBoolean(payload.is_featured, false);
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'is_active')) {
      payload.is_active = toBoolean(payload.is_active, true);
    }

    const data = await supabaseRequest(
      `affiliate_marketing_assets?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );

    return res.json({
      success: true,
      message: 'Material atualizado com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MARKETING ASSET UPDATE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * DELETE /api/admin/affiliate-marketing/assets/:id
 *
 * Não apaga de verdade. Apenas desativa.
 */
router.delete('/assets/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const data = await supabaseRequest(
      `affiliate_marketing_assets?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          is_active: false
        })
      }
    );

    return res.json({
      success: true,
      message: 'Material desativado com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MARKETING ASSET DELETE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * =========================================================
 * MESSAGES — mensagens prontas
 * =========================================================
 */

/**
 * GET /api/admin/affiliate-marketing/messages
 */
router.get('/messages', async (req, res) => {
  try {
    const {
      product_id,
      channel,
      is_active
    } = req.query;

    const filters = ['select=*'];

    if (product_id) filters.push(`product_id=eq.${encodeURIComponent(product_id)}`);
    if (channel) filters.push(`channel=eq.${encodeURIComponent(channel)}`);
    if (is_active !== undefined) filters.push(`is_active=eq.${toBoolean(is_active)}`);

    filters.push('order=is_featured.desc,sort_order.asc,created_at.desc');

    const data = await supabaseRequest(
      `affiliate_message_templates?${filters.join('&')}`
    );

    return res.json({
      success: true,
      data: data || []
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MESSAGES LIST ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * POST /api/admin/affiliate-marketing/messages
 */
router.post('/messages', async (req, res) => {
  try {
    const {
      product_id,
      title,
      description,
      channel,
      message_text,
      cta_text,
      sort_order,
      is_featured,
      is_active
    } = req.body || {};

    if (!title || !channel || !message_text) {
      return res.status(400).json({
        success: false,
        message: 'title, channel e message_text são obrigatórios.'
      });
    }

    const payload = {
      product_id: product_id || null,
      title,
      description: description || null,
      channel,
      message_text,
      cta_text: cta_text || null,
      sort_order: toInteger(sort_order, 0),
      is_featured: toBoolean(is_featured, false),
      is_active: toBoolean(is_active, true)
    };

    const data = await supabaseRequest('affiliate_message_templates', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    return res.status(201).json({
      success: true,
      message: 'Mensagem cadastrada com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MESSAGE CREATE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * PUT /api/admin/affiliate-marketing/messages/:id
 */
router.put('/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const allowedFields = [
      'product_id',
      'title',
      'description',
      'channel',
      'message_text',
      'cta_text',
      'sort_order',
      'is_featured',
      'is_active'
    ];

    const payload = {};

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        payload[field] = req.body[field];
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'sort_order')) {
      payload.sort_order = toInteger(payload.sort_order, 0);
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'is_featured')) {
      payload.is_featured = toBoolean(payload.is_featured, false);
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'is_active')) {
      payload.is_active = toBoolean(payload.is_active, true);
    }

    const data = await supabaseRequest(
      `affiliate_message_templates?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );

    return res.json({
      success: true,
      message: 'Mensagem atualizada com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MESSAGE UPDATE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * DELETE /api/admin/affiliate-marketing/messages/:id
 *
 * Não apaga de verdade. Apenas desativa.
 */
router.delete('/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const data = await supabaseRequest(
      `affiliate_message_templates?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          is_active: false
        })
      }
    );

    return res.json({
      success: true,
      message: 'Mensagem desativada com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MESSAGE DELETE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * =========================================================
 * TRAININGS — mini treinamentos
 * =========================================================
 */

/**
 * GET /api/admin/affiliate-marketing/trainings
 */
router.get('/trainings', async (req, res) => {
  try {
    const {
      product_id,
      module_type,
      is_active
    } = req.query;

    const filters = ['select=*'];

    if (product_id) filters.push(`product_id=eq.${encodeURIComponent(product_id)}`);
    if (module_type) filters.push(`module_type=eq.${encodeURIComponent(module_type)}`);
    if (is_active !== undefined) filters.push(`is_active=eq.${toBoolean(is_active)}`);

    filters.push('order=sort_order.asc,created_at.asc');

    const data = await supabaseRequest(
      `affiliate_training_modules?${filters.join('&')}`
    );

    return res.json({
      success: true,
      data: data || []
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE TRAININGS LIST ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * POST /api/admin/affiliate-marketing/trainings
 */
router.post('/trainings', async (req, res) => {
  try {
    const {
      product_id,
      title,
      subtitle,
      description,
      module_type,
      content,
      video_url,
      thumbnail_url,
      duration_minutes,
      sort_order,
      is_required,
      is_active
    } = req.body || {};

    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'title é obrigatório.'
      });
    }

    const payload = {
      product_id: product_id || null,
      title,
      subtitle: subtitle || null,
      description: description || null,
      module_type: module_type || 'text',
      content: content || null,
      video_url: video_url || null,
      thumbnail_url: thumbnail_url || null,
      duration_minutes: duration_minutes ? toInteger(duration_minutes, null) : null,
      sort_order: toInteger(sort_order, 0),
      is_required: toBoolean(is_required, false),
      is_active: toBoolean(is_active, true)
    };

    const data = await supabaseRequest('affiliate_training_modules', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    return res.status(201).json({
      success: true,
      message: 'Treinamento cadastrado com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE TRAINING CREATE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * PUT /api/admin/affiliate-marketing/trainings/:id
 */
router.put('/trainings/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const allowedFields = [
      'product_id',
      'title',
      'subtitle',
      'description',
      'module_type',
      'content',
      'video_url',
      'thumbnail_url',
      'duration_minutes',
      'sort_order',
      'is_required',
      'is_active'
    ];

    const payload = {};

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        payload[field] = req.body[field];
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'duration_minutes')) {
      payload.duration_minutes = payload.duration_minutes
        ? toInteger(payload.duration_minutes, null)
        : null;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'sort_order')) {
      payload.sort_order = toInteger(payload.sort_order, 0);
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'is_required')) {
      payload.is_required = toBoolean(payload.is_required, false);
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'is_active')) {
      payload.is_active = toBoolean(payload.is_active, true);
    }

    const data = await supabaseRequest(
      `affiliate_training_modules?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );

    return res.json({
      success: true,
      message: 'Treinamento atualizado com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE TRAINING UPDATE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * DELETE /api/admin/affiliate-marketing/trainings/:id
 *
 * Não apaga de verdade. Apenas desativa.
 */
router.delete('/trainings/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const data = await supabaseRequest(
      `affiliate_training_modules?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          is_active: false
        })
      }
    );

    return res.json({
      success: true,
      message: 'Treinamento desativado com sucesso.',
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE TRAINING DELETE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});




const MARKETING_KIT_BUCKET = 'affiliate-marketing-kit';

function sanitizeFileName(fileName = 'arquivo') {
  const cleanName = String(fileName)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();

  return cleanName || 'arquivo';
}

function sanitizeFolder(folder = 'assets') {
  const allowedFolders = ['assets', 'trainings', 'thumbnails'];

  if (allowedFolders.includes(folder)) {
    return folder;
  }

  return 'assets';
}

function getStoragePublicUrl(objectPath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${MARKETING_KIT_BUCKET}/${objectPath}`;
}

/**
 * POST /api/admin/affiliate-marketing/uploads
 *
 * Recebe arquivo em base64 vindo do admin e salva no Supabase Storage.
 */
router.post('/uploads', async (req, res) => {
  try {
    const {
      fileName,
      mimeType,
      base64,
      folder,
      size
    } = req.body || {};

    if (!fileName || !base64) {
      return res.status(400).json({
        success: false,
        message: 'fileName e base64 são obrigatórios.'
      });
    }

    const fileSize = Number(size || 0);
    const maxSize = 50 * 1024 * 1024;

    if (fileSize > maxSize) {
      return res.status(400).json({
        success: false,
        message: 'Arquivo muito grande. Envie arquivos de até 50 MB.'
      });
    }

    const cleanBase64 = String(base64).includes(',')
      ? String(base64).split(',').pop()
      : String(base64);

    const buffer = Buffer.from(cleanBase64, 'base64');

    if (!buffer.length) {
      return res.status(400).json({
        success: false,
        message: 'Arquivo inválido.'
      });
    }

    const safeFolder = sanitizeFolder(folder);
    const safeFileName = sanitizeFileName(fileName);
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const uniqueName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeFileName}`;
    const objectPath = `${safeFolder}/${year}/${month}/${uniqueName}`;

    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${MARKETING_KIT_BUCKET}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': mimeType || 'application/octet-stream',
          'x-upsert': 'false'
        },
        body: buffer
      }
    );

    const uploadText = await uploadResponse.text();

    let uploadData = null;

    try {
      uploadData = uploadText ? JSON.parse(uploadText) : null;
    } catch {
      uploadData = uploadText;
    }

    if (!uploadResponse.ok) {
      const message =
        uploadData?.message ||
        uploadData?.error ||
        `Erro ao enviar arquivo: ${uploadResponse.status}`;

      throw new Error(message);
    }

    return res.status(201).json({
      success: true,
      message: 'Arquivo enviado com sucesso.',
      data: {
        bucket: MARKETING_KIT_BUCKET,
        path: objectPath,
        public_url: getStoragePublicUrl(objectPath),
        mime_type: mimeType || null,
        file_name: safeFileName,
        size_bytes: buffer.length
      }
    });
  } catch (error) {
    console.error('ADMIN AFFILIATE MARKETING UPLOAD ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

export default router;