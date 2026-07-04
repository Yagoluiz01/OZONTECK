import { productsTool } from "./products.tool.js";
import { financialTool } from "./financial.tool.js";
import { ordersTool } from "./orders.tool.js";
import { customersTool } from "./customers.tool.js";
import { affiliatesTool } from "./affiliates.tool.js";
import { leadsTool } from "./leads.tool.js";
import { dashboardTool } from "./dashboard.tool.js";
import { reportsTool } from "./reports.tool.js";
import { productsWriteToolWrapper } from "./products.write.tool.js";

export const aiTools = {
  products: productsTool,
  products_write: productsWriteToolWrapper,
  financial: financialTool,
  orders: ordersTool,
  customers: customersTool,
  affiliates: affiliatesTool,
  leads: leadsTool,
  dashboard: dashboardTool,
  reports: reportsTool,
};
