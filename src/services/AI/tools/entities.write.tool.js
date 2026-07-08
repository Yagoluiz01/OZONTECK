import { env } from "../../../config/env.js";

async function callBackendRoute({ method, path, headers = {}, body } = {}) {
  const baseUrl = env.apiBaseUrl || env.backendUrl || "";
  if (!baseUrl) {
    throw new Error("Config ausente: defina env.apiBaseUrl ou env.backendUrl.");
  }
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

function checkPermission({ permissions = [], required } = {}) {
  const isAdmin = permissions.includes("admin");
  const ok = isAdmin || permissions.includes(required);
  return { ok, required, isAdmin };
}

async function affiliatesWriteTool({ permissions = [], operation } = {}) {
  const perm = checkPermission({ permissions, required: "affiliates.manage" });
  if (!perm.ok) {
    const err = new Error("affiliates.write blocked: missing affiliates.manage");
    err.statusCode = 403;
    throw err;
  }
  if (!operation || !["create", "update", "delete"].includes(operation.type)) {
    const err = new Error("Invalid affiliates write operation");
    err.statusCode = 400;
    throw err;
  }
  const payload = operation.payload || {};
  const authToken = operation.authToken || "";
  if (operation.type === "create") {
    const res = await callBackendRoute({
      method: "POST",
      path: "/api/admin/affiliates",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: payload,
    });
    if (!res.ok) throw new Error(res.data?.message || "Erro ao criar afiliado");
    return res.data;
  }
  if (operation.type === "update") {
    const id = payload?.id || operation.id;
    const res = await callBackendRoute({
      method: "PUT",
      path: `/api/admin/affiliates/${encodeURIComponent(String(id))}`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: payload,
    });
    if (!res.ok) throw new Error(res.data?.message || "Erro ao atualizar afiliado");
    return res.data;
  }
  const id = payload?.id || operation.id;
  const res = await callBackendRoute({
    method: "DELETE",
    path: `/api/admin/affiliates/${encodeURIComponent(String(id))}`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw new Error(res.data?.message || "Erro ao excluir afiliado");
  return res.data;
}

async function customersWriteTool({ permissions = [], operation } = {}) {
  const perm = checkPermission({ permissions, required: "customers.manage" });
  if (!perm.ok) {
    const err = new Error("customers.write blocked: missing customers.manage");
    err.statusCode = 403;
    throw err;
  }
  if (!operation || !["create", "update"].includes(operation.type)) {
    const err = new Error("Invalid customers write operation");
    err.statusCode = 400;
    throw err;
  }
  const payload = operation.payload || {};
  const authToken = operation.authToken || "";
  if (operation.type === "create") {
    const res = await callBackendRoute({
      method: "POST",
      path: "/api/admin/customers",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: payload,
    });
    if (!res.ok) throw new Error(res.data?.message || "Erro ao criar cliente");
    return res.data;
  }
  const id = payload?.id || operation.id;
  const res = await callBackendRoute({
    method: "PUT",
    path: `/api/admin/customers/${encodeURIComponent(String(id))}`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: payload,
  });
  if (!res.ok) throw new Error(res.data?.message || "Erro ao atualizar cliente");
  return res.data;
}

async function ordersWriteTool({ permissions = [], operation } = {}) {
  const perm = checkPermission({ permissions, required: "orders.manage" });
  if (!perm.ok) {
    const err = new Error("orders.write blocked: missing orders.manage");
    err.statusCode = 403;
    throw err;
  }
  if (!operation || operation.type !== "update_status") {
    const err = new Error("Invalid orders write operation");
    err.statusCode = 400;
    throw err;
  }
  const payload = operation.payload || {};
  const authToken = operation.authToken || "";
  const orderId = payload?.id || operation.id;
  const status = payload?.status || operation.status;
  if (!orderId || !status) {
    const err = new Error("Order ID and status are required");
    err.statusCode = 400;
    throw err;
  }
  const res = await callBackendRoute({
    method: "PUT",
    path: `/api/orders/${encodeURIComponent(String(orderId))}/status`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: { status },
  });
  if (!res.ok) throw new Error(res.data?.message || "Erro ao atualizar status do pedido");
  return res.data;
}

export async function affiliatesWriteToolWrapper(args) {
  return affiliatesWriteTool(args);
}
export async function customersWriteToolWrapper(args) {
  return customersWriteTool(args);
}
export async function ordersWriteToolWrapper(args) {
  return ordersWriteTool(args);
}