import { leadsRepository } from "../repositories/leads.repository.js";

export async function loadLeadsContext() {
  const leads = await leadsRepository.getLeads();

  const qualified = leads.filter(l => l.status === "qualified");
  const converted = leads.filter(l => l.status === "converted");
  const newLeads = leads.filter(l => l.status === "new");

  const total = leads.length;

  return {
    summary: {
      total,
      qualified: qualified.length,
      converted: converted.length,
      newLeads: newLeads.length,
      conversionRate: total === 0 ? 0 : (converted.length / total) * 100,
    },

    list: leads,
    qualified,
    converted,
    newLeads,
  };
}