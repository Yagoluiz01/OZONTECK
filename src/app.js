import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";

import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import productsRoutes from "./routes/products.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import customersRoutes from "./routes/customers.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import trackingRoutes from "./routes/tracking.routes.js";
import storeRoutes from "./routes/store.routes.js";
import shippingRoutes from "./routes/shipping.routes.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const allowedOrigins = [
  env.frontendUrl,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  null,
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origem não permitida por CORS: ${origin}`));
    },
    credentials: true,
  })
);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(morgan("dev"));
app.use(express.json());

app.use("/labels", express.static(path.join(__dirname, "../public/labels")));

app.use("/api/tracking", trackingRoutes);
app.use("/api/store", storeRoutes);

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "API OZONTECK funcionando",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/shipping", shippingRoutes);
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Rota não encontrada",
  });
});

export default app;