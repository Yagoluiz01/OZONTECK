import express from "express";
import rateLimit from "express-rate-limit";
import { requireAffiliateAuth } from "../middlewares/affiliateAuth.middleware.js";
import {
  createAffiliateFeedPost,
  listAffiliateFeedPosts,
  toggleAffiliateFeedLike,
} from "../services/affiliateFeed.service.js";

const router = express.Router();

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AFFILIATE_FEED_READ_RATE_LIMIT || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Muitas consultas na comunidade. Aguarde um pouco e tente novamente.",
  },
});

const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.AFFILIATE_FEED_POST_RATE_LIMIT || 8),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Limite de publicações atingido. Aguarde antes de enviar novamente.",
  },
});

const likeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AFFILIATE_FEED_LIKE_RATE_LIMIT || 80),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Muitas curtidas em pouco tempo. Aguarde e tente novamente.",
  },
});

function rejectLargePayload(req, res, next) {
  const contentLength = Number(req.headers["content-length"] || 0);
  const maxBytes = Number(process.env.AFFILIATE_FEED_PAYLOAD_MAX_BYTES || 4 * 1024 * 1024);

  if (contentLength && contentLength > maxBytes) {
    return res.status(413).json({
      success: false,
      message: "Envio muito grande. Reduza a imagem e tente novamente.",
    });
  }

  return next();
}

function sendError(res, error) {
  const statusCode = error.statusCode || error.status || 500;
  const safeMessage = statusCode >= 500 ? "Erro interno no feed dos afiliados." : error.message;

  console.error("AFFILIATE_FEED_ERROR:", error?.message || error);

  return res.status(statusCode).json({
    success: false,
    message: safeMessage || "Erro interno no feed dos afiliados.",
  });
}

router.use(requireAffiliateAuth);

router.get("/", readLimiter, async (req, res) => {
  try {
    const posts = await listAffiliateFeedPosts(req.affiliateId, req.query || {});

    return res.json({
      success: true,
      posts,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/posts", rejectLargePayload, postLimiter, async (req, res) => {
  try {
    const post = await createAffiliateFeedPost(req.affiliate, req.body || {});

    return res.status(201).json({
      success: true,
      message: "Publicação enviada para aprovação.",
      post,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/posts/:postId/like", likeLimiter, async (req, res) => {
  try {
    const result = await toggleAffiliateFeedLike(req.affiliateId, req.params.postId, true);

    return res.json({
      success: true,
      message: "Curtida registrada.",
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.delete("/posts/:postId/like", likeLimiter, async (req, res) => {
  try {
    const result = await toggleAffiliateFeedLike(req.affiliateId, req.params.postId, false);

    return res.json({
      success: true,
      message: "Curtida removida.",
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
