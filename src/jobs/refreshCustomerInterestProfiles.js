import { refreshCustomerInterestProfilesBatch } from "../services/customerInterestProfile.service.js";

export async function refreshCustomerInterestProfiles(options = {}) {
  return refreshCustomerInterestProfilesBatch(options);
}
