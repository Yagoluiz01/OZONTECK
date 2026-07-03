import { resolveContexts } from "../router/context.router.js";

export async function getContexts({
  message,
  user,
}) {
  return await resolveContexts({
  message,
  user,
});
}