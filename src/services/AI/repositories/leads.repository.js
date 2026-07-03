import { BaseRepository } from "./base.repository.js";

class LeadsRepository extends BaseRepository {
  constructor() {
    super("lead_events");
  }

  async getLeads() {
    return this.findAll();
  }
}

export const leadsRepository = new LeadsRepository();