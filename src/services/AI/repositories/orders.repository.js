import { BaseRepository } from "./base.repository.js";

class OrdersRepository extends BaseRepository {
  constructor() {
    super("orders");
  }

  async getOrders() {
    return this.findAll();
  }
}

export const ordersRepository = new OrdersRepository();