export async function buildKnowledge(contexts = []) {
  const knowledge = {
    generatedAt: new Date().toISOString(),

    company: {
      name: "LEVRA PERFUME",
      system: "Painel Administrativo",
      version: "AI Level 2",
    },
  };

  if (!contexts || contexts.length === 0) {
    return {
      ...knowledge,
      warning: "Nenhum contexto solicitado",
    };
  }

  for (const context of contexts) {
    const loader = loaders[context];

    if (!loader) {
      knowledge[context] = {
        error: true,
        message: "Loader não encontrado",
      };
      continue;
    }

    try {
      const data = await loader();

      knowledge[context] = data ?? {
        empty: true,
      };
    } catch (error) {
      console.error(`[AI CONTEXT ERROR] ${context}`, error);

      knowledge[context] = {
        error: true,
        message: error.message,
      };
    }
  }

  return knowledge;
}