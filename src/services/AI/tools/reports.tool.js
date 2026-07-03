export async function reportsTool() {
  return {
    generatedAt: new Date().toISOString(),
    status: "ready",
  };
}