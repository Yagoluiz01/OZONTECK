import { createAdminNotification } from "./adminNotifications.service.js";

function getAffiliateName(affiliate = {}) {
  return (
    affiliate.full_name ||
    affiliate.name ||
    affiliate.email ||
    affiliate.ref_code ||
    "Afiliado"
  );
}

function formatMoneyBR(value) {
  const number = Number(value || 0);

  return number.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export async function notifyAffiliateCreated(application = {}) {
  return createAdminNotification({
    type: "affiliate_application_created",
    title: "Nova solicitação de afiliado",
    message: `${getAffiliateName(application)} enviou uma solicitação para ser afiliado.`,
    entity_type: "affiliate_application",
    entity_id: application.id || null,
    priority: "high",
    metadata: {
      full_name: application.full_name || "",
      email: application.email || "",
      phone: application.phone || "",
      status: application.status || "pending",
      desired_ref_code: application.desired_ref_code || "",
      desired_coupon_code: application.desired_coupon_code || "",
      recruiter_ref_code: application.recruiter_ref_code || "",
      recruiter_affiliate_id: application.recruiter_affiliate_id || null,
    },
  });
}

export async function notifyAffiliateCommissionCreated(affiliate = {}, conversion = {}) {
  return createAdminNotification({
    type: "affiliate_commission_created",
    title: "Comissão de afiliado gerada",
    message: `${getAffiliateName(affiliate)} recebeu uma comissão de ${formatMoneyBR(
      conversion.commission_amount
    )}.`,
    entity_type: "affiliate_conversion",
    entity_id: conversion.id || null,
    priority: "high",
    metadata: {
      affiliate_id: affiliate.id || conversion.affiliate_id || null,
      affiliate_name: getAffiliateName(affiliate),
      affiliate_email: affiliate.email || "",
      order_id: conversion.order_id || null,
      order_number: conversion.order_number || "",
      conversion_type: conversion.conversion_type || "",
      commission_amount: conversion.commission_amount || 0,
      commission_rate: conversion.commission_rate || 0,
      status: conversion.status || "",
    },
  });
}

export async function notifyAffiliateApproved(affiliate = {}) {
  return createAdminNotification({
    type: "affiliate_approved",
    title: "Afiliado aprovado",
    message: `${getAffiliateName(affiliate)} foi aprovado como afiliado OZONTECK.`,
    entity_type: "affiliate",
    entity_id: affiliate.id || affiliate.affiliate_id || null,
    priority: "high",
    metadata: {
      affiliate_id: affiliate.id || affiliate.affiliate_id || null,
      full_name: affiliate.full_name || "",
      email: affiliate.email || "",
      phone: affiliate.phone || "",
      ref_code: affiliate.ref_code || "",
      coupon_code: affiliate.coupon_code || "",
      commission_rate: affiliate.commission_rate || 0,
      status: affiliate.status || "active",
    },
  });
}


export async function notifyAffiliatePayoutPaid(affiliate = {}, payout = {}) {
  return createAdminNotification({
    type: "affiliate_payout_paid",
    title: "Comissão de afiliado paga",
    message: `${getAffiliateName(affiliate)} teve pagamento de comissão registrado no valor de ${formatMoneyBR(
      payout.amount || payout.paid_amount || payout.total_amount
    )}.`,
    entity_type: "affiliate_payout",
    entity_id: payout.id || null,
    priority: "high",
    metadata: {
      affiliate_id: affiliate.id || affiliate.affiliate_id || payout.affiliate_id || null,
      affiliate_name: getAffiliateName(affiliate),
      affiliate_email: affiliate.email || "",
      payout_id: payout.id || null,
      amount: payout.amount || payout.paid_amount || payout.total_amount || 0,
      payment_reference: payout.payment_reference || "",
      receipt_url: payout.receipt_url || payout.receipt_path || "",
      status: payout.status || "paid",
      paid_at: payout.paid_at || payout.created_at || "",
    },
  });
}

export async function notifyAffiliateRejected(application = {}) {
  return createAdminNotification({
    type: "affiliate_rejected",
    title: "Solicitação de afiliado recusada",
    message: `${getAffiliateName(application)} teve a solicitação de afiliado recusada.`,
    entity_type: "affiliate_application",
    entity_id: application.id || null,
    priority: "normal",
    metadata: {
      application_id: application.id || null,
      full_name: application.full_name || "",
      email: application.email || "",
      phone: application.phone || "",
      status: application.status || "rejected",
      desired_ref_code: application.desired_ref_code || "",
      desired_coupon_code: application.desired_coupon_code || "",
      rejected_at: application.rejected_at || application.updated_at || "",
    },
  });
}

export async function notifyAffiliatePasswordReset(affiliate = {}) {
  return createAdminNotification({
    type: "affiliate_password_reset",
    title: "Senha de afiliado redefinida",
    message: `${getAffiliateName(affiliate)} redefiniu ou solicitou redefinição de senha no painel de afiliado.`,
    entity_type: "affiliate",
    entity_id: affiliate.id || affiliate.affiliate_id || null,
    priority: "normal",
    metadata: {
      affiliate_id: affiliate.id || affiliate.affiliate_id || null,
      full_name: affiliate.full_name || "",
      email: affiliate.email || "",
      phone: affiliate.phone || "",
      ref_code: affiliate.ref_code || "",
      status: affiliate.status || "",
      reset_at: affiliate.reset_at || affiliate.updated_at || new Date().toISOString(),
    },
  });
}