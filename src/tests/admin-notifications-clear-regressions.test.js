import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), "utf8");
}

test("rota de limpar notificações exige permissão de edição", async () => {
  const source = await read("routes/adminNotifications.routes.js");

  assert.match(source, /router\.delete\("\/all",\s*requirePermission\("notifications\.edit"\)/);
  assert.match(source, /deleteAllAdminNotifications/);
});

test("serviço limpa todas as notificações e retorna quantidade", async () => {
  const source = await read("services/adminNotifications.service.js");

  assert.match(source, /export async function deleteAllAdminNotifications/);
  assert.match(source, /\.from\("admin_notifications"\)/);
  assert.match(source, /\.delete\(\)/);
  assert.match(source, /deletedCount/);
});
