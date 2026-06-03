import {
  congratulateAchievement,
  listAffiliateCommunityAchievements,
} from "../services/affiliateCommunityAchievements.service.js";

function sendError(res, error) {
  const status = Number(error?.statusCode || error?.status || 500);

  return res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    message: error?.message || "Erro na comunidade de conquistas.",
    details: process.env.NODE_ENV === "production" ? undefined : error?.details,
  });
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
