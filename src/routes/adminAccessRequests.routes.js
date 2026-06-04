import express from "express";

import { supabaseAdmin } from "../config/supabase.js";
import { env } from "../config/env.js";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { createAdminNotification } from "../services/adminNotifications.service.js";

const router = express.Router();

const REQUEST_STATUSES = new Set(["pending", "approved", "rejected"]);
const ALLOWED_ROLES = new Set(["administrator", "admin", "manager"]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function getMasterEmails() {
  const raw =
    process.env.MASTER_ADMIN_EMAIL ||
    process.env.MASTER_ADMIN_EMAILS ||
    process.env.ADMIN_MASTER_EMAIL ||
    "";

  return String(raw || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

function isMasterAdmin(admin = {}) {
  const adminEmail = normalizeEmail(admin.email);
  const masterEmails = getMasterEmails();

  if (masterEmails.length > 0) {
    return masterEmails.includes(adminEmail);
  }

  const role = String(admin.role || "").toLowerCase();
  return ["master", "owner", "super_admin", "superadmin"].includes(role);
}

function requireMasterAdmin(req, res, next) {
  if (!req.admin) {
    return res.status(401).json({
      success: false,
      message: "Administrador não autenticado.",
    });
  }

  if (!isMasterAdmin(req.admin)) {
    return res.status(403).json({
      success: false,
      message: "Apenas o administrador master pode aprovar ou recusar acessos.",
    });
  }

  return next();
}

async function findAdminByEmail(email) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/get_admin_by_email`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_email: email }),
  });

  const text = await response.text();
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error("Erro ao consultar usuário administrador.");
  }

  if (Array.isArray(data)) {
    return data[0] || null;
  }

  return data || null;
}

async function findAdminsByEmails(emails = []) {
  const uniqueEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))];

  if (uniqueEmails.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("admins")
    .select("id,full_name,email,role,is_active,created_at,updated_at")
    .in("email", uniqueEmails);

  if (error) {
    console.error("[ADMIN_ACCESS_ADMINS_LOOKUP_ERROR]", error);
    throw new Error("Erro ao consultar administradores vinculados.");
  }

  return Array.isArray(data) ? data : [];
}

function getPlainMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function buildRequestWithAdminStatus(request, adminByEmail) {
  const email = normalizeEmail(request?.email);
  const admin = adminByEmail.get(email) || null;

  let adminAccessStatus = null;

  if (admin) {
    adminAccessStatus = admin.is_active === false ? "banned" : "active";
  } else if (String(request?.status || "").toLowerCase() === "approved") {
    adminAccessStatus = "removed";
  }

  return {
    ...request,
    admin: admin
      ? {
          id: admin.id,
          full_name: admin.full_name,
          email: admin.email,
          role: admin.role,
          is_active: admin.is_active,
          created_at: admin.created_at,
          updated_at: admin.updated_at,
        }
      : null,
    admin_access_status: adminAccessStatus,
  };
}

async function getAccessRequestById(requestId) {
  const { data: request, error } = await supabaseAdmin
    .from("admin_access_requests")
    .select("*")
    .eq("id", requestId)
    .single();

  if (error || !request) {
    return null;
  }

  return request;
}

function assertNotSelfTarget(req, email) {
  const targetEmail = normalizeEmail(email);
  const currentEmail = normalizeEmail(req.admin?.email);

  if (targetEmail && currentEmail && targetEmail === currentEmail) {
    return "Você não pode banir, reativar ou excluir seu próprio acesso master.";
  }

  return null;
}

function validatePassword(password) {
  const value = String(password || "");

  if (value.length < 8) {
    return "A senha precisa ter pelo menos 8 caracteres.";
  }

  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return "A senha precisa ter letras e números.";
  }

  return null;
}

router.post("/auth/admin-register-request", async (req, res, next) => {
  try {
    const fullName = normalizeName(req.body?.full_name || req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirm_password || req.body?.confirmPassword || "");

    if (!fullName || fullName.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Informe o nome completo.",
      });
    }

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        success: false,
        message: "Informe um e-mail válido.",
      });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        message: passwordError,
      });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "A confirmação de senha não confere.",
      });
    }

    const existingAdmin = await findAdminByEmail(email);
    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message: "Este e-mail já possui acesso administrativo.",
      });
    }

    const { data: existingRequest, error: existingRequestError } = await supabaseAdmin
      .from("admin_access_requests")
      .select("id,status")
      .eq("email", email)
      .in("status", ["pending", "approved"])
      .maybeSingle();

    if (existingRequestError) {
      console.error("[ADMIN_ACCESS_REQUEST_LOOKUP_ERROR]", existingRequestError);
      throw new Error("Erro ao verificar solicitação existente.");
    }

    if (existingRequest?.status === "pending") {
      return res.status(409).json({
        success: false,
        message: "Já existe uma solicitação pendente para este e-mail.",
      });
    }

    if (existingRequest?.status === "approved") {
      return res.status(409).json({
        success: false,
        message: "Este e-mail já possui uma solicitação aprovada.",
      });
    }

    const { data: authUserData, error: authUserError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        admin_access_status: "pending",
      },
    });

    if (authUserError || !authUserData?.user?.id) {
      console.error("[ADMIN_ACCESS_AUTH_CREATE_ERROR]", authUserError);

      const message = String(authUserError?.message || "").toLowerCase();
      if (message.includes("already") || message.includes("registered") || message.includes("exists")) {
        return res.status(409).json({
          success: false,
          message: "Este e-mail já existe no sistema. Peça ao administrador master para revisar o acesso.",
        });
      }

      throw new Error("Erro ao criar usuário de autenticação.");
    }

    const insertPayload = {
      full_name: fullName,
      email,
      auth_user_id: authUserData.user.id,
      requested_role: "administrator",
      status: "pending",
      auth_user_created_by_request: true,
      metadata: {
        source: "admin_login_register_button",
      },
    };

    const { data: request, error: insertError } = await supabaseAdmin
      .from("admin_access_requests")
      .insert(insertPayload)
      .select("*")
      .single();

    if (insertError) {
      console.error("[ADMIN_ACCESS_REQUEST_INSERT_ERROR]", insertError);

      await supabaseAdmin.auth.admin.deleteUser(authUserData.user.id).catch((deleteError) => {
        console.error("[ADMIN_ACCESS_AUTH_ROLLBACK_ERROR]", deleteError);
      });

      throw new Error("Erro ao salvar solicitação de acesso.");
    }

    await createAdminNotification({
      type: "admin_access_request",
      title: "Nova solicitação de acesso administrativo",
      message: `${fullName} solicitou acesso ao painel administrativo.`,
      entity_type: "admin_access_request",
      entity_id: request.id,
      priority: "high",
      metadata: {
        request_id: request.id,
        full_name: fullName,
        email,
        status: "pending",
      },
    });

    return res.status(201).json({
      success: true,
      message: "Solicitação enviada com sucesso. Aguarde aprovação do administrador master.",
      request: {
        id: request.id,
        full_name: request.full_name,
        email: request.email,
        status: request.status,
        created_at: request.created_at,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/access-requests", requireAdminAuth, requireMasterAdmin, async (req, res, next) => {
  try {
    const status = String(req.query.status || "pending").toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);

    let query = supabaseAdmin
      .from("admin_access_requests")
      .select("id,full_name,email,auth_user_id,requested_role,status,rejection_reason,reviewed_at,reviewed_by,created_at,updated_at,metadata")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (REQUEST_STATUSES.has(status)) {
      query = query.eq("status", status);
    }

    if (status === "all") {
      query = supabaseAdmin
        .from("admin_access_requests")
        .select("id,full_name,email,auth_user_id,requested_role,status,rejection_reason,reviewed_at,reviewed_by,created_at,updated_at,metadata")
        .order("created_at", { ascending: false })
        .limit(limit);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[ADMIN_ACCESS_REQUEST_LIST_ERROR]", error);
      throw new Error("Erro ao listar solicitações.");
    }

    const adminRows = await findAdminsByEmails((data || []).map((request) => request.email));
    const adminByEmail = new Map(adminRows.map((admin) => [normalizeEmail(admin.email), admin]));
    const requests = (data || []).map((request) => buildRequestWithAdminStatus(request, adminByEmail));

    return res.json({
      success: true,
      requests,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/access-requests/:id/approve", requireAdminAuth, requireMasterAdmin, async (req, res, next) => {
  try {
    const requestId = req.params.id;
    const requestedRole = String(req.body?.role || "administrator").toLowerCase();
    const role = ALLOWED_ROLES.has(requestedRole) ? requestedRole : "administrator";

    const { data: request, error: requestError } = await supabaseAdmin
      .from("admin_access_requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (requestError || !request) {
      return res.status(404).json({
        success: false,
        message: "Solicitação não encontrada.",
      });
    }

    if (request.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Essa solicitação já foi analisada.",
      });
    }

    const email = normalizeEmail(request.email);
    const fullName = normalizeName(request.full_name);

    const existingAdmin = await findAdminByEmail(email);
    let admin = existingAdmin;

    if (!admin) {
      const adminPayload = {
        full_name: fullName,
        email,
        role,
        is_active: true,
      };

      // Em muitos projetos Supabase, a tabela admins usa o mesmo UUID do auth.users.
      // Sem enviar esse id, a inserção pode falhar com 500 na aprovação.
      if (request.auth_user_id) {
        adminPayload.id = request.auth_user_id;
      }

      const { data: insertedAdmin, error: adminInsertError } = await supabaseAdmin
        .from("admins")
        .insert(adminPayload)
        .select("*")
        .single();

      if (adminInsertError) {
        console.error("[ADMIN_ACCESS_ADMIN_INSERT_ERROR]", {
          code: adminInsertError.code,
          message: adminInsertError.message,
          details: adminInsertError.details,
          hint: adminInsertError.hint,
          email,
          auth_user_id: request.auth_user_id || null,
        });

        // Se já existir algum registro em admins para este e-mail, reativamos em vez de quebrar.
        if (adminInsertError.code === "23505" || String(adminInsertError.message || "").toLowerCase().includes("duplicate")) {
          const { data: recoveredAdmin, error: recoverError } = await supabaseAdmin
            .from("admins")
            .update({
              full_name: fullName,
              role,
              is_active: true,
            })
            .eq("email", email)
            .select("*")
            .maybeSingle();

          if (recoverError || !recoveredAdmin) {
            console.error("[ADMIN_ACCESS_ADMIN_RECOVER_ERROR]", recoverError);
            throw new Error("Erro ao liberar acesso administrativo.");
          }

          admin = recoveredAdmin;
        } else {
          throw new Error("Erro ao liberar acesso administrativo.");
        }
      } else {
        admin = insertedAdmin;
      }
    }

    const { data: updatedRequest, error: updateError } = await supabaseAdmin
      .from("admin_access_requests")
      .update({
        status: "approved",
        requested_role: role,
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.admin.id,
        rejection_reason: null,
      })
      .eq("id", requestId)
      .select("*")
      .single();

    if (updateError) {
      console.error("[ADMIN_ACCESS_REQUEST_APPROVE_ERROR]", updateError);
      throw new Error("Erro ao atualizar solicitação aprovada.");
    }

    if (request.auth_user_id) {
      await supabaseAdmin.auth.admin.updateUserById(request.auth_user_id, {
        user_metadata: {
          full_name: fullName,
          admin_access_status: "approved",
        },
      }).catch((metadataError) => {
        console.error("[ADMIN_ACCESS_AUTH_METADATA_APPROVE_ERROR]", metadataError);
      });
    }

    await createAdminNotification({
      type: "admin_access_approved",
      title: "Acesso administrativo aprovado",
      message: `${fullName} foi aprovado como administrador.`,
      entity_type: "admin_access_request",
      entity_id: requestId,
      priority: "normal",
      metadata: {
        request_id: requestId,
        admin_id: admin?.id || null,
        email,
        approved_by: req.admin.email,
      },
    });

    return res.json({
      success: true,
      message: "Administrador aprovado com sucesso.",
      request: updatedRequest,
      admin,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/access-requests/:id/ban", requireAdminAuth, requireMasterAdmin, async (req, res, next) => {
  try {
    const requestId = req.params.id;
    const request = await getAccessRequestById(requestId);

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Solicitação não encontrada.",
      });
    }

    if (String(request.status || "").toLowerCase() !== "approved") {
      return res.status(409).json({
        success: false,
        message: "Só administradores aprovados podem ser banidos.",
      });
    }

    const email = normalizeEmail(request.email);
    const selfError = assertNotSelfTarget(req, email);
    if (selfError) {
      return res.status(400).json({ success: false, message: selfError });
    }

    const admin = await findAdminByEmail(email);
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Este usuário não possui acesso administrativo ativo para banir.",
      });
    }

    const { data: bannedAdmin, error: banError } = await supabaseAdmin
      .from("admins")
      .update({ is_active: false })
      .eq("email", email)
      .select("*")
      .maybeSingle();

    if (banError || !bannedAdmin) {
      console.error("[ADMIN_ACCESS_BAN_ERROR]", banError);
      throw new Error("Erro ao banir administrador.");
    }

    const metadata = {
      ...getPlainMetadata(request.metadata),
      admin_access_status: "banned",
      banned_at: new Date().toISOString(),
      banned_by: req.admin.email,
    };

    const { data: updatedRequest, error: updateError } = await supabaseAdmin
      .from("admin_access_requests")
      .update({ metadata })
      .eq("id", requestId)
      .select("*")
      .single();

    if (updateError) {
      console.error("[ADMIN_ACCESS_BAN_REQUEST_UPDATE_ERROR]", updateError);
      throw new Error("Administrador banido, mas houve erro ao atualizar a solicitação.");
    }

    if (request.auth_user_id) {
      await supabaseAdmin.auth.admin.updateUserById(request.auth_user_id, {
        user_metadata: {
          full_name: request.full_name,
          admin_access_status: "banned",
        },
      }).catch((metadataError) => {
        console.error("[ADMIN_ACCESS_AUTH_METADATA_BAN_ERROR]", metadataError);
      });
    }

    await createAdminNotification({
      type: "admin_access_banned",
      title: "Administrador banido",
      message: `${request.full_name} teve o acesso administrativo bloqueado.`,
      entity_type: "admin_access_request",
      entity_id: requestId,
      priority: "high",
      metadata: {
        request_id: requestId,
        admin_id: bannedAdmin.id,
        email,
        banned_by: req.admin.email,
      },
    });

    return res.json({
      success: true,
      message: "Administrador banido com sucesso.",
      request: buildRequestWithAdminStatus(updatedRequest, new Map([[email, bannedAdmin]])),
      admin: bannedAdmin,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/access-requests/:id/unban", requireAdminAuth, requireMasterAdmin, async (req, res, next) => {
  try {
    const requestId = req.params.id;
    const request = await getAccessRequestById(requestId);

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Solicitação não encontrada.",
      });
    }

    if (String(request.status || "").toLowerCase() !== "approved") {
      return res.status(409).json({
        success: false,
        message: "Só administradores aprovados podem ser reativados.",
      });
    }

    const email = normalizeEmail(request.email);
    const admin = await findAdminByEmail(email);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Este acesso foi removido. Para liberar novamente, crie uma nova solicitação.",
      });
    }

    const { data: activeAdmin, error: unbanError } = await supabaseAdmin
      .from("admins")
      .update({ is_active: true })
      .eq("email", email)
      .select("*")
      .maybeSingle();

    if (unbanError || !activeAdmin) {
      console.error("[ADMIN_ACCESS_UNBAN_ERROR]", unbanError);
      throw new Error("Erro ao reativar administrador.");
    }

    const metadata = {
      ...getPlainMetadata(request.metadata),
      admin_access_status: "active",
      unbanned_at: new Date().toISOString(),
      unbanned_by: req.admin.email,
    };

    const { data: updatedRequest, error: updateError } = await supabaseAdmin
      .from("admin_access_requests")
      .update({ metadata })
      .eq("id", requestId)
      .select("*")
      .single();

    if (updateError) {
      console.error("[ADMIN_ACCESS_UNBAN_REQUEST_UPDATE_ERROR]", updateError);
      throw new Error("Administrador reativado, mas houve erro ao atualizar a solicitação.");
    }

    if (request.auth_user_id) {
      await supabaseAdmin.auth.admin.updateUserById(request.auth_user_id, {
        user_metadata: {
          full_name: request.full_name,
          admin_access_status: "approved",
        },
      }).catch((metadataError) => {
        console.error("[ADMIN_ACCESS_AUTH_METADATA_UNBAN_ERROR]", metadataError);
      });
    }

    await createAdminNotification({
      type: "admin_access_unbanned",
      title: "Administrador reativado",
      message: `${request.full_name} teve o acesso administrativo reativado.`,
      entity_type: "admin_access_request",
      entity_id: requestId,
      priority: "normal",
      metadata: {
        request_id: requestId,
        admin_id: activeAdmin.id,
        email,
        unbanned_by: req.admin.email,
      },
    });

    return res.json({
      success: true,
      message: "Administrador reativado com sucesso.",
      request: buildRequestWithAdminStatus(updatedRequest, new Map([[email, activeAdmin]])),
      admin: activeAdmin,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/access-requests/:id/delete", requireAdminAuth, requireMasterAdmin, async (req, res, next) => {
  try {
    const requestId = req.params.id;
    const request = await getAccessRequestById(requestId);

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Solicitação não encontrada.",
      });
    }

    const email = normalizeEmail(request.email);
    const selfError = assertNotSelfTarget(req, email);
    if (selfError) {
      return res.status(400).json({ success: false, message: selfError });
    }

    const admin = await findAdminByEmail(email);

    if (admin) {
      const { error: deleteAdminError } = await supabaseAdmin
        .from("admins")
        .delete()
        .eq("email", email);

      if (deleteAdminError) {
        console.error("[ADMIN_ACCESS_DELETE_ADMIN_ERROR]", deleteAdminError);
        throw new Error("Erro ao excluir acesso administrativo.");
      }
    }

    if (request.auth_user_id && request.auth_user_created_by_request) {
      await supabaseAdmin.auth.admin.deleteUser(request.auth_user_id).catch((deleteError) => {
        console.error("[ADMIN_ACCESS_AUTH_DELETE_AFTER_REMOVE_ERROR]", deleteError);
      });
    } else if (request.auth_user_id) {
      await supabaseAdmin.auth.admin.updateUserById(request.auth_user_id, {
        user_metadata: {
          full_name: request.full_name,
          admin_access_status: "removed",
        },
      }).catch((metadataError) => {
        console.error("[ADMIN_ACCESS_AUTH_METADATA_REMOVE_ERROR]", metadataError);
      });
    }

    const metadata = {
      ...getPlainMetadata(request.metadata),
      admin_access_status: "removed",
      removed_at: new Date().toISOString(),
      removed_by: req.admin.email,
      removed_admin_id: admin?.id || null,
    };

    const { data: updatedRequest, error: updateError } = await supabaseAdmin
      .from("admin_access_requests")
      .update({
        status: "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.admin.id,
        rejection_reason: "Acesso administrativo excluído pelo administrador master.",
        metadata,
      })
      .eq("id", requestId)
      .select("*")
      .single();

    if (updateError) {
      console.error("[ADMIN_ACCESS_DELETE_REQUEST_UPDATE_ERROR]", updateError);
      throw new Error("Acesso removido, mas houve erro ao atualizar histórico.");
    }

    await createAdminNotification({
      type: "admin_access_removed",
      title: "Acesso administrativo excluído",
      message: `${request.full_name} teve o acesso administrativo excluído.`,
      entity_type: "admin_access_request",
      entity_id: requestId,
      priority: "high",
      metadata: {
        request_id: requestId,
        admin_id: admin?.id || null,
        email,
        removed_by: req.admin.email,
      },
    });

    return res.json({
      success: true,
      message: "Acesso administrativo excluído com sucesso.",
      request: buildRequestWithAdminStatus(updatedRequest, new Map()),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/access-requests/:id/reject", requireAdminAuth, requireMasterAdmin, async (req, res, next) => {
  try {
    const requestId = req.params.id;
    const reason = String(req.body?.reason || "").trim() || "Solicitação recusada pelo administrador master.";

    const { data: request, error: requestError } = await supabaseAdmin
      .from("admin_access_requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (requestError || !request) {
      return res.status(404).json({
        success: false,
        message: "Solicitação não encontrada.",
      });
    }

    if (request.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Essa solicitação já foi analisada.",
      });
    }

    const { data: updatedRequest, error: updateError } = await supabaseAdmin
      .from("admin_access_requests")
      .update({
        status: "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.admin.id,
        rejection_reason: reason,
      })
      .eq("id", requestId)
      .select("*")
      .single();

    if (updateError) {
      console.error("[ADMIN_ACCESS_REQUEST_REJECT_ERROR]", updateError);
      throw new Error("Erro ao recusar solicitação.");
    }

    if (request.auth_user_id && request.auth_user_created_by_request) {
      await supabaseAdmin.auth.admin.deleteUser(request.auth_user_id).catch((deleteError) => {
        console.error("[ADMIN_ACCESS_AUTH_DELETE_AFTER_REJECT_ERROR]", deleteError);
      });
    }

    await createAdminNotification({
      type: "admin_access_rejected",
      title: "Solicitação administrativa recusada",
      message: `${request.full_name} teve a solicitação de acesso recusada.`,
      entity_type: "admin_access_request",
      entity_id: requestId,
      priority: "normal",
      metadata: {
        request_id: requestId,
        email: request.email,
        rejected_by: req.admin.email,
      },
    });

    return res.json({
      success: true,
      message: "Solicitação recusada com sucesso.",
      request: updatedRequest,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
