import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");

test("aceita nomes antigos das variáveis do Mercado Pago no Render", () => {
  const script = `
    const { env } = await import('./src/config/env.js');
    process.stdout.write(JSON.stringify({
      accessToken: env.mercadoPagoAccessToken,
      publicKey: env.mercadoPagoPublicKey,
      webhookSecret: env.mercadoPagoWebhookSecret
    }));
  `;

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: "5000",
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
      SUPABASE_ANON_KEY: "anon-test",
      JWT_SECRET: "jwt-test-secret",
      FRONTEND_URL: "https://store.test",
      MERCADO_PAGO_ACCESS_TOKEN: "",
      MERCADO_PAGO_PUBLIC_KEY: "",
      MERCADO_PAGO_WEBHOOK_SECRET: "",
      MERCADOPAGO_ACCESS_TOKEN: "legacy-access",
      MERCADOPAGO_PUBLIC_KEY: "legacy-public",
      MERCADOPAGO_WEBHOOK_SECRET: "legacy-webhook",
    },
  });

  assert.equal(child.status, 0, child.stderr);
  const jsonStart = child.stdout.lastIndexOf("{");
  const result = JSON.parse(child.stdout.slice(jsonStart));
  assert.deepEqual(result, {
    accessToken: "legacy-access",
    publicKey: "legacy-public",
    webhookSecret: "legacy-webhook",
  });
});
