import { aiActions } from "./actions/index.js";

export async function dispatchAction({ action, knowledge, message }) {
  const fn = aiActions[action];

  if (!fn) {
    return {
      error: true,
      message: "Ação não encontrada",
    };
  }

  return await fn({ knowledge, message });
}