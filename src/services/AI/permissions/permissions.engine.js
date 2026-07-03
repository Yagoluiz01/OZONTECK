import { modulePermissions } from "./modules.permissions.js";

export function filterContextsByPermission(
  contexts,
  userPermissions = []
) {
  return contexts.filter((context) => {
    const permission = modulePermissions[context];

    if (!permission) {
      return false;
    }

    return userPermissions.includes(permission);
  });
}