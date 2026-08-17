import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.PORT ||= "5055";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.JWT_SECRET ||= "test-jwt-secret";
process.env.FRONTEND_URL ||= "http://localhost:3000";

const { recordLeadTrackingEvent, recordLeadTrackingEventsBatch } = await import("../services/tracking.service.js");

const payload = {
  session_id: "test-session",
  visitor_id: "test-visitor",
  event_type: "product_view",
  page: "produto",
  section: "detalhes",
  duration_ms: 1000,
};

function createRpcClient(error = null) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return { error };
    },
  };
}

test("evento de navegação usa uma única RPC quando a função existe", async () => {
  const client = createRpcClient();
  const result = await recordLeadTrackingEvent(payload, { client });

  assert.deepEqual(result, { ok: true, mode: "atomic" });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "record_lead_tracking_event");
});

test("fluxo antigo é usado somente quando a RPC ainda não existe", async () => {
  const client = createRpcClient({
    code: "PGRST202",
    message: "Could not find the function public.record_lead_tracking_event",
  });
  let fallbackCalls = 0;

  const result = await recordLeadTrackingEvent(payload, {
    client,
    legacyRecorder: async (receivedPayload, receivedClient) => {
      fallbackCalls += 1;
      assert.equal(receivedPayload, payload);
      assert.equal(receivedClient, client);
      return { ok: true, mode: "fallback" };
    },
  });

  assert.equal(fallbackCalls, 1);
  assert.deepEqual(result, { ok: true, mode: "fallback" });
});

test("erro incerto não repete a gravação", async () => {
  const client = createRpcClient({ code: "57014", message: "timeout" });
  let fallbackCalls = 0;

  const result = await recordLeadTrackingEvent(payload, {
    client,
    legacyRecorder: async () => {
      fallbackCalls += 1;
      return { ok: true, mode: "fallback" };
    },
  });

  assert.equal(fallbackCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "57014");
});

test("migration usa transação curta e restringe execução à API", async () => {
  const sql = await readFile(
    new URL("../sql/20260815-lead-tracking-atomic.sql", import.meta.url),
    "utf8"
  );

  assert.match(sql, /on conflict \(session_id\) do nothing/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
});


test("lote de tracking usa uma única RPC para vários eventos", async () => {
  const client = createRpcClient();
  const result = await recordLeadTrackingEventsBatch([payload, { ...payload, event_type: "add_to_cart" }], { client });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "batch_atomic");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "record_lead_tracking_events_batch");
  assert.equal(client.calls[0].args.p_events.length, 2);
});

test("migration de escala cria índice quente e RPC em lote protegida", async () => {
  const sql = await readFile(
    new URL("../sql/20260817-store-performance-scale.sql", import.meta.url),
    "utf8"
  );

  assert.match(sql, /visitor_id,\s*event_type,\s*created_at desc/i);
  assert.match(sql, /record_lead_tracking_events_batch/i);
  assert.match(sql, /máximo de 25 eventos por lote/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
});
