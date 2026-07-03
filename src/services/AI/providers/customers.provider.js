import { customersRepository } from "../repositories/customers.repository.js";

export async function loadCustomersContext() {
  const customers = await customersRepository.getCustomers();

  const active = customers.filter(c => c.status === "active");
  const inactive = customers.filter(c => c.status === "inactive");

  const now = new Date();

  const newCustomers = customers.filter(c => {
    if (!c.created_at) return false;

    const created = new Date(c.created_at);

    return (
      created.getMonth() === now.getMonth() &&
      created.getFullYear() === now.getFullYear()
    );
  });

  return {
    summary: {
      total: customers.length,
      active: active.length,
      inactive: inactive.length,
      newCustomers: newCustomers.length,
    },

    list: customers,
    active,
    inactive,
    newCustomers,
  };
}