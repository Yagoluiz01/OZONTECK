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

function getSupabaseHeaders() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Configuração do Supabase ausente na API.');
  }

  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
}

function normalizeError(error) {
  return {
    success: false,
    message: error?.message || 'Erro interno no Kit de Divulgação.'
  };
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...getSupabaseHeaders(),
      ...(options.headers || {})
    }
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

/**
 * GET /api/affiliate/marketing-kit
 *
 * Retorna todos os materiais ativos:
 * - imagens
 * - vídeos
 * - mensagens
 * - treinamentos
 */
router.get('/', async (req, res) => {
  try {
    const [assets, messages, trainings] = await Promise.all([
      supabaseRequest(
        'v_affiliate_kit_assets_active?select=*&order=is_featured.desc,sort_order.asc,created_at.desc'
      ),
      supabaseRequest(
        'v_affiliate_message_templates_active?select=*&order=is_featured.desc,sort_order.asc,created_at.desc'
      ),
      supabaseRequest(
        'v_affiliate_training_modules_active?select=*&order=sort_order.asc,created_at.asc'
      )
    ]);

    return res.json({
      success: true,
      data: {
        assets: assets || [],
        messages: messages || [],
        trainings: trainings || []
      }
    });
  } catch (error) {
    console.error('AFFILIATE MARKETING KIT LIST ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * GET /api/affiliate/marketing-kit/product/:productId
 *
 * Retorna o kit de divulgação de um produto específico.
 */
router.get('/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'productId é obrigatório.'
      });
    }

    const encodedProductId = encodeURIComponent(productId);

    const [assets, messages, trainings] = await Promise.all([
      supabaseRequest(
        `v_affiliate_kit_assets_active?product_id=eq.${encodedProductId}&select=*&order=is_featured.desc,sort_order.asc,created_at.desc`
      ),
      supabaseRequest(
        `v_affiliate_message_templates_active?product_id=eq.${encodedProductId}&select=*&order=is_featured.desc,sort_order.asc,created_at.desc`
      ),
      supabaseRequest(
        `v_affiliate_training_modules_active?product_id=eq.${encodedProductId}&select=*&order=sort_order.asc,created_at.asc`
      )
    ]);

    return res.json({
      success: true,
      data: {
        product_id: productId,
        assets: assets || [],
        messages: messages || [],
        trainings: trainings || []
      }
    });
  } catch (error) {
    console.error('AFFILIATE MARKETING KIT PRODUCT ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * POST /api/affiliate/marketing-kit/action
 *
 * Registra ação do afiliado:
 * - view
 * - copy
 * - download
 * - share
 * - whatsapp_click
 * - training_start
 * - training_complete
 */
router.post('/action', async (req, res) => {
  try {
    const {
      affiliate_id,
      product_id,
      asset_id,
      message_template_id,
      training_module_id,
      action_type,
      metadata
    } = req.body || {};

    if (!action_type) {
      return res.status(400).json({
        success: false,
        message: 'action_type é obrigatório.'
      });
    }

    const allowedActions = [
      'view',
      'copy',
      'download',
      'share',
      'whatsapp_click',
      'training_start',
      'training_complete'
    ];

    if (!allowedActions.includes(action_type)) {
      return res.status(400).json({
        success: false,
        message: 'action_type inválido.'
      });
    }

    const payload = {
      affiliate_id: affiliate_id || null,
      product_id: product_id || null,
      asset_id: asset_id || null,
      message_template_id: message_template_id || null,
      training_module_id: training_module_id || null,
      action_type,
      metadata: metadata || {}
    };

    const inserted = await supabaseRequest('affiliate_asset_actions', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    return res.status(201).json({
      success: true,
      message: 'Ação registrada com sucesso.',
      data: inserted?.[0] || null
    });
  } catch (error) {
    console.error('AFFILIATE MARKETING KIT ACTION ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * POST /api/affiliate/marketing-kit/training/start
 *
 * Marca treinamento como iniciado.
 */
router.post('/training/start', async (req, res) => {
  try {
    const { affiliate_id, training_module_id, product_id } = req.body || {};

    if (!affiliate_id || !training_module_id) {
      return res.status(400).json({
        success: false,
        message: 'affiliate_id e training_module_id são obrigatórios.'
      });
    }

    const payload = {
      affiliate_id,
      training_module_id,
      product_id: product_id || null,
      status: 'in_progress',
      started_at: new Date().toISOString()
    };

    const inserted = await supabaseRequest(
      'affiliate_training_progress?on_conflict=affiliate_id,training_module_id',
      {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(payload)
      }
    );

    await supabaseRequest('affiliate_asset_actions', {
      method: 'POST',
      body: JSON.stringify({
        affiliate_id,
        product_id: product_id || null,
        training_module_id,
        action_type: 'training_start',
        metadata: {}
      })
    });

    return res.json({
      success: true,
      message: 'Treinamento iniciado.',
      data: inserted?.[0] || null
    });
  } catch (error) {
    console.error('AFFILIATE TRAINING START ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

/**
 * POST /api/affiliate/marketing-kit/training/complete
 *
 * Marca treinamento como concluído.
 */
router.post('/training/complete', async (req, res) => {
  try {
    const { affiliate_id, training_module_id, product_id } = req.body || {};

    if (!affiliate_id || !training_module_id) {
      return res.status(400).json({
        success: false,
        message: 'affiliate_id e training_module_id são obrigatórios.'
      });
    }

    const now = new Date().toISOString();

    const payload = {
      affiliate_id,
      training_module_id,
      product_id: product_id || null,
      status: 'completed',
      started_at: now,
      completed_at: now
    };

    const inserted = await supabaseRequest(
      'affiliate_training_progress?on_conflict=affiliate_id,training_module_id',
      {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(payload)
      }
    );

    await supabaseRequest('affiliate_asset_actions', {
      method: 'POST',
      body: JSON.stringify({
        affiliate_id,
        product_id: product_id || null,
        training_module_id,
        action_type: 'training_complete',
        metadata: {}
      })
    });

    return res.json({
      success: true,
      message: 'Treinamento concluído.',
      data: inserted?.[0] || null
    });
  } catch (error) {
    console.error('AFFILIATE TRAINING COMPLETE ERROR:', error);
    return res.status(500).json(normalizeError(error));
  }
});

export default router;