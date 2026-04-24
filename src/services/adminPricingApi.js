const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api/admin/pricing`
  : "http://localhost:5000/api/admin/pricing";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    const text = await response.text();
    throw new Error(
      `A API da Precificação não retornou JSON. URL: ${API_BASE}${path}. Resposta inicial: ${text.slice(0, 120)}`
    );
  }

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.message || "Erro na requisição.");
  }

  return data;
}

export function getPricingProducts(search = "") {
  const query = search ? `?search=${encodeURIComponent(search)}` : "";
  return request(`/products${query}`);
}

export function getPricingRecords() {
  return request(`/`);
}

export function getPricingByProduct(productId) {
  return request(`/product/${productId}`);
}

export function calculatePricing(payload) {
  return request(`/calculate`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function savePricing(payload) {
  return request(`/save`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function applyPricingToProduct(productId) {
  return request(`/apply/${productId}`, {
    method: "POST",
  });
}