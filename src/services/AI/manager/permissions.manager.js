import { filterContextsByPermission } from "../permissions/index.js";

export function applyPermissions(contexts, user) {
  return filterContextsByPermission(
    contexts,
    user?.permissions || []
  );
}