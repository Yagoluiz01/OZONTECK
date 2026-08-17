import { supabaseAdmin } from "../config/supabase.js";

const LEAD_TRACKING_RPC = "record_lead_tracking_event";
const LEAD_TRACKING_BATCH_RPC = "record_lead_tracking_events_batch";

function isMissingLeadTrackingRpc(error, rpcName = LEAD_TRACKING_RPC) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return (
    code === "PGRST202" ||
    code === "42883" ||
    (
      message.includes(String(rpcName || "").toLowerCase()) &&
      (message.includes("could not find the function") || message.includes("does not exist"))
    )
  );
}

async function findLeadSession(client, sessionId) {
  const { data, error } = await client
    .from("lead_sessions")
    .select("id")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1);

  return {
    data: Array.isArray(data) && data.length ? data[0] : null,
    error,
  };
}

async function recordLeadTrackingEventLegacy(payload, client) {
  const existing = await findLeadSession(client, payload.session_id);
  if (existing.error) {
    return { ok: false, stage: "session", error: existing.error };
  }

  if (!existing.data?.id) {
    const { error: insertSessionError } = await client.from("lead_sessions").insert([{
      session_id: payload.session_id,
      visitor_id: payload.visitor_id,
      started_at: new Date().toISOString(),
      ended_at: null,
      last_page: payload.page,
      last_section: payload.section,
      duration_seconds: 0,
    }]);

    if (insertSessionError) {
      // Outra requisição pode ter criado a mesma sessão ao mesmo tempo.
      const sessionAfterInsert = await findLeadSession(client, payload.session_id);
      if (sessionAfterInsert.error || !sessionAfterInsert.data?.id) {
        return {
          ok: false,
          stage: "session",
          error: sessionAfterInsert.error || insertSessionError,
        };
      }
    }
  }

  const { error: eventError } = await client.from("lead_events").insert([payload]);
  if (eventError) {
    return { ok: false, stage: "event", error: eventError };
  }

  return { ok: true, mode: "fallback" };
}

// A RPC garante a sessão e grava o evento na mesma transação e viagem ao banco.
// O fallback permite publicar a API antes de executar a migration no Supabase.
export async function recordLeadTrackingEvent(
  payload,
  { client = supabaseAdmin, legacyRecorder = recordLeadTrackingEventLegacy } = {}
) {
  const { error: atomicError } = await client.rpc(LEAD_TRACKING_RPC, {
    p_session_id: payload.session_id,
    p_visitor_id: payload.visitor_id,
    p_event_type: payload.event_type,
    p_page: payload.page,
    p_section: payload.section,
    p_duration_ms: payload.duration_ms,
  });

  if (!atomicError) {
    return { ok: true, mode: "atomic" };
  }

  // Em timeout ou falha de rede, não repetimos para evitar evento duplicado.
  if (!isMissingLeadTrackingRpc(atomicError)) {
    return { ok: false, stage: "event", error: atomicError };
  }

  return legacyRecorder(payload, client);
}


// Agrupa vários eventos em uma única viagem API -> Postgres.
// Se a migration ainda não estiver aplicada, cai para o gravador atômico unitário.
export async function recordLeadTrackingEventsBatch(
  payloads,
  { client = supabaseAdmin } = {}
) {
  const events = Array.isArray(payloads) ? payloads.filter(Boolean).slice(0, 25) : [];
  if (!events.length) return { ok: true, mode: "batch_empty", count: 0 };

  const { data, error } = await client.rpc(LEAD_TRACKING_BATCH_RPC, {
    p_events: events,
  });

  if (!error) {
    return {
      ok: true,
      mode: "batch_atomic",
      count: Number(data) || events.length,
    };
  }

  if (!isMissingLeadTrackingRpc(error, LEAD_TRACKING_BATCH_RPC)) {
    return { ok: false, stage: "batch", error };
  }

  // Compatibilidade: publica a API antes da migration sem perder tracking.
  let recorded = 0;
  for (const payload of events) {
    const result = await recordLeadTrackingEvent(payload, { client });
    if (!result.ok) return result;
    recorded += 1;
  }

  return { ok: true, mode: "batch_fallback", count: recorded };
}
