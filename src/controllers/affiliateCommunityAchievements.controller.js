import {
  congratulateAchievement,
  listAffiliateCommunityAchievements,
} from "../services/affiliateCommunityAchievements.service.js";
import { buildPublicApiError } from "../utils/publicApiError.js";

function sendError(res, error) {
  const publicError = buildPublicApiError(error, {
    fallbackMessage: "Erro interno na comunidade de conquistas.",
  });

  console.error("AFFILIATE ACHIEVEMENTS ERROR:", error);

  return res.status(publicError.status).json(publicError.body);
}

export async function listAchievements(req, res) {
  try {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    const result = await listAffiliateCommunityAchievements(req.affiliateId, req.query || {});

    return res.json({
      success: true,
      ...result,
      refreshed_at: new Date().toISOString(),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function congratulate(req, res) {
  try {
    const result = await congratulateAchievement(req.params.achievementId, req.affiliateId);

    return res.json({
      success: true,
      message: "Parabenização registrada.",
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
