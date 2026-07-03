import { productsTool } from "./products.tool.js";
import { customersTool } from "./customers.tool.js";
import { ordersTool } from "./orders.tool.js";
import { financialTool } from "./financial.tool.js";
import { affiliatesTool } from "./affiliates.tool.js";

export async function dashboardTool() {
  const [
    products,
    customers,
    orders,
    financial,
    affiliates,
  ] = await Promise.all([
    productsTool(),
    customersTool(),
    ordersTool(),
    financialTool(),
    affiliatesTool(),
  ]);

  return {
    products,
    customers,
    orders,
    financial,
    affiliates,
  };
}