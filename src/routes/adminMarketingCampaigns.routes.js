import express from "express";

import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/permission.middleware.js";
import {
  cancelMarketingCampaign,
  createMarketingCampaign,
  createMarketingPromotion,
  deleteMarketingCampaign,
  estimateMarketingCampaignAudience,
  getMarketingAutomationSettings,
  getMarketingCampaign,
  getMarketingCampaignAnalytics,
  getMarketingOverview,
  listMarketingCampaigns,
  listMarketingCampaignProducts,
  listMarketingPromotions,
  pauseMarketingCampaign,
  publishMarketingCampaign,
  purgeMarketingCampaignData,
  updateMarketingAutomationSettings,
  updateMarketingCampaign,
} from "../services/marketingCampaign.service.js";
import {
  triggerInlineMarketingCampaignProcessing,
} from "../services/marketingCampaignInlineDispatcher.service.js";

const router = express.Router();

router.use(requireAdminAuth);

function actorId(req) {
  return req.admin?.id || null;
}

router.get(
  "/overview",
  requirePermission("campaigns.analytics"),
  async (req, res, next) => {
    try {
      const overview = await getMarketingOverview({ days: req.query.days });
      return res.json({ success: true, overview });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/automation",
  requirePermission("campaigns.view"),
  async (_req, res, next) => {
    try {
      const automation = await getMarketingAutomationSettings();
      return res.json({ success: true, automation });
    } catch (error) {
      return next(error);
    }
  }
);

router.patch(
  "/automation",
  requirePermission("campaigns.publish"),
  async (req, res, next) => {
    try {
      const automation = await updateMarketingAutomationSettings(req.body || {}, {
        actorId: actorId(req),
      });
      return res.json({
        success: true,
        automation,
        message: "Automação de campanhas atualizada.",
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/promotions",
  requirePermission("campaigns.view"),
  async (req, res, next) => {
    try {
      const promotions = await listMarketingPromotions(req.query || {});
      return res.json({ success: true, promotions });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/promotions",
  requirePermission("promotions.manage"),
  async (req, res, next) => {
    try {
      const promotion = await createMarketingPromotion(req.body || {}, {
        actorId: actorId(req),
      });
      return res.status(201).json({
        success: true,
        promotion,
        message:
          "Promoção salva como rascunho. A ativação depende da validação segura no checkout.",
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/products",
  requirePermission("campaigns.manage"),
  async (req, res, next) => {
    try {
      const products = await listMarketingCampaignProducts({ limit: req.query.limit });
      return res.json({ success: true, products });
    } catch (error) {
      return next(error);
    }
  }
);

router.get("/", requirePermission("campaigns.view"), async (req, res, next) => {
  try {
    const result = await listMarketingCampaigns(req.query || {});
    return res.json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
});

router.post("/", requirePermission("campaigns.manage"), async (req, res, next) => {
  try {
    const campaign = await createMarketingCampaign(req.body || {}, {
      actorId: actorId(req),
    });
    return res.status(201).json({
      success: true,
      campaign,
      message: "Campanha criada como rascunho.",
    });
  } catch (error) {
    return next(error);
  }
});

router.delete(
  "/",
  requirePermission("campaigns.manage"),
  requirePermission("campaigns.publish"),
  async (req, res, next) => {
    try {
      const deleted = await purgeMarketingCampaignData(req.body || {});
      return res.json({
        success: true,
        deleted,
        message: `${Number(deleted.campaigns || 0)} campanha(s) e seus dados operacionais foram excluídos.`,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/:id/estimate",
  requirePermission("campaigns.view"),
  async (req, res, next) => {
    try {
      const estimate = await estimateMarketingCampaignAudience(req.params.id);
      return res.json({ success: true, estimate });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/:id/publish",
  requirePermission("campaigns.publish"),
  async (req, res, next) => {
    try {
      const campaign = await publishMarketingCampaign(req.params.id, req.body || {}, {
        actorId: actorId(req),
      });
      const inlineDispatch =
        campaign.status === "queued"
          ? triggerInlineMarketingCampaignProcessing("admin_publish")
          : { enabled: false, scheduled: false, coalesced: false };
      return res.json({
        success: true,
        campaign,
        inline_dispatch: inlineDispatch,
        message:
          campaign.status === "scheduled"
            ? "Campanha agendada."
            : inlineDispatch.enabled
              ? "Campanha colocada na fila e processamento automático iniciado."
              : "Campanha colocada na fila.",
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/:id/pause",
  requirePermission("campaigns.publish"),
  async (req, res, next) => {
    try {
      const campaign = await pauseMarketingCampaign(req.params.id, {
        actorId: actorId(req),
      });
      return res.json({ success: true, campaign, message: "Campanha pausada." });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/:id/cancel",
  requirePermission("campaigns.publish"),
  async (req, res, next) => {
    try {
      const campaign = await cancelMarketingCampaign(req.params.id, {
        actorId: actorId(req),
      });
      return res.json({ success: true, campaign, message: "Campanha cancelada." });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/:id/analytics",
  requirePermission("campaigns.analytics"),
  async (req, res, next) => {
    try {
      const analytics = await getMarketingCampaignAnalytics(req.params.id);
      return res.json({ success: true, analytics });
    } catch (error) {
      return next(error);
    }
  }
);

router.get("/:id", requirePermission("campaigns.view"), async (req, res, next) => {
  try {
    const campaign = await getMarketingCampaign(req.params.id);
    return res.json({ success: true, campaign });
  } catch (error) {
    return next(error);
  }
});

router.patch(
  "/:id",
  requirePermission("campaigns.manage"),
  async (req, res, next) => {
    try {
      const campaign = await updateMarketingCampaign(req.params.id, req.body || {}, {
        actorId: actorId(req),
      });
      return res.json({ success: true, campaign, message: "Campanha atualizada." });
    } catch (error) {
      return next(error);
    }
  }
);

router.delete(
  "/:id",
  requirePermission("campaigns.manage"),
  async (req, res, next) => {
    try {
      const campaign = await deleteMarketingCampaign(req.params.id);
      return res.json({
        success: true,
        campaign,
        message: "Rascunho excluído permanentemente.",
      });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
