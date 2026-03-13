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

function buildPasswordEmailTemplate({ actionLink, fullName, kind }) {
  const safeName = escapeHtml(fullName || "usuario");
  const isSetup = kind === "setup";
  const title = isSetup ? "Configura tu contrasena en MasterFade" : "Restablece tu contrasena de MasterFade";
  const intro = isSetup
    ? "Hemos creado tu acceso. Debes configurar tu contrasena para ingresar."
    : "Recibimos una solicitud para restablecer tu contrasena.";
  const cta = isSetup ? "Configurar contrasena" : "Restablecer contrasena";
  const footer = "Si no solicitaste esta accion, puedes ignorar este correo.";

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">
      <h2 style="margin-bottom:8px">${title}</h2>
      <p>Hola ${safeName},</p>
      <p>${intro}</p>
      <p style="margin:24px 0">
        <a href="${escapeHtml(actionLink)}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">
          ${cta}
        </a>
      </p>
      <p>Tambien puedes abrir este enlace manualmente:</p>
      <p style="word-break:break-all"><a href="${escapeHtml(actionLink)}">${escapeHtml(actionLink)}</a></p>
      <p style="margin-top:20px;color:#6b7280">${footer}</p>
    </div>
  `;

  const text = [
    title,
    "",
    `Hola ${fullName || "usuario"},`,
    intro,
    "",
    `${cta}: ${actionLink}`,
    "",
    footer,
  ].join("\n");

  return { html, text, subject: title };
}

async function mailerPlugin(app) {
  // AM: Backend mailer SMTP dedicado para desacoplar el envio de correos del limite nativo de Supabase.
  const host = normalizeOptional(process.env.SMTP_HOST);
  const portRaw = Number(process.env.SMTP_PORT || 587);
  const port = Number.isFinite(portRaw) ? portRaw : 587;
  const user = normalizeOptional(process.env.SMTP_USER);
  const pass = normalizeOptional(process.env.SMTP_PASS);
  const from = normalizeOptional(process.env.SMTP_FROM) || user;
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
    async sendMail({ to, subject, text, html }) {
      try {
        const result = await transporter.sendMail({
          from,
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
    async sendPasswordRecoveryEmail({ to, actionLink, fullName = null, kind = "reset" }) {
      try {
        const template = buildPasswordEmailTemplate({ actionLink, fullName, kind });
        return this.sendMail({
          to,
          subject: template.subject,
          text: template.text,
          html: template.html,
        });
      } catch (error) {
        app.log.error({ err: error, to }, "Fallo construccion email SMTP");
        return {
          sent: false,
          message: error instanceof Error ? error.message : "No se pudo preparar el correo SMTP",
        };
      }
    },
  });
}

export default fp(mailerPlugin, { name: "mailer-plugin" });
