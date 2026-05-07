import fp from "fastify-plugin";
import nodemailer from "nodemailer";

function normalizeOptional(value) {
  const raw = String(value || "").trim();
  return raw ? raw : null;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPasswordEmailTemplate({ actionLink, fullName, kind, bannerUrl = null }) {
  const normalizedName = String(fullName || "").trim();
  const greetingText = normalizedName ? `Hola ${normalizedName},` : "Hola,";
  const isSetup = kind === "setup";
  const title = isSetup ? "Configura tu contrasena en MasterFade" : "Restablece tu contrasena de MasterFade";
  const intro = isSetup
    ? "Hemos creado tu acceso. Debes configurar tu contrasena para ingresar."
    : "Recibimos una solicitud para restablecer tu contrasena.";
  const cta = isSetup ? "Configurar contrasena" : "Restablecer contrasena";
  const footer = "Si no solicitaste esta accion, puedes ignorar este correo.";
  const normalizedBannerUrl = String(bannerUrl || "").trim();
  const bannerHtml = normalizedBannerUrl
    ? `
      <div style="margin:0 0 20px;border-radius:14px;overflow:hidden;border:1px solid #2b2f3f;">
        <img src="${escapeHtml(normalizedBannerUrl)}" alt="MasterFade Banner" style="display:block;width:100%;height:auto;" />
      </div>
    `
    : "";

  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="margin:0;padding:0;background:#0b0d12;font-family:Inter,Segoe UI,Arial,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;background:#0b0d12;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#141722;border:1px solid #2b2f3f;border-radius:18px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 24px;background:linear-gradient(135deg,#1c2234 0%,#131722 50%,#2f2614 100%);border-bottom:1px solid #2b2f3f;">
                    <p style="margin:0;color:#f1f4fa;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">MasterFade</p>
                    <h1 style="margin:10px 0 0;color:#f8f9fb;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 24px 26px;">
                    ${bannerHtml}
                    <p style="margin:0 0 14px;color:#f4f6fb;font-size:16px;font-weight:600;">${escapeHtml(greetingText)}</p>
                    <p style="margin:0 0 14px;color:#d9dce4;font-size:15px;line-height:1.7;">${escapeHtml(intro)}</p>
                    <div style="margin:20px 0 18px;">
                      <a href="${escapeHtml(actionLink)}" style="display:inline-block;background:#d4b068;color:#121317;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;">
                        ${escapeHtml(cta)}
                      </a>
                    </div>
                    <p style="margin:0 0 8px;color:#d9dce4;font-size:14px;line-height:1.6;">Tambien puedes abrir este enlace manualmente:</p>
                    <p style="margin:0 0 16px;word-break:break-all;">
                      <a href="${escapeHtml(actionLink)}" style="color:#9fb2f8;text-decoration:none;">${escapeHtml(actionLink)}</a>
                    </p>
                    <p style="margin:0;color:#97a0b8;font-size:12px;line-height:1.5;">${escapeHtml(footer)}</p>
                    <p style="margin:8px 0 0;color:#97a0b8;font-size:12px;line-height:1.5;">
                      Soporte: <a href="mailto:soporte@masterfadeapp.com" style="color:#d4b068;text-decoration:none;">soporte@masterfadeapp.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const text = [
    title,
    "",
    greetingText,
    intro,
    "",
    `${cta}: ${actionLink}`,
    "",
    "Soporte: soporte@masterfadeapp.com",
    "",
    footer,
  ].join("\n");

  return { html, text, subject: title };
}

function buildUserWelcomeTemplate({ fullName = null, bannerUrl = null }) {
  const normalizedName = String(fullName || "").trim();
  const greetingText = normalizedName ? `Hola ${normalizedName},` : "Hola,";
  const title = "Tu acceso a MasterFade esta listo";
  const intro = "Tu usuario fue creado correctamente. Ya puedes ingresar y disfrutar tu experiencia MasterFade.";
  const supportText = "Si tienes dudas, responde este correo o escribe a soporte@masterfadeapp.com.";
  const normalizedBannerUrl = String(bannerUrl || "").trim();
  const bannerHtml = normalizedBannerUrl
    ? `
      <div style="margin:0 0 20px;border-radius:14px;overflow:hidden;border:1px solid #2b2f3f;">
        <img src="${escapeHtml(normalizedBannerUrl)}" alt="MasterFade Banner" style="display:block;width:100%;height:auto;" />
      </div>
    `
    : "";

  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="margin:0;padding:0;background:#0b0d12;font-family:Inter,Segoe UI,Arial,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;background:#0b0d12;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#141722;border:1px solid #2b2f3f;border-radius:18px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 24px;background:linear-gradient(135deg,#1c2234 0%,#131722 50%,#2f2614 100%);border-bottom:1px solid #2b2f3f;">
                    <p style="margin:0;color:#f1f4fa;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">MasterFade</p>
                    <h1 style="margin:10px 0 0;color:#f8f9fb;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 24px 26px;">
                    ${bannerHtml}
                    <p style="margin:0 0 14px;color:#f4f6fb;font-size:16px;font-weight:600;">${escapeHtml(greetingText)}</p>
                    <p style="margin:0 0 14px;color:#d9dce4;font-size:15px;line-height:1.7;">${escapeHtml(intro)}</p>
                    <p style="margin:0;color:#97a0b8;font-size:13px;line-height:1.6;">${escapeHtml(supportText)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const text = [title, "", greetingText, intro, "", supportText].join("\n");
  return { subject: title, html, text };
}

function buildSocialConfirmationTemplate({ actionLink, fullName = null, bannerUrl = null }) {
  const normalizedName = String(fullName || "").trim();
  const greetingText = normalizedName ? `Hola ${normalizedName},` : "Hola,";
  const title = "Confirma tu acceso seguro con Google";
  const intro =
    "Antes de crear tu perfil interno en MasterFade, necesitamos que confirmes este correo de seguridad.";
  const cta = "Confirmar correo y continuar";
  const supportText = "Si no iniciaste este acceso con Google, ignora este mensaje y contacta soporte.";
  const normalizedBannerUrl = String(bannerUrl || "").trim();
  const bannerHtml = normalizedBannerUrl
    ? `
      <div style="margin:0 0 20px;border-radius:14px;overflow:hidden;border:1px solid #2b2f3f;">
        <img src="${escapeHtml(normalizedBannerUrl)}" alt="MasterFade Banner" style="display:block;width:100%;height:auto;" />
      </div>
    `
    : "";

  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="margin:0;padding:0;background:#0b0d12;font-family:Inter,Segoe UI,Arial,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;background:#0b0d12;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#141722;border:1px solid #2b2f3f;border-radius:18px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 24px;background:linear-gradient(135deg,#1c2234 0%,#131722 50%,#2f2614 100%);border-bottom:1px solid #2b2f3f;">
                    <p style="margin:0;color:#f1f4fa;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">MasterFade Seguridad</p>
                    <h1 style="margin:10px 0 0;color:#f8f9fb;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 24px 26px;">
                    ${bannerHtml}
                    <p style="margin:0 0 14px;color:#f4f6fb;font-size:16px;font-weight:600;">${escapeHtml(greetingText)}</p>
                    <p style="margin:0 0 14px;color:#d9dce4;font-size:15px;line-height:1.7;">${escapeHtml(intro)}</p>
                    <div style="margin:20px 0 18px;">
                      <a href="${escapeHtml(actionLink)}" style="display:inline-block;background:#d4b068;color:#121317;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;">
                        ${escapeHtml(cta)}
                      </a>
                    </div>
                    <p style="margin:0 0 8px;color:#d9dce4;font-size:14px;line-height:1.6;">Tambien puedes abrir este enlace manualmente:</p>
                    <p style="margin:0 0 16px;word-break:break-all;">
                      <a href="${escapeHtml(actionLink)}" style="color:#9fb2f8;text-decoration:none;">${escapeHtml(actionLink)}</a>
                    </p>
                    <p style="margin:0;color:#97a0b8;font-size:12px;line-height:1.5;">${escapeHtml(supportText)}</p>
                    <p style="margin:8px 0 0;color:#97a0b8;font-size:12px;line-height:1.5;">
                      Soporte: <a href="mailto:soporte@masterfadeapp.com" style="color:#d4b068;text-decoration:none;">soporte@masterfadeapp.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const text = [
    title,
    "",
    greetingText,
    intro,
    "",
    `${cta}: ${actionLink}`,
    "",
    supportText,
    "Soporte: soporte@masterfadeapp.com",
  ].join("\n");

  return { subject: title, html, text };
}

function formatMembershipDate(dateValue) {
  const parsed = new Date(dateValue || "");
  if (Number.isNaN(parsed.getTime())) return "Fecha por confirmar";
  return parsed.toLocaleDateString("es-HN", {
    year: "numeric",
    month: "long",
    day: "2-digit",
    timeZone: "America/Tegucigalpa",
  });
}

function formatMembershipMoney(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "Monto por confirmar";
  return `L ${value.toFixed(2)}`;
}

function buildMembershipEmailTemplate({
  title,
  intro,
  fullName = null,
  bullets = [],
  supportText = "Si necesitas ayuda, responde este correo y te asistimos de inmediato.",
  bannerUrl = null,
}) {
  const normalizedName = String(fullName || "").trim();
  const greetingText = normalizedName ? `Hola ${normalizedName},` : "Hola,";
  const normalizedBannerUrl = String(bannerUrl || "").trim();
  const bannerHtml = normalizedBannerUrl
    ? `
      <div style="margin:0 0 20px;border-radius:14px;overflow:hidden;border:1px solid #2b2f3f;">
        <img src="${escapeHtml(normalizedBannerUrl)}" alt="MasterFade Banner" style="display:block;width:100%;height:auto;" />
      </div>
    `
    : "";
  const bulletRows = (Array.isArray(bullets) ? bullets : [])
    .filter((item) => String(item || "").trim())
    .map((item) => `<li style="margin:0 0 8px;color:#d9dce4;font-size:14px;line-height:1.6;">${escapeHtml(item)}</li>`)
    .join("");
  const bulletsHtml = bulletRows ? `<ul style="margin:14px 0 0 18px;padding:0;">${bulletRows}</ul>` : "";

  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="margin:0;padding:0;background:#0b0d12;font-family:Inter,Segoe UI,Arial,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;background:#0b0d12;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#141722;border:1px solid #2b2f3f;border-radius:18px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 24px;background:linear-gradient(135deg,#1c2234 0%,#131722 50%,#2f2614 100%);border-bottom:1px solid #2b2f3f;">
                    <p style="margin:0;color:#f1f4fa;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">MasterFade Pagos</p>
                    <h1 style="margin:10px 0 0;color:#f8f9fb;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 24px 26px;">
                    ${bannerHtml}
                    <p style="margin:0 0 14px;color:#f4f6fb;font-size:16px;font-weight:600;">${escapeHtml(greetingText)}</p>
                    <p style="margin:0;color:#d9dce4;font-size:15px;line-height:1.7;">${escapeHtml(intro)}</p>
                    ${bulletsHtml}
                    <p style="margin:14px 0 0;color:#97a0b8;font-size:13px;line-height:1.6;">${escapeHtml(supportText)}</p>
                    <p style="margin:8px 0 0;color:#97a0b8;font-size:12px;line-height:1.5;">
                      Pagos: <a href="mailto:pagos@masterfadeapp.com" style="color:#d4b068;text-decoration:none;">pagos@masterfadeapp.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const textLines = [title, "", greetingText, intro, ""];
  for (const bullet of bullets) {
    if (!String(bullet || "").trim()) continue;
    textLines.push(`- ${String(bullet).trim()}`);
  }
  textLines.push("", supportText, "Pagos: pagos@masterfadeapp.com");

  return {
    subject: title,
    html,
    text: textLines.join("\n"),
  };
}

function buildMembershipAcquiredTemplate({ planName, startAt, endAt, amountHnl, fullName = null, bannerUrl = null }) {
  return buildMembershipEmailTemplate({
    title: "Tu plan MasterFade se activó correctamente",
    intro: "La adquisición de tu plan fue registrada y ya puedes usar sus beneficios en tu siguiente reserva.",
    fullName,
    bannerUrl,
    bullets: [
      `Plan: ${planName || "Plan MasterFade"}`,
      `Inicio: ${formatMembershipDate(startAt)}`,
      `Vence: ${formatMembershipDate(endAt)}`,
      `Monto de referencia: ${formatMembershipMoney(amountHnl)}`,
    ],
  });
}

function buildMembershipExpiryTemplate({ planName, fullName = null, endAt, daysRemaining = 3, bannerUrl = null }) {
  return buildMembershipEmailTemplate({
    title: "Tu plan MasterFade está próximo a vencer",
    intro: "Queremos ayudarte a mantener tus beneficios activos para que no pierdas continuidad en tu experiencia.",
    fullName,
    bannerUrl,
    bullets: [
      `Plan activo: ${planName || "Plan MasterFade"}`,
      `Vencimiento: ${formatMembershipDate(endAt)}`,
      `Tiempo restante: ${Number(daysRemaining)} día(s)`,
    ],
  });
}

function buildMembershipCriticalBalanceTemplate({
  planName,
  fullName = null,
  serviciosRestantes = 1,
  bannerUrl = null,
}) {
  // AM: Cortesias quedan fuera del flujo operativo; se conserva el parametro por compatibilidad.
  return buildMembershipEmailTemplate({
    title: "Tu plan esta en saldo critico",
    intro: "Solo te queda un margen mínimo de beneficios. Te recomendamos planificar tu próxima visita o renovar a tiempo.",
    fullName,
    bannerUrl,
    bullets: [
      `Plan activo: ${planName || "Plan MasterFade"}`,
      `Servicios restantes: ${Number(serviciosRestantes)}`,
    ],
  });
}

async function mailerPlugin(app) {
  // AM: Backend mailer SMTP dedicado para desacoplar el envio de correos del limite nativo de Supabase.
  const host = normalizeOptional(process.env.SMTP_HOST);
  const portRaw = Number(process.env.SMTP_PORT || 587);
  const port = Number.isFinite(portRaw) ? portRaw : 587;
  const user = normalizeOptional(process.env.SMTP_USER);
  const pass = normalizeOptional(process.env.SMTP_PASS);
  const from = normalizeOptional(process.env.SMTP_FROM) || user;
  const supportFrom = normalizeOptional(process.env.SMTP_FROM_SUPPORT || "soporte@masterfadeapp.com");
  const noReplyFrom = normalizeOptional(process.env.SMTP_FROM_NO_REPLY || "noresponder@masterfadeapp.com");
  const securityFrom = normalizeOptional(process.env.SMTP_FROM_SECURITY || "seguridad@masterfadeapp.com");
  const paymentsFrom = normalizeOptional(process.env.SMTP_FROM_PAYMENTS || "pagos@masterfadeapp.com");
  const passwordEmailBannerUrl = normalizeOptional(process.env.COMMUNICATION_EMAIL_BANNER_URL);
  const secure = parseBool(process.env.SMTP_SECURE, port === 465);
  const verifyOnBoot = parseBool(process.env.SMTP_VERIFY_ON_BOOT, false);

  if (!host || !from) {
    app.decorate("mailer", {
      configured: false,
      provider: "smtp",
      async sendMail() {
        return {
          sent: false,
          message: "Servicio SMTP no configurado (requiere SMTP_HOST y SMTP_FROM).",
        };
      },
      async sendPasswordRecoveryEmail() {
        return {
          sent: false,
          message: "Servicio SMTP no configurado (requiere SMTP_HOST y SMTP_FROM).",
        };
      },
      async sendUserWelcomeEmail() {
        return {
          sent: false,
          message: "Servicio SMTP no configurado (requiere SMTP_HOST y SMTP_FROM).",
        };
      },
      async sendSocialProvisionConfirmationEmail() {
        return {
          sent: false,
          message: "Servicio SMTP no configurado (requiere SMTP_HOST y SMTP_FROM).",
        };
      },
      async sendMembershipPlanAcquiredEmail() {
        return {
          sent: false,
          message: "Servicio SMTP no configurado (requiere SMTP_HOST y SMTP_FROM).",
        };
      },
      async sendMembershipExpiryWarningEmail() {
        return {
          sent: false,
          message: "Servicio SMTP no configurado (requiere SMTP_HOST y SMTP_FROM).",
        };
      },
      async sendMembershipCriticalBalanceEmail() {
        return {
          sent: false,
          message: "Servicio SMTP no configurado (requiere SMTP_HOST y SMTP_FROM).",
        };
      },
    });
    app.log.warn("SMTP no configurado: app.mailer quedara en modo deshabilitado.");
    return;
  }

  const transportOptions = {
    host,
    port,
    secure,
  };
  if (user && pass) {
    transportOptions.auth = { user, pass };
  }

  const transporter = nodemailer.createTransport(transportOptions);
  if (verifyOnBoot) {
    // AM: Validacion opcional de SMTP al inicio para detectar credenciales invalidas en despliegue.
    await transporter.verify();
  }

  app.decorate("mailer", {
    configured: true,
    provider: "smtp",
    async sendMail({ to, subject, text, html, from: customFrom = null }) {
      try {
        const resolvedFrom = normalizeOptional(customFrom) || from;
        const result = await transporter.sendMail({
          from: resolvedFrom,
          to,
          subject,
          text,
          html,
        });
        return {
          sent: true,
          message: "Correo enviado correctamente.",
          provider_message_id: result.messageId || null,
        };
      } catch (error) {
        app.log.error({ err: error, to, subject }, "Fallo envio SMTP");
        return {
          sent: false,
          message: error instanceof Error ? error.message : "No se pudo enviar el correo SMTP",
        };
      }
    },
    async sendPasswordRecoveryEmail({ to, actionLink, fullName = null, kind = "reset", from: customFrom = null }) {
      try {
        const template = buildPasswordEmailTemplate({
          actionLink,
          fullName,
          kind,
          bannerUrl: passwordEmailBannerUrl,
        });
        const defaultFrom = kind === "setup" ? noReplyFrom : supportFrom;
        return this.sendMail({
          to,
          subject: template.subject,
          text: template.text,
          html: template.html,
          from: normalizeOptional(customFrom) || defaultFrom,
        });
      } catch (error) {
        app.log.error({ err: error, to }, "Fallo construccion email SMTP");
        return {
          sent: false,
          message: error instanceof Error ? error.message : "No se pudo preparar el correo SMTP",
        };
      }
    },
    async sendUserWelcomeEmail({ to, fullName = null }) {
      try {
        const template = buildUserWelcomeTemplate({ fullName, bannerUrl: passwordEmailBannerUrl });
        return this.sendMail({
          to,
          subject: template.subject,
          text: template.text,
          html: template.html,
          from: noReplyFrom,
        });
      } catch (error) {
        app.log.error({ err: error, to }, "Fallo construccion de correo de bienvenida");
        return {
          sent: false,
          message: error instanceof Error ? error.message : "No se pudo preparar el correo de bienvenida",
        };
      }
    },
    async sendSocialProvisionConfirmationEmail({ to, actionLink, fullName = null, from: customFrom = null }) {
      try {
        const template = buildSocialConfirmationTemplate({
          actionLink,
          fullName,
          bannerUrl: passwordEmailBannerUrl,
        });
        return this.sendMail({
          to,
          subject: template.subject,
          text: template.text,
          html: template.html,
          from: normalizeOptional(customFrom) || securityFrom,
        });
      } catch (error) {
        app.log.error({ err: error, to }, "Fallo construccion de correo de confirmacion social");
        return {
          sent: false,
          message: error instanceof Error ? error.message : "No se pudo preparar el correo de confirmacion social",
        };
      }
    },
    async sendMembershipPlanAcquiredEmail({
      to,
      fullName = null,
      planName,
      startAt,
      endAt,
      amountHnl = null,
      from: customFrom = null,
    }) {
      try {
        const template = buildMembershipAcquiredTemplate({
          planName,
          startAt,
          endAt,
          amountHnl,
          fullName,
          bannerUrl: passwordEmailBannerUrl,
        });
        return this.sendMail({
          to,
          subject: template.subject,
          text: template.text,
          html: template.html,
          from: normalizeOptional(customFrom) || paymentsFrom,
        });
      } catch (error) {
        app.log.error({ err: error, to }, "Fallo construcción de correo de adquisición de membresía");
        return {
          sent: false,
          message: error instanceof Error ? error.message : "No se pudo preparar el correo de adquisición de membresía",
        };
      }
    },
    async sendMembershipExpiryWarningEmail({
      to,
      fullName = null,
      planName,
      endAt,
      daysRemaining = 3,
      from: customFrom = null,
    }) {
      try {
        const template = buildMembershipExpiryTemplate({
          planName,
          fullName,
          endAt,
          daysRemaining,
          bannerUrl: passwordEmailBannerUrl,
        });
        return this.sendMail({
          to,
          subject: template.subject,
          text: template.text,
          html: template.html,
          from: normalizeOptional(customFrom) || paymentsFrom,
        });
      } catch (error) {
        app.log.error({ err: error, to }, "Fallo construcción de correo de vencimiento de membresía");
        return {
          sent: false,
          message: error instanceof Error ? error.message : "No se pudo preparar el correo de vencimiento de membresía",
        };
      }
    },
    async sendMembershipCriticalBalanceEmail({
      to,
      fullName = null,
      planName,
      serviciosRestantes = 1,
      from: customFrom = null,
    }) {
      try {
        const template = buildMembershipCriticalBalanceTemplate({
          planName,
          fullName,
          serviciosRestantes,
          bannerUrl: passwordEmailBannerUrl,
        });
        return this.sendMail({
          to,
          subject: template.subject,
          text: template.text,
          html: template.html,
          from: normalizeOptional(customFrom) || paymentsFrom,
        });
      } catch (error) {
        app.log.error({ err: error, to }, "Fallo construcción de correo de saldo crítico de membresía");
        return {
          sent: false,
          message: error instanceof Error ? error.message : "No se pudo preparar el correo de saldo crítico de membresía",
        };
      }
    },
  });
}

export default fp(mailerPlugin, { name: "mailer-plugin" });


