const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function round(value, digits = 0) {
  const factor = 10 ** Math.max(0, digits);
  return Math.round(Number(value || 0) * factor) / factor;
}

function count(profile, eventType) {
  return Number(profile?.effective_signal_strength?.[eventType] || profile?.effective_signal_counts?.[eventType] || 0);
}

function ageMinutesFrom(profile, nowMs) {
  const time = Date.parse(profile?.last_signal_at || "");
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (nowMs - time) / MINUTE_MS);
}

function stagePoints(stageRank) {
  if (stageRank >= 5) return 32;
  if (stageRank >= 4) return 27;
  if (stageRank >= 3) return 21;
  if (stageRank >= 2) return 13;
  if (stageRank >= 1) return 6;
  return 1;
}

function commitmentPoints(profile) {
  const points =
    Math.min(4, count(profile, "product_detail_view") * 1.4) +
    Math.min(5, count(profile, "add_to_cart") * 2.2) +
    Math.min(9, count(profile, "product_add_confirmed") * 6) +
    Math.min(11, count(profile, "buy_now_confirmed") * 8) +
    Math.min(8, count(profile, "checkout_submitted") * 7) +
    Math.min(7, count(profile, "payment_view") * 5) +
    Math.min(5, count(profile, "payment_method_selected") * 4) +
    Math.min(8, count(profile, "checkout_order_created") * 7) +
    Math.min(8, count(profile, "payment_attempt") * 6) +
    Math.min(8, count(profile, "pix_generated") * 7);

  return Math.min(20, points);
}

function recencyPoints(ageMinutes) {
  if (ageMinutes === null) return 0;
  if (ageMinutes <= 5) return 12;
  if (ageMinutes <= 20) return 10;
  if (ageMinutes <= 60) return 8;
  if (ageMinutes <= 3 * 60) return 5;
  if (ageMinutes <= 8 * 60) return 3;
  if (ageMinutes <= 24 * 60) return 1;
  return 0;
}

function inactivityPenalty(ageMinutes) {
  if (ageMinutes === null) return 8;
  if (ageMinutes <= 8 * 60) return 0;
  if (ageMinutes <= 24 * 60) return 4;
  if (ageMinutes <= 72 * 60) return 10;
  if (ageMinutes <= 7 * 24 * 60) return 18;
  return 28;
}

function momentumBasePoints(profile) {
  const current = Number(profile?.current_session_score || 0);
  const historical = Number(profile?.historical_score || 0);
  const effectiveStrength = Number(profile?.current_session_effective_strength || 0);
  const growth = Math.max(0, current - historical);
  return Math.min(9, growth * 0.08 + Math.log1p(Math.max(0, effectiveStrength)) * 1.8);
}

function momentumDecayFactor(ageMinutes) {
  if (ageMinutes === null || !Number.isFinite(ageMinutes)) return 0;
  const age = Math.max(0, ageMinutes);

  if (age <= 10) return 1;
  if (age <= 30) return 1 - ((age - 10) / 20) * 0.4;
  if (age <= 60) return 0.6 - ((age - 30) / 30) * 0.35;
  if (age < 90) return 0.25 - ((age - 60) / 30) * 0.25;
  return 0;
}

function momentumPoints(profile, ageMinutes) {
  return momentumBasePoints(profile) * momentumDecayFactor(ageMinutes);
}

function getLeadTier(score, converted) {
  if (converted) return { key: "converted", label: "Convertido" };
  if (score >= 78) return { key: "hot", label: "Muito quente" };
  if (score >= 58) return { key: "warm", label: "Quente" };
  if (score >= 35) return { key: "engaged", label: "Engajado" };
  if (score >= 18) return { key: "early", label: "Interesse inicial" };
  return { key: "cold", label: "Frio" };
}

function probabilityEstimate(score, confidence, frictionScore, converted) {
  if (converted) return 100;
  const logistic = 1 / (1 + Math.exp(-(score - 58) / 13));
  const confidenceFactor = 0.58 + clamp(confidence, 0, 100) * 0.0042;
  const frictionFactor = Math.max(0.68, 1 - clamp(frictionScore, 0, 10) * 0.035);
  return Math.min(97, Math.max(1, Math.round(logistic * 100 * confidenceFactor * frictionFactor)));
}

function likelihoodBand(probability, converted) {
  if (converted) return { key: "converted", label: "Compra confirmada" };
  if (probability >= 70) return { key: "very_high", label: "Muito alta" };
  if (probability >= 48) return { key: "high", label: "Alta" };
  if (probability >= 25) return { key: "medium", label: "Média" };
  if (probability >= 10) return { key: "low", label: "Baixa" };
  return { key: "very_low", label: "Muito baixa" };
}

function recoveryDecision({ profile, score, ageMinutes }) {
  if (profile?.converted_current_session) {
    return {
      key: "none",
      label: "Sem recuperação",
      urgency_score: 0,
      minimum_wait_minutes: 0,
      eligible_by_behavior: false,
      ready_by_behavior: false,
      next_best_action: "nao_interromper_cliente_convertido",
      reason: "Pagamento já confirmado nesta sessão.",
    };
  }

  const stageRank = Number(profile?.stage?.rank || 0);
  const friction = clamp(profile?.friction_score, 0, 10);
  const age = ageMinutes === null ? Number.POSITIVE_INFINITY : ageMinutes;
  const currentSessionScore = clamp(profile?.current_session_score, 0, 100);

  // Recuperação começa somente quando existe compromisso comercial atual
  // (carrinho ou etapa posterior). Navegação/consideração isolada não entra
  // na fila só por ter histórico antigo ou algum score residual.
  if (stageRank < 2) {
    const coldAndInactive = score < 18 && currentSessionScore < 18 && age >= 90;
    return {
      key: "none",
      label: "Sem recuperação",
      urgency_score: 0,
      minimum_wait_minutes: 0,
      eligible_by_behavior: false,
      ready_by_behavior: false,
      next_best_action: "aguardar_nova_interacao",
      reason: coldAndInactive
        ? "Lead frio, sem compromisso recente e sem atividade atual; histórico antigo não cria oportunidade de recuperação."
        : "Ainda não há compromisso comercial suficiente; aguardar carrinho ou avanço posterior no funil.",
    };
  }

  const minimumWait = stageRank >= 4 ? 5 : stageRank >= 3 ? 3 : 5;

  let urgency = score * 0.45 + stageRank * 8 + friction * 5;
  if (age >= minimumWait && minimumWait > 0) urgency += 12;
  if (age > 2 * 60) urgency += 5;
  if (age > 24 * 60) urgency -= 10;
  urgency = Math.round(clamp(urgency));

  const ready = minimumWait > 0 && age >= minimumWait;
  let key = "low";
  if (ready && stageRank >= 4 && urgency >= 72) key = "critical";
  else if (ready && stageRank >= 3 && urgency >= 58) key = "high";
  else if (ready && stageRank >= 2 && urgency >= 42) key = "medium";

  const labels = {
    critical: "Crítica",
    high: "Alta",
    medium: "Média",
    low: "Baixa",
  };

  let nextBestAction = "observar_comportamento";
  let reason = "Ainda não há compromisso suficiente para recuperação.";

  if (minimumWait > 0 && !ready) {
    nextBestAction = "aguardar_cliente_finalizar";
    reason = `Cliente avançou no funil; aguardar pelo menos ${minimumWait} minutos desde o último sinal antes de considerar recuperação.`;
  } else if (key === "critical" || key === "high") {
    nextBestAction = "priorizar_recuperacao_quando_contato_estiver_disponivel";
    reason = "Intenção forte, avanço de funil e janela comportamental de espera já concluída.";
  } else if (key === "medium") {
    nextBestAction = "manter_na_fila_de_recuperacao";
    reason = "Há sinais de compromisso, mas a prioridade ainda não é máxima.";
  }

  return {
    key,
    label: labels[key],
    urgency_score: urgency,
    minimum_wait_minutes: minimumWait,
    eligible_by_behavior: true,
    ready_by_behavior: ready,
    next_best_action: nextBestAction,
    reason,
  };
}

function buildEvidence(profile, components, ageMinutes) {
  const evidence = [];
  const stageRank = Number(profile?.stage?.rank || 0);

  if (stageRank >= 4) evidence.push("chegou_pagamento");
  else if (stageRank >= 3) evidence.push("avancou_checkout");
  else if (stageRank >= 2) evidence.push("chegou_carrinho");
  else if (stageRank >= 1) evidence.push("explorou_produto");

  if (count(profile, "product_add_confirmed") > 0 || count(profile, "add_to_cart") > 0) {
    evidence.push("adicionou_carrinho");
  }
  if (count(profile, "buy_now_confirmed") > 0) evidence.push("acionou_comprar_agora");
  if (count(profile, "payment_method_selected") > 0) evidence.push("escolheu_pagamento");
  if (count(profile, "pix_generated") > 0) evidence.push("pix_gerado");
  if (Number(profile?.friction_score || 0) > 0) evidence.push("friccao_no_pagamento");
  if (ageMinutes !== null && ageMinutes <= 30 && components.momentum >= 5) evidence.push("intencao_em_aceleracao");
  if (ageMinutes !== null && ageMinutes <= 20) evidence.push("atividade_muito_recente");

  return Array.from(new Set(evidence));
}

export function buildLeadScore(profile = {}, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const converted = Boolean(profile?.converted_current_session);
  const confidence = clamp(profile?.confidence, 0, 100);
  const frictionScore = clamp(profile?.friction_score, 0, 10);
  const ageMinutes = ageMinutesFrom(profile, nowMs);

  if (converted) {
    return {
      version: "lead-score-v3.1.4-observer",
      mode: "observation",
      lead_score: 100,
      tier: getLeadTier(100, true),
      purchase_probability_estimate: 100,
      purchase_likelihood: likelihoodBand(100, true),
      confidence: Math.round(confidence),
      data_quality: confidence >= 70 ? "high" : confidence >= 40 ? "medium" : "low",
      stage: profile?.stage || null,
      last_signal_at: profile?.last_signal_at || null,
      inactivity_minutes: ageMinutes === null ? null : Math.round(ageMinutes),
      recovery_priority: recoveryDecision({ profile, score: 100, ageMinutes }),
      score_components: {
        intent: round(clamp(profile?.score) * 0.42, 2),
        stage: stagePoints(profile?.stage?.rank || 0),
        commitment: 20,
        recency: recencyPoints(ageMinutes),
        momentum: round(momentumPoints(profile, ageMinutes), 2),
        momentum_decay_factor: round(momentumDecayFactor(ageMinutes), 3),
        inactivity_penalty: 0,
        friction_probability_penalty: 0,
      },
      evidence: ["pagamento_confirmado"],
      calibrated_probability: false,
      calibration_note: "Estimativa heurística em observação; ainda não é uma probabilidade estatística calibrada por histórico suficiente da loja.",
      price_affinity_used: false,
      generated_at: new Date(nowMs).toISOString(),
    };
  }

  const components = {
    intent: clamp(profile?.score) * 0.42,
    stage: stagePoints(profile?.stage?.rank || 0),
    commitment: commitmentPoints(profile),
    recency: recencyPoints(ageMinutes),
    momentum: momentumPoints(profile, ageMinutes),
    momentum_decay_factor: momentumDecayFactor(ageMinutes),
    inactivity_penalty: inactivityPenalty(ageMinutes),
  };

  const rawScore =
    components.intent +
    components.stage +
    components.commitment +
    components.recency +
    components.momentum -
    components.inactivity_penalty;

  // Perfis de baixa confiança não são descartados, apenas impedidos de parecer precisos demais.
  const reliabilityFactor = 0.82 + confidence * 0.0018;
  const leadScore = Math.round(clamp(rawScore * reliabilityFactor));
  const purchaseProbability = probabilityEstimate(leadScore, confidence, frictionScore, false);
  const recoveryPriority = recoveryDecision({ profile, score: leadScore, ageMinutes });

  return {
    version: "lead-score-v3.1.4-observer",
    mode: "observation",
    lead_score: leadScore,
    tier: getLeadTier(leadScore, false),
    purchase_probability_estimate: purchaseProbability,
    purchase_likelihood: likelihoodBand(purchaseProbability, false),
    confidence: Math.round(confidence),
    data_quality: confidence >= 70 ? "high" : confidence >= 40 ? "medium" : "low",
    stage: profile?.stage || null,
    intent_score: Math.round(clamp(profile?.score)),
    current_session_intent_score: Math.round(clamp(profile?.current_session_score)),
    historical_intent_score: Math.round(clamp(profile?.historical_score)),
    friction_score: round(frictionScore, 2),
    last_signal_at: profile?.last_signal_at || null,
    inactivity_minutes: ageMinutes === null ? null : Math.round(ageMinutes),
    recovery_priority: recoveryPriority,
    score_components: {
      intent: round(components.intent, 2),
      stage: round(components.stage, 2),
      commitment: round(components.commitment, 2),
      recency: round(components.recency, 2),
      momentum: round(components.momentum, 2),
      momentum_decay_factor: round(components.momentum_decay_factor, 3),
      inactivity_penalty: round(components.inactivity_penalty, 2),
      friction_probability_penalty: round(frictionScore * 3.5, 2),
    },
    evidence: buildEvidence(profile, components, ageMinutes),
    calibrated_probability: false,
    calibration_note: "Estimativa heurística em observação; ainda não é uma probabilidade estatística calibrada por histórico suficiente da loja.",
    price_affinity_used: false,
    generated_at: new Date(nowMs).toISOString(),
  };
}

export function buildLeadScoreOverview(scoredLeads = [], options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const rows = Array.isArray(scoredLeads) ? scoredLeads.filter(Boolean) : [];
  const active = rows.filter((row) => row?.tier?.key !== "converted");

  const countBy = (selector) => {
    const result = {};
    rows.forEach((row) => {
      const key = selector(row);
      if (!key) return;
      result[key] = (result[key] || 0) + 1;
    });
    return result;
  };

  return {
    version: "lead-score-v3.1.4-observer",
    mode: "observation",
    visitors_evaluated: rows.length,
    active_leads: active.length,
    converted: rows.length - active.length,
    average_lead_score: active.length
      ? Math.round(active.reduce((sum, row) => sum + Number(row.lead_score || 0), 0) / active.length)
      : 0,
    average_purchase_probability_estimate: active.length
      ? Math.round(active.reduce((sum, row) => sum + Number(row.purchase_probability_estimate || 0), 0) / active.length)
      : 0,
    tiers: countBy((row) => row?.tier?.key),
    recovery_priorities: countBy((row) => row?.recovery_priority?.key),
    recovery_eligible_leads: active.filter((row) => row?.recovery_priority?.eligible_by_behavior === true).length,
    no_recovery_leads: active.filter((row) => row?.recovery_priority?.eligible_by_behavior !== true).length,
    high_priority_leads: active.filter((row) => ["critical", "high"].includes(row?.recovery_priority?.key)).length,
    hot_leads: active.filter((row) => row?.tier?.key === "hot").length,
    calibrated_probability: false,
    price_affinity_used: false,
    generated_at: new Date(nowMs).toISOString(),
  };
}
