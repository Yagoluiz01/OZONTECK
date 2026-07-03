import { modulesRegistry } from "./modules.registry.js";

export function getEnabledModules() {
  return Object.values(modulesRegistry).filter(
    (module) => module.enabled
  );
}

export function getModule(id) {
  return modulesRegistry[id] || null;
}

export { modulesRegistry };