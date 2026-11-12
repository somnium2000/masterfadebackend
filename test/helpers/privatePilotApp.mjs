import crypto from "node:crypto";
import cookie from "@fastify/cookie";
import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import auth from "../../src/plugins/auth.js";
import gate from "../../src/plugins/privateCommerce.js";

// AM: Real signed-cookie/session gate composed with existing in-memory business fixtures.
export async function installPrivatePilot(app, t, { userId, clientId, enabled = true, roles = ["cliente"] } = {}) {
  const before = { JWT_SECRET: process.env.JWT_SECRET, CSRF_SECRET: process.env.CSRF_SECRET };
  const secret = crypto.randomBytes(40).toString("hex");
  process.env.JWT_SECRET = secret; process.env.CSRF_SECRET = secret;
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  app.config.privateCommercePilot = { enabled, userIds: [userId], ips: ["203.0.113.10"], proxies: [] };
  const original = app.db.query?.bind(app.db);
  app.db.query = async (sql, params) => {
    const text = String(sql?.text || sql);
    if (text.includes("FROM public.seguridad_sesiones")) return { rows: [{ estado: "activa", ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 600000) }] };
    if (text.includes("UPDATE public.seguridad_sesiones")) return { rows: [] };
    if (text.includes("WITH base_user")) return { rows: [{ id_usuario: userId, id_persona: userId, cliente_id: clientId, roles }] };
    if (!original) throw new Error("Unexpected pool query");
    return original(sql, params);
  };
  await app.register(fp(async () => {}, { name: "env-plugin" }));
  await app.register(cookie);
  await app.register(auth);
  await app.register(gate);
  const token = jwt.sign({ sub: userId, sid: crypto.randomUUID(), jti: crypto.randomUUID(), token_type: "app" }, secret,
    { issuer: "masterfade-api", audience: "masterfade-app", expiresIn: "1h" });
  return { remoteAddress: "203.0.113.10", headers: { cookie: `mf_session=${token}; mf_csrf=synthetic-csrf`, "x-csrf-token": "synthetic-csrf" } };
}
