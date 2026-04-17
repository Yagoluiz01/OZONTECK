import { env } from "../config/env.js";

function getRequiredEnv(name, value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    throw new Error(`Variável obrigatória ausente: ${name}`);
  }

  return normalized;
}

function getSupabaseHeaders() {
  const serviceRoleKey = getRequiredEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    env.supabaseServiceRoleKey
  );

  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

function getSupabaseUrl() {
  return getRequiredEnv("SUPABASE_URL", env.supabaseUrl);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function isTruthy(value) {
  return ["1", "true", "yes", "on", "sim"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function getFiscalConfig() {
  return {
    provider: String(
      process.env.FISCAL_EMITTER_PROVIDER || "stub"
    ).trim().toLowerCase(),
    environment: String(
      process.env.FISCAL_ENVIRONMENT || "homologation"
    ).trim().toLowerCase(),
    allowMockAuthorization: isTruthy(
      process.env.FISCAL_ALLOW_MOCK_AUTHORIZATION || "true"
    )
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);

  return {
    response,
    data
  };
}

export async function getActiveStoreFiscalSettings() {
  const url = new URL(`${getSupabaseUrl()}/rest/v1/store_fiscal_settings`);
  url.searchParams.set("select", "*");
  url.searchParams.set("is_active", "eq.true");
  url.searchParams.set("order", "created_at.asc");
  url.searchParams.set("limit", "1");

  const { response, data } = await fetchJson(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders()
  });

  if (!response.ok) {
    throw new Error("Erro ao consultar configuração fiscal da loja");
  }

  return Array.isArray(data) ? data[0] || null : null;
}

export async function createInvoiceRecord(order, payload = {}) {
  if (!order?.id) {
    throw new Error("Pedido inválido para criar registro de nota");
  }

  const body = [
    {
      order_id: order.id,
      status: String(payload.status || "pending").trim(),
      document_type: String(payload.documentType || "NFe").trim(),
      environment: String(payload.environment || "homologation").trim(),
      access_key: payload.accessKey || null,
      number: payload.number || null,
      series: payload.series || null,
      xml_url: payload.xmlUrl || null,
      pdf_url: payload.pdfUrl || null,
      error_message: payload.errorMessage || null,
      raw_response: payload.rawResponse || null,
      issued_at: payload.issuedAt || null,
      authorized_at: payload.authorizedAt || null
    }
  ];

  const { response, data } = await fetchJson(
    `${getSupabaseUrl()}/rest/v1/invoices`,
    {
      method: "POST",
      headers: {
        ...getSupabaseHeaders(),
        Prefer: "return=representation"
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error("Erro ao criar registro da nota fiscal");
  }

  return Array.isArray(data) ? data[0] || null : data;
}

export async function updateInvoiceRecord(invoiceId, patch = {}) {
  if (!invoiceId) {
    throw new Error("ID da nota não informado");
  }

  const url = new URL(`${getSupabaseUrl()}/rest/v1/invoices`);
  url.searchParams.set("id", `eq.${invoiceId}`);

  const { response, data } = await fetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...getSupabaseHeaders(),
      Prefer: "return=representation"
    },
    body: JSON.stringify(patch)
  });

  if (!response.ok) {
    throw new Error("Erro ao atualizar registro da nota fiscal");
  }

  return Array.isArray(data) ? data[0] || null : data;
}

export async function appendOrderProcessingEvent(orderId, eventType, payload = {}) {
  if (!orderId) {
    throw new Error("orderId não informado para log de processamento");
  }

  const body = [
    {
      order_id: orderId,
      event_type: String(eventType || "invoice_event").trim(),
      status: payload.status || null,
      message: payload.message || null,
      payload: payload.payload || null
    }
  ];

  const { response } = await fetchJson(
    `${getSupabaseUrl()}/rest/v1/order_processing_events`,
    {
      method: "POST",
      headers: getSupabaseHeaders(),
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error("Erro ao registrar evento de processamento do pedido");
  }

  return true;
}

export async function updateOrderInvoiceFields(orderId, patch = {}) {
  if (!orderId) {
    throw new Error("orderId não informado para atualizar pedido");
  }

  const url = new URL(`${getSupabaseUrl()}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${orderId}`);

  const { response, data } = await fetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...getSupabaseHeaders(),
      Prefer: "return=representation"
    },
    body: JSON.stringify(patch)
  });

  if (!response.ok) {
    throw new Error("Erro ao atualizar dados fiscais do pedido");
  }

  return Array.isArray(data) ? data[0] || null : data;
}

function buildCustomerForInvoice(order) {
  return {
    name: String(order?.customer_name || "").trim(),
    email: String(order?.customer_email || "").trim(),
    phone: onlyDigits(order?.customer_phone || ""),
    cpf: onlyDigits(order?.customer_cpf || ""),
    address: {
      zipCode: onlyDigits(order?.shipping_cep || ""),
      street: String(order?.shipping_address || "").trim(),
      number: String(order?.shipping_number || "").trim(),
      complement: String(order?.shipping_complement || "").trim(),
      district: String(order?.shipping_neighborhood || "").trim(),
      city: String(order?.shipping_city || "").trim(),
      state: String(order?.shipping_state || "").trim().toUpperCase()
    }
  };
}

function buildInvoiceItems(items = []) {
  return items.map((item, index) => {
    const quantity = Math.max(1, toNumber(item?.quantity, 1));
    const unitPrice = toNumber(
      item?.unit_price ?? item?.price ?? item?.product?.price,
      0
    );
    const total = Number((quantity * unitPrice).toFixed(2));

    return {
      line: index + 1,
      productId: String(item?.product_id || item?.id || item?.sku || `item-${index + 1}`),
      name: String(
        item?.name ||
          item?.product?.name ||
          item?.title ||
          `Produto ${index + 1}`
      ).trim(),
      sku: String(item?.sku || item?.product?.sku || "").trim(),
      quantity,
      unitPrice: Number(unitPrice.toFixed(2)),
      total
    };
  });
}

function buildInvoicePayload(order, items, fiscalSettings) {
  const customer = buildCustomerForInvoice(order);
  const invoiceItems = buildInvoiceItems(items);

  const total = invoiceItems.reduce((sum, item) => sum + item.total, 0);

  return {
    environment: String(
      fiscalSettings?.invoice_environment ||
        getFiscalConfig().environment ||
        "homologation"
    ).trim(),
    documentType: "NFe",
    order: {
      id: order?.id || null,
      number: String(order?.order_number || "").trim()
    },
    issuer: {
      companyName: String(fiscalSettings?.company_name || "").trim(),
      fantasyName: String(fiscalSettings?.fantasy_name || "").trim(),
      companyDocument: onlyDigits(fiscalSettings?.company_document || ""),
      stateRegister: String(fiscalSettings?.state_register || "").trim(),
      taxRegime: String(fiscalSettings?.tax_regime || "").trim(),
      originAddress: {
        zipCode: onlyDigits(fiscalSettings?.default_origin_zip_code || ""),
        street: String(fiscalSettings?.default_origin_address || "").trim(),
        number: String(fiscalSettings?.default_origin_number || "").trim(),
        complement: String(fiscalSettings?.default_origin_complement || "").trim(),
        district: String(fiscalSettings?.default_origin_district || "").trim(),
        city: String(fiscalSettings?.default_origin_city || "").trim(),
        state: String(fiscalSettings?.default_origin_state || "").trim().toUpperCase()
      }
    },
    customer,
    items: invoiceItems,
    totals: {
      products: Number(total.toFixed(2)),
      invoice: Number(total.toFixed(2))
    }
  };
}

function validateOrderForInvoice(order, items = []) {
  if (!order?.id) {
    throw new Error("Pedido inválido para emissão de nota");
  }

  if (!String(order?.order_number || "").trim()) {
    throw new Error("Pedido sem número para emissão de nota");
  }

  if (!items.length) {
    throw new Error("Pedido sem itens para emissão de nota");
  }

  if (!String(order?.customer_name || "").trim()) {
    throw new Error("Pedido sem nome do cliente");
  }

  if (!String(order?.customer_email || "").trim()) {
    throw new Error("Pedido sem e-mail do cliente");
  }

  if (!onlyDigits(order?.shipping_cep || "")) {
    throw new Error("Pedido sem CEP de entrega");
  }

  if (!String(order?.shipping_address || "").trim()) {
    throw new Error("Pedido sem endereço de entrega");
  }

  if (!String(order?.shipping_number || "").trim()) {
    throw new Error("Pedido sem número do endereço de entrega");
  }

  if (!String(order?.shipping_city || "").trim()) {
    throw new Error("Pedido sem cidade de entrega");
  }

  if (!String(order?.shipping_state || "").trim()) {
    throw new Error("Pedido sem estado de entrega");
  }

  return true;
}

function validateFiscalSettingsForCommercialInvoice(fiscalSettings) {
  if (!fiscalSettings) {
    throw new Error("Configuração fiscal da loja não encontrada");
  }

  if (!String(fiscalSettings?.company_name || "").trim()) {
    throw new Error("Configuração fiscal sem razão social/nome da empresa");
  }

  if (!onlyDigits(fiscalSettings?.company_document || "")) {
    throw new Error("Configuração fiscal sem CNPJ da loja");
  }

  if (!onlyDigits(fiscalSettings?.default_origin_zip_code || "")) {
    throw new Error("Configuração fiscal sem CEP de origem");
  }

  if (!String(fiscalSettings?.default_origin_address || "").trim()) {
    throw new Error("Configuração fiscal sem endereço de origem");
  }

  if (!String(fiscalSettings?.default_origin_number || "").trim()) {
    throw new Error("Configuração fiscal sem número do endereço de origem");
  }

  if (!String(fiscalSettings?.default_origin_city || "").trim()) {
    throw new Error("Configuração fiscal sem cidade de origem");
  }

  if (!String(fiscalSettings?.default_origin_state || "").trim()) {
    throw new Error("Configuração fiscal sem estado de origem");
  }

  return true;
}

async function emitInvoiceWithStub(order, items, fiscalSettings) {
  const config = getFiscalConfig();

  if (!config.allowMockAuthorization) {
    return {
      success: false,
      status: "missing_fiscal_setup",
      error: "Emissor fiscal real ainda não configurado"
    };
  }

  const invoiceNumber = String(
    fiscalSettings?.invoice_next_number || Math.floor(Date.now() / 1000)
  ).trim();

  const invoiceSeries = String(
    fiscalSettings?.invoice_series || "1"
  ).trim();

  const accessKey = `STUB${Date.now()}${String(order?.id || "").replace(/\D/g, "").slice(0, 20)}`.slice(
    0,
    44
  );

  return {
    success: true,
    status: "authorized",
    environment: config.environment,
    documentType: "NFe",
    invoiceKey: accessKey,
    invoiceNumber,
    invoiceSeries,
    xmlUrl: "",
    pdfUrl: "",
    authorizedAt: nowIso(),
    raw: {
      provider: "stub",
      message: "Nota fiscal simulada/autorizada em modo de preparação",
      orderNumber: order?.order_number || null,
      items: buildInvoiceItems(items),
      issuerDocument: onlyDigits(fiscalSettings?.company_document || ""),
      generatedAt: nowIso()
    }
  };
}

async function emitInvoiceWithProvider(order, items, fiscalSettings) {
  const { provider } = getFiscalConfig();

  if (provider === "stub" || provider === "mock") {
    return emitInvoiceWithStub(order, items, fiscalSettings);
  }

  throw new Error(
    `Provider fiscal ainda não implementado: ${provider}`
  );
}

export async function emitInvoiceForOrder(order, items = []) {
  validateOrderForInvoice(order, items);

  const fiscalSettings = await getActiveStoreFiscalSettings();
  const invoicePayload = buildInvoicePayload(order, items, fiscalSettings);

  await appendOrderProcessingEvent(order.id, "invoice_requested", {
    status: "awaiting_invoice",
    message: "Solicitação de emissão fiscal iniciada",
    payload: invoicePayload
  });

  const initialInvoice = await createInvoiceRecord(order, {
    status: "pending",
    documentType: invoicePayload.documentType,
    environment: invoicePayload.environment,
    rawResponse: {
      phase: "created",
      invoicePayload
    }
  });

  try {
    validateFiscalSettingsForCommercialInvoice(fiscalSettings);

    await updateOrderInvoiceFields(order.id, {
      invoice_status: "awaiting_invoice",
      fiscal_document_type: invoicePayload.documentType,
      fiscal_environment: invoicePayload.environment
    });

    const invoiceResult = await emitInvoiceWithProvider(
      order,
      items,
      fiscalSettings
    );

    if (!invoiceResult?.success) {
      await updateInvoiceRecord(initialInvoice.id, {
        status: invoiceResult?.status || "error",
        error_message: invoiceResult?.error || "Erro ao emitir nota fiscal",
        raw_response: invoiceResult?.raw || invoicePayload
      });

      await updateOrderInvoiceFields(order.id, {
        invoice_status: invoiceResult?.status || "error",
        invoice_error: invoiceResult?.error || "Erro ao emitir nota fiscal",
        invoice_raw: invoiceResult?.raw || invoicePayload
      });

      await appendOrderProcessingEvent(order.id, "invoice_error", {
        status: invoiceResult?.status || "error",
        message: invoiceResult?.error || "Erro ao emitir nota fiscal",
        payload: invoiceResult?.raw || invoicePayload
      });

      return {
        success: false,
        status: invoiceResult?.status || "error",
        error: invoiceResult?.error || "Erro ao emitir nota fiscal",
        raw: invoiceResult?.raw || invoicePayload
      };
    }

    const authorizedAt = invoiceResult.authorizedAt || nowIso();

    await updateInvoiceRecord(initialInvoice.id, {
      status: "authorized",
      access_key: invoiceResult.invoiceKey || null,
      number: invoiceResult.invoiceNumber || null,
      series: invoiceResult.invoiceSeries || null,
      xml_url: invoiceResult.xmlUrl || null,
      pdf_url: invoiceResult.pdfUrl || null,
      raw_response: invoiceResult.raw || null,
      issued_at: authorizedAt,
      authorized_at: authorizedAt
    });

    await updateOrderInvoiceFields(order.id, {
      invoice_status: "authorized",
      invoice_key: invoiceResult.invoiceKey || null,
      invoice_number: invoiceResult.invoiceNumber || null,
      invoice_series: invoiceResult.invoiceSeries || null,
      invoice_xml_url: invoiceResult.xmlUrl || null,
      invoice_pdf_url: invoiceResult.pdfUrl || null,
      invoice_error: null,
      invoice_raw: invoiceResult.raw || null,
      invoice_authorized_at: authorizedAt
    });

    await appendOrderProcessingEvent(order.id, "invoice_authorized", {
      status: "authorized",
      message: "Nota fiscal autorizada com sucesso",
      payload: {
        invoiceKey: invoiceResult.invoiceKey || null,
        invoiceNumber: invoiceResult.invoiceNumber || null,
        invoiceSeries: invoiceResult.invoiceSeries || null
      }
    });

    return {
      success: true,
      status: "authorized",
      invoiceKey: invoiceResult.invoiceKey || null,
      invoiceNumber: invoiceResult.invoiceNumber || null,
      invoiceSeries: invoiceResult.invoiceSeries || null,
      xmlUrl: invoiceResult.xmlUrl || null,
      pdfUrl: invoiceResult.pdfUrl || null,
      authorizedAt,
      raw: invoiceResult.raw || null
    };
  } catch (error) {
    const message = error.message || "Erro ao emitir nota fiscal";

    await updateInvoiceRecord(initialInvoice.id, {
      status: "error",
      error_message: message,
      raw_response: {
        phase: "exception",
        message,
        invoicePayload
      }
    });

    await updateOrderInvoiceFields(order.id, {
      invoice_status: "error",
      invoice_error: message,
      invoice_raw: {
        phase: "exception",
        message,
        invoicePayload
      }
    });

    await appendOrderProcessingEvent(order.id, "invoice_error", {
      status: "error",
      message,
      payload: {
        invoicePayload
      }
    });

    return {
      success: false,
      status: "error",
      error: message,
      raw: {
        phase: "exception",
        invoicePayload
      }
    };
  }
}

export async function markOrderAwaitingInvoice(orderId) {
  if (!orderId) {
    throw new Error("orderId não informado");
  }

  const updated = await updateOrderInvoiceFields(orderId, {
    invoice_status: "awaiting_invoice"
  });

  await appendOrderProcessingEvent(orderId, "invoice_waiting", {
    status: "awaiting_invoice",
    message: "Pedido aguardando emissão de nota fiscal"
  });

  return updated;
}