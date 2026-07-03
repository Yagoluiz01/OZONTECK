import { aiTools } from "./index.js";

export async function executeTools(contexts) {
  const result = {};

  await Promise.all(
    contexts.map(async (context) => {
      const tool = aiTools[context];

      if (!tool) return;

      result[context] = await tool();
    })
  );

  return result;
}