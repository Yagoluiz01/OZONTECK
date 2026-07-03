import fs from "fs";
import path from "path";
import { AI_PATHS } from "./ai.alias.js";

export function loadActions() {
  const files = fs.readdirSync(AI_PATHS.actions);

  const actions = {};

  for (const file of files) {
    if (!file.endsWith(".js")) continue;

    const module = await import(path.join(AI_PATHS.actions, file));

    Object.assign(actions, module);
  }

  return actions;
}