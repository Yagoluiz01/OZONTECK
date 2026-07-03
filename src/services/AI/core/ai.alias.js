import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔥 BASE ABSOLUTA DA IA
export const AI_BASE = path.resolve(__dirname, "../");

// 🔥 ALIASES FIXOS (ANTI BREAK IMPORTS)
export const AI_PATHS = {
  actions: path.join(AI_BASE, "actions"),
  core: path.join(AI_BASE, "core"),
  decision: path.join(AI_BASE, "decision"),
  dispatcher: path.join(AI_BASE, "dispatcher"),
  knowledge: path.join(AI_BASE, "knowledge"),
};