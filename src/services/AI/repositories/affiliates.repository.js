import { BaseRepository } from "./base.repository.js";

class AffiliatesRepository extends BaseRepository {
  constructor() {
    super("affiliates");
  }

  async getAll() {
    return this.findAll();
  }
}

export const affiliatesRepository = new AffiliatesRepository();