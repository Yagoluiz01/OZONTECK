import express from "express";
import { requireAdminAuth as requireAuth } from "../middlewares/auth.middleware.js";
import multer from "multer";
import { env } from "../config/env.js";
import {
  listAllCategories,
  listActiveCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  getCategoryProducts,
  updateCategoryProducts,
  uploadCategoryIconController,
} from "../controllers/categories.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const router = express.Router();

// Rotas administrativas (protegidas)
router.get("/", requireAuth, listAllCategories);
router.get("/active", listActiveCategories);
router.get("/:id", requireAuth, getCategory);
router.get("/:id/products", requireAuth, getCategoryProducts);
router.put("/:id/products", requireAuth, updateCategoryProducts);
router.post("/:id/icon", requireAuth, upload.single("icon"), uploadCategoryIconController);
router.post("/", requireAuth, createCategory);
router.put("/:id", requireAuth, updateCategory);
router.delete("/:id", requireAuth, deleteCategory);
router.patch("/reorder", requireAuth, reorderCategories);

export default router;