import express from "express";
import rateLimit from "express-rate-limit";
import { requireAdminAuth, requireAdminRole } from "../middlewares/auth.middleware.js";
import {
  listAdminAffiliateFeedPosts,
  updateAdminAffiliateFeedPostPin,
  updateAdminAffiliateFeedPostStatus,
} from "../services/affiliateFeed.service.js";
import {
  listAdminAffiliateFeedStories,
  updateAdminAffiliateFeedStoryPin,
  updateAdminAffiliateFeedStoryStatus,
  cleanupExpiredAffiliateFeedStories,
} from "../services/affiliateFeedStories.service.js";

const router = express.Router();

const adminFeedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ADMIN_AFFILIATE_FEED_RATE_LIMIT || 100),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Muitas ações de moderação em pouco tempo. Aguarde e tente novamente.",
  },
});

function sendError(res, error) {
  const statusCode = error.statusCode || error.status || 500;
  const safeMessage = statusCode >= 500 ? "Erro interno na moderação do feed." : error.message;

  console.error("ADMIN_AFFILIATE_FEED_ERROR:", error?.message || error);

  return res.status(statusCode).json({
    success: false,
    message: safeMessage || "Erro interno na moderação do feed.",
  });
}

async function handleStatusAction(req, res, status, defaultReason, successMessage) {
  try {
    const post = await updateAdminAffiliateFeedPostStatus(
      req.params.postId,
      {
        ...(req.body || {}),
        status,
        reason: req.body?.reason || req.body?.rejected_reason || defaultReason,
      },
      req.admin || {}
    );

    return res.json({
      success: true,
      message: successMessage,
      post,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

router.use(requireAdminAuth);
router.use(requireAdminRole);
router.use(adminFeedLimiter);


async function handleStoryStatusAction(req, res, status, defaultReason, successMessage) {
  try {
    const story = await updateAdminAffiliateFeedStoryStatus(
      req.params.storyId,
      {
        ...(req.body || {}),
        status,
        reason: req.body?.reason || req.body?.rejected_reason || defaultReason,
      },
      req.admin || {}
    );

    return res.json({
      success: true,
      message: successMessage,
      story,
    });
  } catch (error) {
    return sendError(res, error);
  }
}


router.post("/stories/cleanup-expired", async (req, res) => {
  try {
    const result = await cleanupExpiredAffiliateFeedStories();

    return res.json({
      success: true,
      message: "Stories expirados removidos.",
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/stories", async (req, res) => {
  try {
    const stories = await listAdminAffiliateFeedStories(req.query || {});

    return res.json({
      success: true,
      stories,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/stories/:storyId/approve", (req, res) => {
  return handleStoryStatusAction(req, res, "approved", "Story aprovado pela moderação.", "Story aprovado.");
});

router.post("/stories/:storyId/reject", (req, res) => {
  return handleStoryStatusAction(req, res, "rejected", "Story recusado pela moderação.", "Story recusado.");
});

router.post("/stories/:storyId/hide", (req, res) => {
  return handleStoryStatusAction(req, res, "hidden", "Story ocultado pela moderação.", "Story ocultado.");
});

router.post("/stories/:storyId/ban", (req, res) => {
  return handleStoryStatusAction(req, res, "banned", "Story banido por violar as regras da comunidade.", "Story banido.");
});

router.post("/stories/:storyId/pin", async (req, res) => {
  try {
    const story = await updateAdminAffiliateFeedStoryPin(req.params.storyId, { is_pinned: true });

    return res.json({
      success: true,
      message: "Story fixado no topo.",
      story,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/stories/:storyId/unpin", async (req, res) => {
  try {
    const story = await updateAdminAffiliateFeedStoryPin(req.params.storyId, { is_pinned: false });

    return res.json({
      success: true,
      message: "Story removido do topo.",
      story,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/posts", async (req, res) => {
  try {
    const posts = await listAdminAffiliateFeedPosts(req.query || {});

    return res.json({
      success: true,
      posts,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.patch("/posts/:postId/status", async (req, res) => {
  try {
    const post = await updateAdminAffiliateFeedPostStatus(
      req.params.postId,
      req.body || {},
      req.admin || {}
    );

    return res.json({
      success: true,
      message: "Status da publicação atualizado.",
      post,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/posts/:postId/approve", (req, res) => {
  return handleStatusAction(req, res, "approved", "Publicação aprovada pela moderação.", "Publicação aprovada.");
});

router.post("/posts/:postId/reject", (req, res) => {
  return handleStatusAction(req, res, "rejected", "Publicação recusada pela moderação.", "Publicação recusada.");
});

router.post("/posts/:postId/hide", (req, res) => {
  return handleStatusAction(req, res, "hidden", "Publicação ocultada pela moderação.", "Publicação ocultada.");
});

router.post("/posts/:postId/ban", (req, res) => {
  return handleStatusAction(req, res, "banned", "Publicação banida por violar as regras da comunidade.", "Publicação banida.");
});

router.patch("/posts/:postId/pin", async (req, res) => {
  try {
    const post = await updateAdminAffiliateFeedPostPin(req.params.postId, req.body || {});

    return res.json({
      success: true,
      message: post.is_pinned ? "Publicação fixada no topo." : "Publicação desafixada.",
      post,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/posts/:postId/pin", async (req, res) => {
  try {
    const post = await updateAdminAffiliateFeedPostPin(req.params.postId, { is_pinned: true });

    return res.json({
      success: true,
      message: "Publicação fixada no topo.",
      post,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/posts/:postId/unpin", async (req, res) => {
  try {
    const post = await updateAdminAffiliateFeedPostPin(req.params.postId, { is_pinned: false });

    return res.json({
      success: true,
      message: "Publicação removida do topo.",
      post,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.delete("/posts/:postId", (req, res) => {
  return handleStatusAction(req, res, "banned", "Publicação banida pela moderação.", "Publicação banida.");
});

export default router;
