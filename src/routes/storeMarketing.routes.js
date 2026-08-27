import express from "express";

import {
  normalizeStoreDestinationUrl,
  registerMarketingCampaignClick,
} from "../services/marketingCampaign.service.js";

const router = express.Router();

router.get("/click/:token", async (req, res, next) => {
  try {
    const click = await registerMarketingCampaignClick({
      token: req.params.token,
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
    });
    const destination = new URL(
      normalizeStoreDestinationUrl(click.destination_url)
    );
    destination.hash = new URLSearchParams({ oz_mkt: req.params.token }).toString();

    res.set({
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });
    return res.redirect(302, destination.toString());
  } catch (error) {
    return next(error);
  }
});

export default router;
