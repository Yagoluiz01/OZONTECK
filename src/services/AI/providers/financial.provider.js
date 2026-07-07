import { financialRepository } from "../repositories/financial.repository.js";

export async function loadFinancialContext() {
  const transactions = await financialRepository.getTransactions();
  const accountsReceivable = await financialRepository.getAccountsReceivable();
  const accountsPayable = await financialRepository.getAccountsPayable();

  const revenue = transactions
    .filter(t => t.type === "income" || t.type === "receita")
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  const expenses = transactions
    .filter(t => t.type === "expense" || t.type === "despesa")
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  const profit = revenue - expenses;

  const pendingReceivable = accountsReceivable
    .filter(a => a.status === "pending" || a.status === "pendente")
    .reduce((sum, a) => sum + (Number(a.amount) || 0), 0);

  const pendingPayable = accountsPayable
    .filter(a => a.status === "pending" || a.status === "pendente")
    .reduce((sum, a) => sum + (Number(a.amount) || 0), 0);

  return {
    summary: {
      totalTransactions: transactions.length,
      revenue,
      expenses,
      profit,
      pendingReceivable,
      pendingPayable,
      accountsReceivable: accountsReceivable.length,
      accountsPayable: accountsPayable.length,
    },
    transactions: transactions.slice(0, 50),
    accountsReceivable: accountsReceivable.slice(0, 20),
    accountsPayable: accountsPayable.slice(0, 20),
  };
}