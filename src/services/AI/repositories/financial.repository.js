import { BaseRepository } from "./base.repository.js";

class FinancialRepository extends BaseRepository {
  constructor() {
    super("financial_transactions");
  }

  async getTransactions() {
    return this.findAll();
  }

  async getAccountsReceivable() {
    return new BaseRepository("accounts_receivable").findAll();
  }

  async getAccountsPayable() {
    return new BaseRepository("accounts_payable").findAll();
  }

  async getFinancialCategories() {
    return new BaseRepository("financial_categories").findAll();
  }
}

export const financialRepository = new FinancialRepository();