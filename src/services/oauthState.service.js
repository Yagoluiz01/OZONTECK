import crypto from "crypto";
import { supabaseAdmin } from "../config/supabase.js";

function hashState(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export async function createIntegrationOAuthState({ provider, adminId, ttlMinutes = 10 }) {
  const normalizedProvider = String(provider || "").trim();

  if (!normalizedProvider) {
    const error = new Error("Provider OAuth não informado.");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();

  // Limpeza oportunista: evita crescimento indefinido sem depender de outro job.
  try {
    await supabaseAdmin
      .from("integration_oauth_states")
      .delete()
      .eq("provider", normalizedProvider)
      .lt("expires_at", now);
  } catch (cleanupError) {
    console.warn("[OAUTH_STATE_CLEANUP_ERROR]", cleanupError?.message || cleanupError);
  }

  const rawState = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + Math.max(1, ttlMinutes) * 60 * 1000).toISOString();

  const { error } = await supabaseAdmin.from("integration_oauth_states").insert({
    provider: normalizedProvider,
    token_hash: hashState(rawState),
    admin_id: adminId || null,
    expires_at: expiresAt,
    consumed_at: null,
  });

  if (error) {
    const oauthError = new Error(
      "Não foi possível criar a sessão segura da integração. Aplique sql/security-integrity-hardening.sql."
    );
    oauthError.statusCode = 503;
    oauthError.details = error;
    throw oauthError;
  }

  return rawState;
}

export async function consumeIntegrationOAuthState({ provider, state }) {
  const tokenHash = hashState(state);
  const now = new Date().toISOString();

  if (!state || !provider) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("integration_oauth_states")
    .update({ consumed_at: now })
    .eq("provider", String(provider).trim())
    .eq("token_hash", tokenHash)
    .is("consumed_at", null)
    .gt("expires_at", now)
    .select("id,provider,admin_id,expires_at,consumed_at")
    .maybeSingle();

  if (error) {
    console.error("[OAUTH_STATE_CONSUME_ERROR]", error);
    return null;
  }

  return data || null;
}
