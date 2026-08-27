import { supabaseAdmin } from "../config/supabase.js";
import { normalizeInterestCategory } from "../intelligence/interestTaxonomy.js";
import { evaluateInterestEligibility } from "./customerInterestProfile.service.js";
import {
  buildMarketingPushRecipientKey,
} from "./customerMarketingPush.service.js";
import { getProductInterestNotificationConfig } from "./productInterestNotification.service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanText(value, maxLength = 500) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function chunk(values = [], size = 100) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function normalizeCampaignCategoryKeys(campaign = {}, items = []) {
  return unique([
    ...(Array.isArray(campaign.category_keys) ? campaign.category_keys : []),
    ...items.map((item) => item?.product_snapshot?.category),
    ...items.map((item) => item?.product?.category),
  ].map(normalizeInterestCategory));
}

export function selectMarketingAudience({
  campaign,
  items = [],
  subscriptions = [],
  customerProfiles = [],
  visitorProfiles = [],
  suppressedCustomerIds = [],
  eligibilityConfig = getProductInterestNotificationConfig(),
  nowMs = Date.now(),
} = {}) {
  const audienceMode = cleanText(campaign?.audience_mode, 40) || "smart";
  const discoveryEnabled = campaign?.discovery_enabled !== false;
  const targetCategories = new Set(normalizeCampaignCategoryKeys(campaign, items));
  const suppressed = new Set(
    suppressedCustomerIds.map((value) => cleanText(value, 80).toLowerCase())
  );

  const profilesByRecipient = new Map();
  for (const profile of customerProfiles) {
    const customerId = cleanText(profile?.customer_id, 80).toLowerCase();
    if (!UUID_PATTERN.test(customerId)) continue;
    const key = `customer:${customerId}`;
    if (!profilesByRecipient.has(key)) profilesByRecipient.set(key, []);
    profilesByRecipient.get(key).push(profile);
  }
  for (const profile of visitorProfiles) {
    const visitorId = cleanText(profile?.visitor_id, 180);
    const key = buildMarketingPushRecipientKey({ visitorId });
    if (!key) continue;
    if (!profilesByRecipient.has(key)) profilesByRecipient.set(key, []);
    profilesByRecipient.get(key).push(profile);
  }

  const recipients = new Map();
  for (const subscription of subscriptions) {
    const customerId = cleanText(subscription?.customer_id, 80).toLowerCase();
    const visitorId = cleanText(subscription?.visitor_id, 180);
    const recipientKey = buildMarketingPushRecipientKey({
      customerId: UUID_PATTERN.test(customerId) ? customerId : null,
      visitorId,
    });
    if (!recipientKey) continue;

    if (!recipients.has(recipientKey)) {
      recipients.set(recipientKey, {
        recipientKey,
        customerId: UUID_PATTERN.test(customerId) ? customerId : null,
        visitorId: visitorId || null,
        subscriptions: [],
      });
    }
    recipients.get(recipientKey).subscriptions.push(subscription);
  }

  const selected = [];
  let suppressedRecipients = 0;
  let excludedByInterest = 0;

  for (const recipient of recipients.values()) {
    if (recipient.customerId && suppressed.has(recipient.customerId)) {
      suppressedRecipients += 1;
      continue;
    }

    const evaluatedProfiles = (profilesByRecipient.get(recipient.recipientKey) || [])
      .map((profile) => ({
        profile,
        result: evaluateInterestEligibility(profile, eligibilityConfig, nowMs),
      }))
      .filter((entry) => entry.result.eligible)
      .sort((left, right) => right.result.matchScore - left.result.matchScore);
    const learnedProfiles = evaluatedProfiles;
    const matchingProfile = evaluatedProfiles.find((entry) =>
      targetCategories.has(normalizeInterestCategory(entry.profile.category_key))
    );

    let selectionMode = null;
    let selectedProfile = null;

    if (audienceMode === "all_opted_in" || targetCategories.size === 0) {
      selectionMode = "all_opted_in";
      selectedProfile = matchingProfile || learnedProfiles[0] || null;
    } else if (audienceMode === "category") {
      if (matchingProfile) {
        selectionMode = "category";
        selectedProfile = matchingProfile;
      }
    } else if (matchingProfile) {
      selectionMode = "interest";
      selectedProfile = matchingProfile;
    } else if (learnedProfiles.length === 0 && discoveryEnabled) {
      selectionMode = "discovery";
    }

    if (!selectionMode) {
      excludedByInterest += 1;
      continue;
    }

    selected.push({
      ...recipient,
      selectionMode,
      categoryKey: selectedProfile?.profile?.category_key || null,
      matchScore: Number(selectedProfile?.result?.matchScore || 0),
    });
  }

  return {
    categoryKeys: [...targetCategories],
    uniqueRecipients: recipients.size,
    selectedRecipients: selected.length,
    selectedDevices: selected.reduce(
      (total, recipient) => total + recipient.subscriptions.length,
      0
    ),
    interestRecipients: selected.filter((item) => item.selectionMode === "interest").length,
    discoveryRecipients: selected.filter((item) => item.selectionMode === "discovery").length,
    allOptedInRecipients: selected.filter(
      (item) => item.selectionMode === "all_opted_in"
    ).length,
    categoryRecipients: selected.filter((item) => item.selectionMode === "category").length,
    suppressedRecipients,
    excludedByInterest,
    recipients: selected,
  };
}

async function fetchAllActiveSubscriptions(
  client,
  maxSubscriptions,
  { includeDeliverySecrets = false } = {}
) {
  const pageSize = 500;
  const subscriptions = [];

  for (let from = 0; from < maxSubscriptions; from += pageSize) {
    const to = Math.min(maxSubscriptions - 1, from + pageSize - 1);
    const { data, error } = await client
      .from("customer_marketing_push_subscriptions")
      .select(
        includeDeliverySecrets
          ? "id,customer_id,visitor_id,endpoint,p256dh,auth,user_agent,fail_count,last_seen_at"
          : "id,customer_id,visitor_id,last_seen_at"
      )
      .eq("is_active", true)
      .is("revoked_at", null)
      .order("last_seen_at", { ascending: false })
      .range(from, to);
    if (error) throw error;

    const page = data || [];
    subscriptions.push(...page);
    if (page.length < pageSize) break;
  }

  return subscriptions;
}

async function fetchProfiles(client, table, ownerColumn, ownerIds) {
  if (!ownerIds.length) return [];
  const rows = [];

  for (const values of chunk(ownerIds)) {
    const { data, error } = await client
      .from(table)
      .select(
        `${ownerColumn},category_key,category_label,category_score,confidence,qualifying_signal_count,last_signal_at`
      )
      .in(ownerColumn, values);
    if (error) throw error;
    rows.push(...(data || []));
  }

  return rows;
}

async function fetchSuppressedCustomers(client, customerIds) {
  if (!customerIds.length) return [];
  const ids = [];

  for (const values of chunk(customerIds)) {
    const { data, error } = await client
      .from("customer_marketing_suppressions")
      .select("customer_id")
      .eq("channel", "web_push")
      .in("customer_id", values);
    if (error) throw error;
    ids.push(...(data || []).map((row) => row.customer_id));
  }

  return unique(ids);
}

export async function buildMarketingAudience(
  { campaign, items = [], includeRecipients = false, maxSubscriptions } = {},
  { client = supabaseAdmin } = {}
) {
  const safeLimit = Math.max(
    100,
    Math.min(
      100000,
      Number(maxSubscriptions || process.env.MARKETING_CAMPAIGN_AUDIENCE_LIMIT || 20000)
    )
  );
  const subscriptions = await fetchAllActiveSubscriptions(client, safeLimit, {
    includeDeliverySecrets: includeRecipients,
  });
  const customerIds = unique(
    subscriptions
      .map((item) => cleanText(item.customer_id, 80).toLowerCase())
      .filter((value) => UUID_PATTERN.test(value))
  );
  const visitorIds = unique(
    subscriptions
      .filter((item) => !UUID_PATTERN.test(cleanText(item.customer_id, 80)))
      .map((item) => cleanText(item.visitor_id, 180))
  );

  const [customerProfiles, visitorProfiles, suppressedCustomerIds] = await Promise.all([
    fetchProfiles(client, "customer_interest_profiles", "customer_id", customerIds),
    fetchProfiles(client, "visitor_interest_profiles", "visitor_id", visitorIds),
    fetchSuppressedCustomers(client, customerIds),
  ]);
  const result = selectMarketingAudience({
    campaign,
    items,
    subscriptions,
    customerProfiles,
    visitorProfiles,
    suppressedCustomerIds,
  });

  return {
    ...result,
    activeSubscriptions: subscriptions.length,
    truncated: subscriptions.length >= safeLimit,
    ...(includeRecipients ? {} : { recipients: undefined }),
  };
}
