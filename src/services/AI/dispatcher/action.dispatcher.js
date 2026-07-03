import { aiActions } from "./actions/index.js";

export async function dispatchAction({
  action,
  knowledge,
  message,
}) {
  const handler = aiActions[action];

  if (!handler) {
    return null;
  }

  return await handler({
    knowledge,
    message,
  });
}