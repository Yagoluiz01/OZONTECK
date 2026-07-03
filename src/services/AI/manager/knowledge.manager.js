import { buildKnowledge } from "../knowledge/index.js";

export async function loadKnowledge(contexts) {
  if (!contexts || contexts.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      company: {
        name: "LEVRA PERFUME",
        system: "Painel Administrativo",
        version: "AI Level 2",
      },
    };
  }

  return await buildKnowledge(contexts);
}