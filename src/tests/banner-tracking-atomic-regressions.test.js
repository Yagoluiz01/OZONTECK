import test from "node:test";
import assert from "node:assert/strict";

process.env.PORT ||= "5055";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.JWT_SECRET ||= "test-jwt-secret";
process.env.FRONTEND_URL ||= "http://localhost:3000";

const { recordBannerTrackingEvent } = await import("../services/banners.service.js");

const payload = {
  banner_id: "f2546d7a-6fd1-4f80-9e58-79c3964ff894",
  event_type: "impression",
  click_type: null,
  view_duration_ms: null,
  session_id: "test-session",
  timestamp: "2026-08-15T12:00:00.000Z",
  user_agent: "test",
  screen_width: 1920,
  screen_height: 1080,
  viewport_width: 1280,
  viewport_height: 720,
  device_type: "desktop",
  browser: "test",
  os: "test",
  ip_address: "127.0.0.1",
};

function createFakeClient({ atomicError = null, insertError = null, counterError = null } = {}) {
  const calls = [];

  return {
    calls,
    async rpc(name, args) {
      calls.push({ type: "rpc", name, args });
      if (name === "record_banner_tracking_event") {
        return { error: atomicError };
      }
      return { error: counterError };
    },
    from(table) {
      calls.push({ type: "from", table });
      return {
        async insert(value) {
          calls.push({ type: "insert", value });
          return { error: insertError };
        },
      };
    },
  };
}

test("tracking usa somente uma RPC quando a função atômica existe", async () => {
  const client = createFakeClient();
  const result = await recordBannerTrackingEvent(payload, client);

  assert.equal(result.mode, "atomic");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "record_banner_tracking_event");
});

test("tracking usa o fluxo antigo somente quando a RPC ainda não existe", async () => {
  const client = createFakeClient({
    atomicError: {
      code: "PGRST202",
      message: "Could not find the function public.record_banner_tracking_event",
    },
  });

  const result = await recordBannerTrackingEvent(payload, client);

  assert.equal(result.mode, "fallback");
  assert.deepEqual(
    client.calls.map((call) => call.type === "rpc" ? call.name : call.type),
    ["record_banner_tracking_event", "from", "insert", "increment_banner_views"]
  );
});

test("tracking não repete gravação quando a RPC falha por outro motivo", async () => {
  const client = createFakeClient({
    atomicError: { code: "57014", message: "timeout" },
  });

  await assert.rejects(
    () => recordBannerTrackingEvent(payload, client),
    (error) => error.code === "57014"
  );
  assert.equal(client.calls.length, 1);
});
