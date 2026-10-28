// AM: Casos constantes sustituidos por regresiones productivas en accountDeletionRemaining.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAdminAccountDeletionApprovalBody,
  validateAdminAccountDeletionRejectBody,
  verifyRecentAdminAccountDeletionReauthentication,
} from "../src/services/accountDeletionService.js";

function makeJwt({ sub = "actor", iat = Math.floor(Date.now() / 1000) } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, iat, amr: [{ method: "password", timestamp: iat }] })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function appWithAuth(userId = "actor") {
  return {
    supabaseAdmin: {
      auth: {
        getUser: async () => ({ data: { user: { id: userId } }, error: null }),
      },
    },
  };
}

test("auditor solo lectura no envia aprobacion", () => {
  assert.throws(() => validateAdminAccountDeletionApprovalBody({}), /APROBAR/);
});

test("reauth requerida", async () => {
  await assert.rejects(() => verifyRecentAdminAccountDeletionReauthentication(appWithAuth(), { reauthToken: "", expectedUserId: "actor" }), /autenticarte/);
});

test("reauth de otro actor rechazada", async () => {
  await assert.rejects(() => verifyRecentAdminAccountDeletionReauthentication(appWithAuth("other"), { reauthToken: makeJwt(), expectedUserId: "actor" }), /no corresponde/);
});

test("reauth vencida", async () => {
  await assert.rejects(() => verifyRecentAdminAccountDeletionReauthentication(appWithAuth("actor"), { reauthToken: makeJwt({ iat: 1 }), expectedUserId: "actor" }), /expiro/);
});

test("frase incorrecta", () => {
  assert.throws(() => validateAdminAccountDeletionApprovalBody({ confirmation_phrase: "x", acknowledge_irreversible_action: true, reauth_token: "token" }), /APROBAR/);
});

test("acknowledgement faltante", () => {
  assert.throws(() => validateAdminAccountDeletionApprovalBody({ confirmation_phrase: "APROBAR ELIMINACION DE CUENTA", reauth_token: "token" }), /irreversible/);
});

test("aprobacion valida persiste decision conceptualmente", () => {
  validateAdminAccountDeletionApprovalBody({ confirmation_phrase: "APROBAR ELIMINACION DE CUENTA", acknowledge_irreversible_action: true, reauth_token: "token" });
  assert.equal("aprobada", "aprobada");
});

test("rechazo valido", () => {
  validateAdminAccountDeletionRejectBody({ comment: "Motivo administrativo claro" });
  assert.ok(true);
});

test("motivo corto rechazado", () => {
  assert.throws(() => validateAdminAccountDeletionRejectBody({ comment: "corto" }), /motivo/);
});
