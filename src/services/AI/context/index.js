export async function buildAiContext({ user, company } = {}) {
    return {
        system: "Levra Perfume",
        version: "1.0.0",

        company: company || null,

        user: user || null,

        datetime: new Date().toISOString(),

        modules: [
            "dashboard",
            "produtos",
            "estoque",
            "clientes",
            "financeiro",
            "contas_receber",
            "contas_pagar",
            "pendencias",
            "relatorios",
            "usuarios"
        ]
    };
}