import { BaseRepository } from "./base.repository.js";

class ProductsRepository extends BaseRepository {
  constructor() {
    super("products");
  }

  async getProducts() {
    return this.findAll();
  }

  async getSummary() {
    const products = await this.getProducts();

    return {
      total: products.length,
      active: products.filter(p => p.status === "active").length,
      inactive: products.filter(p => p.status === "inactive").length,
    };
  }
}

export const productsRepository = new ProductsRepository();