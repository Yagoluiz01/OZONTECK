import { productsActions } from "./products.actions.js";
import { financialActions } from "./financial.actions.js";
import { ordersActions } from "./orders.actions.js";
import { customersActions } from "./customers.actions.js";
import { affiliatesActions } from "./affiliates.actions.js";
import { leadsActions } from "./leads.actions.js";
import { dashboardActions } from "./dashboard.actions.js";
import { reportsActions } from "./reports.actions.js";

export const aiActions = {
  ...productsActions,
  ...financialActions,
  ...ordersActions,
  ...customersActions,
  ...affiliatesActions,
  ...leadsActions,
  ...dashboardActions,
  ...reportsActions,
};