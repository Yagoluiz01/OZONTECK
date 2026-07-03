import { BaseRepository } from "./base.repository.js";

class CustomersRepository extends BaseRepository {
  constructor() {
    super("customers");
  }

  async getCustomers() {
    return this.findAll();
  }
}

export const customersRepository = new CustomersRepository();