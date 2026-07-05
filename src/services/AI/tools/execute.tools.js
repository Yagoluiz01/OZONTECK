import { aiTools } from "./index.js";

export async function executeTools(items = []) {
  // items: [{ tool: 'products_write', args: {...} }] ou ['products_write']
  const result = {};

  const list = Array.isArray(items) ? items : [];

  await Promise.all(
    list.map(async (item) => {
      const name = typeof item === "string" ? item : item?.tool;
      const args = typeof item === "string" ? {} : item?.args || {};

      const tool = aiTools[name];
      if (!tool) return;

      result[name] = await tool(args);
    })
  );

  return result;
}
