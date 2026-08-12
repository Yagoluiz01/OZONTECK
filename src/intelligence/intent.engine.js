const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_HOURS = 72;

const STAGES = [
  { key: "descoberta", label: "Descoberta", rank: 0 },
  { key: "consideracao", label: "Consideração", rank: 1 },
  { key: "carrinho", label: "Carrinho", rank: 2 },
  { key: "checkout", label: "Checkout", rank: 3 },
  { key: "pagamento", label: "Pagamento", rank: 4 },
  { key: "convertido", label: "Convertido", rank: 5 },
];

const STAGE_BY_KEY = new Map(STAGES.map((stage) => [stage.key, stage]));

const SIGNAL_DEFINITIONS = {
  product_view: { weight: 5, stage: "descoberta", floor: 8, productWeight: 4, categoryWeight: 2 },
  product_detail_view: {
    weight: 18,
    stage: "consideracao",
    floor: 24,
    productWeight: 22,
    categoryWeight: 14,
    repeatableProductSignal: true,
  },
  add_to_cart: { weight: 12, stage: "carrinho", floor: 42, productWeight: 8, categoryWeight: 4 },
  product_add_confirmed: {
    weight: 38,
    stage: "carrinho",
    floor: 55,
    productWeight: 42,
    categoryWeight: 24,
  },
  buy_now_confirmed: {
    weight: 52,
    stage: "carrinho",
    floor: 64,
    productWeight: 50,
    categoryWeight: 28,
  },
  cart_view: { weight: 14, stage: "carrinho", floor: 44 },
  checkout_start: { weight: 16, stage: "checkout", floor: 60 },
  checkout_view: { weight: 25, stage: "checkout", floor: 66 },
  shipping_calculated: { weight: 14, stage: "checkout", floor: 68 },
  shipping_selected: { weight: 20, stage: "checkout", floor: 72 },
  checkout_submitted: { weight: 34, stage: "pagamento", floor: 79 },
  payment_view: { weight: 30, stage: "pagamento", floor: 82 },
  payment_method_selected: { weight: 20, stage: "pagamento", floor: 86 },
  checkout_order_created: { weight: 26, stage: "pagamento", floor: 89 },
  payment_attempt: { weight: 28, stage: "pagamento", floor: 92 },
  pix_generated: { weight: 32, stage: "pagamento", floor: 94 },
  payment_pending: { weight: 22, stage: "pagamento", floor: 90, friction: 1 },
  payment_rejected: { weight: 20, stage: "pagamento", floor: 89, friction: 2 },
  payment_error: { weight: 17, stage: "pagamento", floor: 86, friction: 2 },
  payment_confirmed: { weight: 100, stage: "convertido", floor: 100, converted: true },
  payment_success: { weight: 100, stage: "convertido", floor: 100, converted: true },
  purchase: { weight: 100, stage: "convertido", floor: 100, converted: true },
};

export const INTENT_SIGNAL_EVENT_TYPES = Object.freeze(Object.keys(SIGNAL_DEFINITIONS));

function safeJsonParse(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanText(value, maxLength = 160) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function eventTimeMs(row) {
  const value = Date.parse(row?.created_at || "");
  return Number.isFinite(value) ? value : 0;
}

function recencyFactor(createdAt, nowMs, halfLifeHours = DEFAULT_HALF_LIFE_HOURS) {
  const time = Date.parse(createdAt || "");
  if (!Number.isFinite(time)) return 0.2;
  const ageHours = Math.max(0, (nowMs - time) / HOUR_MS);
  return Math.max(0.12, Math.pow(0.5, ageHours / Math.max(1, halfLifeHours)));
}

function normalizedScore(raw, saturation = 120) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(100, Math.round(100 * (1 - Math.exp(-raw / saturation))));
}

function weightedQuantile(samples = [], quantile = 0.5) {
  const valid = samples
    .filter((sample) => Number.isFinite(sample?.value) && sample.value > 0 && Number.isFinite(sample?.weight) && sample.weight > 0)
    .slice()
    .sort((a, b) => a.value - b.value);

  if (!valid.length) return null;

  const totalWeight = valid.reduce((sum, sample) => sum + sample.weight, 0);
  const target = totalWeight * Math.max(0, Math.min(1, quantile));
  let accumulated = 0;

  for (const sample of valid) {
    accumulated += sample.weight;
    if (accumulated >= target) return Number(sample.value.toFixed(2));
  }

  return Number(valid[valid.length - 1].value.toFixed(2));
}

function getIntentLevel(score) {
  if (score >= 95) return { key: "conversao_imediata", label: "Conversão imediata" };
  if (score >= 80) return { key: "muito_alta", label: "Intenção muito alta" };
  if (score >= 65) return { key: "alta", label: "Intenção alta" };
  if (score >= 45) return { key: "considerando", label: "Considerando compra" };
  if (score >= 20) return { key: "interessado", label: "Interessado" };
  return { key: "explorando", label: "Explorando" };
}

function getStage(stageKey) {
  return STAGE_BY_KEY.get(stageKey) || STAGE_BY_KEY.get("descoberta");
}

function mapValuesSorted(map, mapper, limit) {
  return Array.from(map.values())
    .map(mapper)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""))
    )
    .slice(0, limit);
}

function buildReasonCodes({ signalCounts, topProducts, currentStage, frictionScore, convertedCurrentSession }) {
  const reasons = [];

  if (topProducts.some((product) => product.detail_views >= 2)) reasons.push("revisitou_produto");
  if ((signalCounts.product_add_confirmed || 0) > 0 || (signalCounts.add_to_cart || 0) > 0) {
    reasons.push("adicionou_carrinho");
  }
  if (getStage(currentStage).rank >= getStage("checkout").rank) reasons.push("avancou_checkout");
  if (getStage(currentStage).rank >= getStage("pagamento").rank) reasons.push("chegou_pagamento");
  if (frictionScore > 0) reasons.push("friccao_pagamento");
  if (convertedCurrentSession) reasons.push("compra_confirmada");

  return reasons;
}

function getRecoveryPriority({ score, stage, frictionScore, convertedCurrentSession }) {
  if (convertedCurrentSession) {
    return { key: "none", label: "Não recuperar", reason: "Pagamento confirmado nesta sessão." };
  }

  const stageRank = getStage(stage).rank;

  if (frictionScore >= 2 && score >= 82) {
    return {
      key: "critical",
      label: "Prioridade máxima",
      reason: "Alta intenção com fricção no pagamento.",
    };
  }

  if ((frictionScore > 0 || stageRank >= getStage("pagamento").rank) && score >= 75) {
    return {
      key: "high",
      label: "Prioridade alta",
      reason: "Cliente avançou até pagamento sem confirmação.",
    };
  }

  if (stageRank >= getStage("checkout").rank && score >= 60) {
    return { key: "medium", label: "Prioridade média", reason: "Cliente avançou no checkout." };
  }

  return {
    key: "low",
    label: "Prioridade baixa",
    reason: "Ainda existem poucos sinais de compromisso de compra.",
  };
}

export function buildIntentProfile(rows = [], options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const currentSessionId = cleanText(options.currentSessionId, 180);
  const events = (Array.isArray(rows) ? rows : [])
    .filter((row) => SIGNAL_DEFINITIONS[row?.event_type])
    .slice()
    .sort((a, b) => eventTimeMs(a) - eventTimeMs(b));

  const products = new Map();
  const categories = new Map();
  const paymentMethods = new Map();
  const priceSamples = [];
  const signalCounts = {};
  const productDetailSeenCounts = new Map();

  let weightedActivity = 0;
  let currentSessionFloor = 0;
  let currentStageKey = "descoberta";
  let currentStageRank = 0;
  let frictionScore = 0;
  let convertedCurrentSession = false;
  let lastSignalAt = null;
  let currentSessionSignalCount = 0;

  for (const row of events) {
    const definition = SIGNAL_DEFINITIONS[row.event_type];
    const metadata = safeJsonParse(row.section);
    const productId = cleanText(metadata.product_id || metadata.productId, 180);
    const productName = cleanText(metadata.product_name || metadata.productName, 180);
    const category = cleanText(metadata.category, 120);
    const productValue = Number(metadata.value || 0);
    const paymentMethod = cleanText(metadata.payment_method || metadata.paymentMethod, 80);
    const currentSession = Boolean(currentSessionId && row.session_id === currentSessionId);
    const recent = recencyFactor(row.created_at, nowMs);
    const sessionBoost = currentSession ? 1.28 : 1;

    let repeatBoost = 1;
    if (definition.repeatableProductSignal && productId) {
      const previousViews = productDetailSeenCounts.get(productId) || 0;
      repeatBoost += Math.min(previousViews * 0.18, 0.54);
      productDetailSeenCounts.set(productId, previousViews + 1);
    }

    const contribution = definition.weight * recent * sessionBoost * repeatBoost;
    weightedActivity += contribution;
    signalCounts[row.event_type] = (signalCounts[row.event_type] || 0) + 1;
    lastSignalAt = row.created_at || lastSignalAt;

    if (currentSession) {
      currentSessionSignalCount += 1;
      currentSessionFloor = Math.max(currentSessionFloor, definition.floor || 0);
      const stage = getStage(definition.stage);
      if (stage.rank >= currentStageRank) {
        currentStageRank = stage.rank;
        currentStageKey = stage.key;
      }
      frictionScore += Number(definition.friction || 0);
      if (definition.converted) convertedCurrentSession = true;
    }

    if (productId && definition.productWeight) {
      const current = products.get(productId) || {
        id: productId,
        name: productName || productId,
        category: category || null,
        rawScore: 0,
        detailViews: 0,
        addConfirmed: 0,
        buyNowConfirmed: 0,
        lastSeenAt: null,
      };

      current.name = productName || current.name;
      current.category = category || current.category;
      current.rawScore += definition.productWeight * recent * sessionBoost * repeatBoost;
      if (row.event_type === "product_detail_view") current.detailViews += 1;
      if (row.event_type === "product_add_confirmed") current.addConfirmed += 1;
      if (row.event_type === "buy_now_confirmed") current.buyNowConfirmed += 1;
      if (!current.lastSeenAt || eventTimeMs(row) >= Date.parse(current.lastSeenAt || "")) {
        current.lastSeenAt = row.created_at || current.lastSeenAt;
      }
      products.set(productId, current);

      if (Number.isFinite(productValue) && productValue > 0) {
        priceSamples.push({
          value: productValue,
          weight: Math.max(1, definition.productWeight || definition.weight) * recent * sessionBoost * repeatBoost,
        });
      }
    }

    if (paymentMethod) {
      const methodKey = paymentMethod.toLowerCase();
      const current = paymentMethods.get(methodKey) || { method: paymentMethod, points: 0, signals: 0 };
      current.points += Math.max(1, definition.weight) * recent * sessionBoost;
      current.signals += 1;
      paymentMethods.set(methodKey, current);
    }

    if (category && definition.categoryWeight) {
      const categoryKey = category.toLocaleLowerCase("pt-BR");
      const current = categories.get(categoryKey) || {
        key: categoryKey,
        name: category,
        rawScore: 0,
        signals: 0,
      };
      current.rawScore += definition.categoryWeight * recent * sessionBoost * repeatBoost;
      current.signals += 1;
      categories.set(categoryKey, current);
    }
  }

  const activityScore = normalizedScore(weightedActivity, 115);
  const score = convertedCurrentSession
    ? 100
    : Math.max(0, Math.min(100, Math.round(Math.max(activityScore, currentSessionFloor))));
  const level = getIntentLevel(score);
  const stage = getStage(currentStageKey);

  const topProducts = mapValuesSorted(
    products,
    (product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      score: normalizedScore(product.rawScore, 70),
      detail_views: product.detailViews,
      added_to_cart: product.addConfirmed > 0,
      buy_now: product.buyNowConfirmed > 0,
      last_seen_at: product.lastSeenAt,
    }),
    8
  );

  const topCategories = mapValuesSorted(
    categories,
    (category) => ({
      key: category.key,
      name: category.name,
      score: normalizedScore(category.rawScore, 55),
      signals: category.signals,
    }),
    6
  );

  const paymentPreferenceRows = Array.from(paymentMethods.values()).sort((a, b) => b.points - a.points);
  const paymentPreferenceTotal = paymentPreferenceRows.reduce((sum, item) => sum + item.points, 0);
  const paymentPreference = {
    preferred_method: paymentPreferenceRows[0]?.method || null,
    methods: paymentPreferenceRows.slice(0, 5).map((item) => ({
      method: item.method,
      score: paymentPreferenceTotal > 0 ? Math.round((item.points / paymentPreferenceTotal) * 100) : 0,
      signals: item.signals,
    })),
  };

  const priceAffinity = {
    preferred: weightedQuantile(priceSamples, 0.5),
    range_min: weightedQuantile(priceSamples, 0.25),
    range_max: weightedQuantile(priceSamples, 0.75),
    samples: priceSamples.length,
  };

  const confidence = Math.min(100, Math.round(12 + Math.log1p(events.length) * 18 + Math.min(28, currentSessionSignalCount * 4)));

  const recoveryPriority = getRecoveryPriority({
    score,
    stage: stage.key,
    frictionScore,
    convertedCurrentSession,
  });

  return {
    version: "intent-v1",
    score,
    confidence,
    level,
    stage: { key: stage.key, label: stage.label, rank: stage.rank },
    recovery_priority: recoveryPriority,
    friction_score: Math.min(10, frictionScore),
    converted_current_session: convertedCurrentSession,
    current_session_signals: currentSessionSignalCount,
    signals_analyzed: events.length,
    last_signal_at: lastSignalAt,
    price_affinity: priceAffinity,
    payment_preference: paymentPreference,
    top_products: topProducts,
    top_categories: topCategories,
    reasons: buildReasonCodes({
      signalCounts,
      topProducts,
      currentStage: stage.key,
      frictionScore,
      convertedCurrentSession,
    }),
    signal_counts: signalCounts,
  };
}

export function buildIntentOverview(rows = [], options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const byVisitor = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const visitorId = cleanText(row?.visitor_id, 180);
    if (!visitorId || !SIGNAL_DEFINITIONS[row?.event_type]) continue;
    const list = byVisitor.get(visitorId) || [];
    list.push(row);
    byVisitor.set(visitorId, list);
  }

  const levels = new Map();
  const stages = new Map();
  const recovery = new Map();
  const categories = new Map();
  const products = new Map();
  const profiles = [];

  for (const [visitorId, visitorRows] of byVisitor.entries()) {
    const sorted = visitorRows.slice().sort((a, b) => eventTimeMs(a) - eventTimeMs(b));
    const mostRecent = sorted[sorted.length - 1];
    const profile = buildIntentProfile(sorted, {
      nowMs,
      currentSessionId: mostRecent?.session_id || null,
    });

    profiles.push({ visitor_id: visitorId, ...profile });
    levels.set(profile.level.key, (levels.get(profile.level.key) || 0) + 1);
    stages.set(profile.stage.key, (stages.get(profile.stage.key) || 0) + 1);
    recovery.set(
      profile.recovery_priority.key,
      (recovery.get(profile.recovery_priority.key) || 0) + 1
    );

    for (const category of profile.top_categories.slice(0, 3)) {
      const current = categories.get(category.key) || {
        name: category.name,
        points: 0,
        visitors: 0,
      };
      current.points += category.score;
      current.visitors += 1;
      categories.set(category.key, current);
    }

    for (const product of profile.top_products.slice(0, 3)) {
      const current = products.get(product.id) || {
        id: product.id,
        name: product.name,
        category: product.category,
        points: 0,
        visitors: 0,
      };
      current.points += product.score;
      current.visitors += 1;
      products.set(product.id, current);
    }
  }

  const total = profiles.length;
  const averageScore = total
    ? Math.round(profiles.reduce((sum, profile) => sum + profile.score, 0) / total)
    : 0;

  const highIntent = profiles.filter(
    (profile) => profile.score >= 65 && !profile.converted_current_session
  ).length;
  const urgentRecovery = profiles.filter((profile) =>
    ["critical", "high"].includes(profile.recovery_priority.key)
  ).length;

  return {
    version: "intent-v1",
    visitors_evaluated: total,
    average_intent_score: averageScore,
    high_intent_visitors: highIntent,
    urgent_recovery_visitors: urgentRecovery,
    converted_visitors: profiles.filter((profile) => profile.converted_current_session).length,
    levels: Object.fromEntries(levels),
    stages: Object.fromEntries(stages),
    recovery_priorities: Object.fromEntries(recovery),
    top_categories: Array.from(categories.entries())
      .map(([key, value]) => ({
        key,
        name: value.name,
        score: Math.round(value.points / Math.max(1, value.visitors)),
        visitors: value.visitors,
      }))
      .sort((a, b) => b.score - a.score || b.visitors - a.visitors)
      .slice(0, 10),
    top_products: Array.from(products.values())
      .map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        score: Math.round(product.points / Math.max(1, product.visitors)),
        visitors: product.visitors,
      }))
      .sort((a, b) => b.score - a.score || b.visitors - a.visitors)
      .slice(0, 12),
    generated_at: new Date(nowMs).toISOString(),
  };
}
