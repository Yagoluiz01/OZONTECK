import { affiliatesRepository } from "../repositories/affiliates.repository.js";

export async function loadAffiliatesContext() {
  return await affiliatesRepository.getSummary();
}