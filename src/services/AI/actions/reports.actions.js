export const reportsActions = {
  getReportsSummary: async ({ knowledge }) => {
    return knowledge.reports ?? {};
  },
};