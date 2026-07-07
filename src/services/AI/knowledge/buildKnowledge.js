import { loadProductsContext } from "../providers/products.provider.js";
import { loadFinancialContext } from "../providers/financial.provider.js";
import { loadOrdersContext } from "../providers/orders.provider.js";
import { loadCustomersContext } from "../providers/customers.provider.js";
import { loadAffiliatesContext } from "../providers/affiliates.provider.js";
import { loadLeadsContext } from "../providers/leads.provider.js";

const loaders = {
  products: loadProductsContext,
  financial: loadFinancialContext,
  orders: loadOrdersContext,
  customers: loadCustomersContext,
  affiliates: loadAffiliatesContext,
  leads: loadLeadsContext,
};


export async function buildKnowledge(contexts = []) {
  const knowledge = {
    generatedAt: new Date().toISOString(),
  };

  await Promise.all(
    contexts.map(async (context) => {
      const loader = loaders[context];
      if (!loader) return;

      try {
        knowledge[context] = await loader();
      } catch (err) {
        knowledge[context] = {
          error: true,
          message: err.message,
        };
      }
    })
  );

  return knowledge;
}