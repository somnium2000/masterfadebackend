import { AppError } from "../utils/errors.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

const PUBLIC_ENV_VALUES = new Set(["qa", "staging", "preprod", "prod", "production"]);

function normalizeEnvValue(value) {
  return String(value || "").trim().toLowerCase();
}

function isHttpsUrl(value) {
  return String(value || "").trim().toLowerCase().startsWith("https://");
}

function resolveFrontendBaseUrlForRecovery() {
  const frontendUrlRaw = String(process.env.FRONTEND_URL || "").trim();
  const entorno = normalizeEnvValue(process.env.ENTORNO);
  const nodeEnv = normalizeEnvValue(process.env.NODE_ENV);

  const isPublicContext =
    PUBLIC_ENV_VALUES.has(entorno) ||
    PUBLIC_ENV_VALUES.has(nodeEnv) ||
    isHttpsUrl(frontendUrlRaw);

  if (isPublicContext) {
    if (!isHttpsUrl(frontendUrlRaw)) {
      throw new AppError(500, "FRONTEND_URL HTTPS requerido para recovery publico", {
        code: "AUTH_RECOVERY_FRONTEND_URL_INVALID",
        details: {
          entorno: entorno || null,
          node_env: nodeEnv || null,
          frontend_url: frontendUrlRaw || null,
        },
      });
    }
    return frontendUrlRaw.replace(/\/+$/, "");
  }

  if (frontendUrlRaw) return frontendUrlRaw.replace(/\/+$/, "");
  return "http://localhost:5173";
}

function buildDefaultRedirectTo() {
  const frontendUrl = resolveFrontendBaseUrlForRecovery();
  return `${frontendUrl}/login`;
}

function extractActionLink(data) {
  return (
    data?.properties?.action_link ||
    data?.action_link ||
    data?.properties?.email_action_link ||
    null
  );
}

export async function generateRecoveryActionLink(app, email, { redirectTo } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new AppError(400, "Correo invalido para recovery link", {
      code: "AUTH_RECOVERY_EMAIL_INVALID",
    });
  }

  if (!app.supabaseAdmin) {
    throw new AppError(500, "Supabase Admin no esta configurado", {
      code: "SUPABASE_ADMIN_NOT_CONFIGURED",
    });
  }

  const targetRedirectTo = String(redirectTo || buildDefaultRedirectTo()).trim();
  const { data, error } = await app.supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: normalizedEmail,
    options: {
      redirectTo: targetRedirectTo,
    },
  });

  if (error) {
    const errorCode = String(error.code || "").toLowerCase();
    const errorMessage = String(error.message || "No se pudo generar recovery link");
    // AM: Se mantiene respuesta neutra cuando el correo no existe para evitar user enumeration.
    if (errorCode === "user_not_found") {
      return {
        found: false,
        action_link: null,
        redirect_to: targetRedirectTo,
        error_code: errorCode,
      };
    }
    throw new AppError(500, "No se pudo generar el enlace de recuperacion", {
      code: "AUTH_RECOVERY_LINK_ERROR",
      details: { code: errorCode || "unknown", message: errorMessage },
    });
  }

  const actionLink = extractActionLink(data);
  if (!actionLink) {
    throw new AppError(500, "Supabase no retorno action_link de recuperacion", {
      code: "AUTH_RECOVERY_LINK_MISSING",
    });
  }

  return {
    found: true,
    action_link: actionLink,
    redirect_to: targetRedirectTo,
  };
}
