import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createPixelPaySaleAttemptRecord,
  finalizePixelPaySaleAttempt,
  finalizePixelPaySaleAttemptBestEffort,
  PIXELPAY_SALE_FINAL_QUERY_TIMEOUT_MS,
} from "../src/services/payments/pixelPaySaleAttemptStore.js";
import { createHangingPgPool } from "./helpers/hangingPgPool.mjs";
import {
  buildSafePixelPaySdkDiagnostics,
  buildSafeProviderErrorDiagnostic,
  SAFE_PIXELPAY_ERROR_CODES,
  SAFE_PIXELPAY_SDK_MESSAGE_CODES,
} from "../src/services/payments/pixelPaySaleDiagnostics.js";
import {
  SAFE_PIXELPAY_INPUT_ERROR_FIELDS, readPixelPayInputErrors, safePixelPayInputErrorFields,
} from "../src/services/payments/pixelPaySaleTelemetry.js";
import { PIXELPAY_SALE_OUTCOME } from "../src/services/payments/PixelPayDirectProvider.js";

const ID_INTENT = "11111111-2222-4333-8444-555555555555";
const ID_ATTEMPT = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const start = { idIntent: ID_INTENT, paymentAttemptId: ID_ATTEMPT, requestId: "req-store" };
const privateValues = [
  "4111111111111111", "987", "2849", "direccion-privada", "titular-privado",
  "secretKey-fixture", "authHash-fixture", "hash-privado", "publicKey-fixture",
  "authorization-fixture", "x-auth-key-fixture", "x-auth-hash-fixture",
  "x-client-signature-fixture", "raw-payload-fixture", "mensaje-privado",
];

function makeMemoryDb() {
  const calls = [];
  const records = [];
  return {
    calls, records,
    async query(sql, params) {
      const queryTimeout = typeof sql === "object" ? sql.query_timeout : null;
      params = typeof sql === "object" ? sql.values : params;
      sql = typeof sql === "object" ? sql.text : sql;
      calls.push({ sql, params, queryTimeout });
      if (sql.includes("INSERT")) {
        records.push({ payment_attempt_id: params[1], finalized_at: null });
        return { rows: [{ id_sale_attempt: ID_ATTEMPT }] };
      }
      assert.match(sql, /WHERE payment_attempt_id = \$1::uuid AND finalized_at IS NULL/);
      const record = records.find((row) => row.payment_attempt_id === params[0] && row.finalized_at === null);
      if (!record) return { rows: [] };
      Object.assign(record, { finalized_at: "2026-10-11T00:00:00Z", finalParameters: structuredClone(params) });
      return { rows: [{ id_sale_attempt: ID_ATTEMPT }] };
    },
  };
}

test("START usa el client suministrado y solamente identifiers y flags seguros", async () => {
  const db = makeMemoryDb();
  await createPixelPaySaleAttemptRecord(db, {
    ...start, cardExpireFormatValid: true, cardExpireFuture: true, billingAddressLength: 30,
    request: { body: { pan: privateValues[0] } }, response: privateValues[13],
    card_expire: privateValues[2], cardholder: privateValues[4], billing_address: privateValues[3],
  });
  assert.deepEqual(db.calls[0].params, [ID_INTENT, ID_ATTEMPT, "req-store", true, true, 30]);
  assert.equal(db.calls[0].queryTimeout, null);
  assert.doesNotMatch(db.calls[0].sql, /BEGIN|COMMIT|ROLLBACK|payment_intents/);
  for (const value of privateValues) assert.equal(JSON.stringify(db.calls[0].params).includes(value), false);
});

test("START rechaza UUID invalido sin emitir SQL", async () => {
  const db = makeMemoryDb();
  await assert.rejects(createPixelPaySaleAttemptRecord(db, { ...start, paymentAttemptId: privateValues[0] }), TypeError);
  await assert.rejects(createPixelPaySaleAttemptRecord(db, { ...start, idIntent: null }), TypeError);
  assert.equal(db.calls.length, 0);
});

for (const outcome of Object.values(PIXELPAY_SALE_OUTCOME)) {
  test(`FINAL ${outcome} persiste flags y no abre una transaccion`, async () => {
    const db = makeMemoryDb();
    await createPixelPaySaleAttemptRecord(db, start);
    assert.equal(await finalizePixelPaySaleAttempt(db, {
      ...start, outcome, statusCode: outcome === "request_error_definitive" ? 422 : 200,
      sdkResponseClass: "InputErrorResponse", safeMessageCode: "SDK_MESSAGE_ABSENT",
      responseSuccess: false, transactionResultValid: false, transactionResultParsed: false,
      responseApproved: false, responseIncomplete: false, responseCodePresent: false,
      hasPaymentUuid: false, hasTransactionId: false, hasPaymentHash: false, paymentHashValid: false,
      transactionAmountMatches: false, approvedAmountMatches: false, amountMatches: false,
      durationMs: 12, cfRay: "aabbccddeeff0011-MIA",
    }), true);
    const { sql, params } = db.calls[1];
    assert.equal(db.calls[1].queryTimeout, PIXELPAY_SALE_FINAL_QUERY_TIMEOUT_MS);
    assert.equal(params[5], outcome);
    assert.equal(params[6], outcome === "uncertain");
    assert.ok(params.slice(13, 26).every((value) => value === false));
    assert.equal(params[26], "aabbccddeeff0011-MIA");
    assert.doesNotMatch(sql, /BEGIN|COMMIT|ROLLBACK|INSERT/);
  });
}

test("FINAL 422 solo persiste allowlist, ordenada/deduplicada, y counts recalculados", async () => {
  const db = makeMemoryDb();
  await createPixelPaySaleAttemptRecord(db, start);
  const inputErrors = readPixelPayInputErrors({
    billing_state: [privateValues[0]], order_id: [privateValues[5]],
    "5555555555554444": ["invalid"], "999": ["invalid"], "secret-value": ["invalid"],
  });
  await finalizePixelPaySaleAttempt(db, {
    ...start, ...inputErrors, statusCode: 422, outcome: "request_error_definitive",
    inputErrorFields: [...inputErrors.inputErrorFields, "billing_state", "5555555555554444"],
    inputErrorCount: 100,
  });
  const params = db.calls[1].params;
  assert.equal(params[3], 422);
  assert.deepEqual(params[7], ["billing_state", "order_id"]);
  assert.equal(params[8], 2);
  assert.equal(params[9], 3);
  assert.doesNotMatch(JSON.stringify(params), /5555555555554444|"999"|secret-value|invalid/);
  const fields = safePixelPayInputErrorFields([...SAFE_PIXELPAY_INPUT_ERROR_FIELDS].flatMap((field) => [field, field]), 100);
  assert.ok(fields.length <= 32);
  assert.deepEqual(fields, [...new Set(fields)].sort());
  assert.deepEqual(safePixelPayInputErrorFields(["order_id", "billing_state"], 1), ["billing_state"]);
});

for (const errors of [null, [["invalid"]], new Date()]) {
  test(`errors ${errors === null ? "null" : Array.isArray(errors) ? "array" : "no plano"} no aporta campos`, async () => {
    const db = makeMemoryDb();
    await createPixelPaySaleAttemptRecord(db, start);
    await finalizePixelPaySaleAttempt(db, { ...start, ...readPixelPayInputErrors(errors) });
    assert.deepEqual(db.calls[1].params.slice(7, 10), [[], 0, 0]);
  });
}

test("segundo finalize no inserta, duplica ni sobrescribe el resultado original", async () => {
  const db = makeMemoryDb();
  await createPixelPaySaleAttemptRecord(db, start);
  assert.equal(await finalizePixelPaySaleAttempt(db, { ...start, outcome: "approved" }), true);
  const original = structuredClone(db.records);
  assert.equal(await finalizePixelPaySaleAttempt(db, { ...start, outcome: "payment_declined" }), false);
  assert.deepEqual(db.records, original);
  assert.equal(db.records.length, 1);
  assert.equal(db.calls.filter((call) => call.sql.includes("INSERT")).length, 1);
});

test("la frontera del store excluye valores sensibles incluso si un DTO contiene propiedades crudas", async () => {
  const db = makeMemoryDb();
  const unsafe = {
    ...start,
    card_number: privateValues[0], card_cvv: privateValues[1], card_expire: privateValues[2],
    billing_address: privateValues[3], cardholder: privateValues[4], secretKey: privateValues[5],
    authHash: privateValues[6], payment_hash: privateValues[7], publicKey: privateValues[8],
    headers: { Authorization: privateValues[9], "x-auth-key": privateValues[10],
      "x-auth-hash": privateValues[11], "x-client-signature": privateValues[12] },
    request: { body: privateValues[13] }, response: privateValues[13], saleRequest: privateValues[13],
    error: new Error(privateValues[14]), message: privateValues[14], errors: { order_id: privateValues },
    sdkResponseClass: privateValues[0], errorCode: privateValues[5], errorName: privateValues[4],
    sdkErrorName: privateValues[6], errorConstructorName: privateValues[8], safeMessageCode: privateValues[14],
    outcome: privateValues[14], cfRay: privateValues[12],
    inputErrorFields: ["order_id", ...privateValues],
  };
  await createPixelPaySaleAttemptRecord(db, unsafe);
  await finalizePixelPaySaleAttempt(db, unsafe);
  const serialized = JSON.stringify({ parameters: db.calls.map((call) => call.params), persistible: db.records });
  for (const value of privateValues) assert.equal(serialized.includes(value), false, `filtro del fixture ${value}`);
  assert.deepEqual(db.calls[1].params[7], ["order_id"]);
  assert.equal(db.calls[1].params[27], null);
  assert.equal(db.calls[1].params[2], null);
});

test("errores locales conocidos se preservan; codigos desconocidos y textos arbitrarios se descartan", async () => {
  const db = makeMemoryDb();
  const diagnostic = buildSafeProviderErrorDiagnostic(Object.assign(new Error(privateValues[14]), {
    code: "PIXELPAY_TIMEOUT", paymentAttemptId: ID_ATTEMPT, statusCode: 503,
    safeMessageCode: "SDK_HTTP_TIMEOUT", errorConstructorName: "Error",
  }), "req-store");
  await createPixelPaySaleAttemptRecord(db, start);
  await finalizePixelPaySaleAttempt(db, { ...start, ...diagnostic, outcome: "uncertain", statusCode: diagnostic.upstreamStatusCode });
  assert.equal(db.calls[1].params[27], "PIXELPAY_TIMEOUT");
  assert.equal(db.calls[1].params[28], "Error");
  assert.equal(db.calls[1].params[30], "Error");
  assert.equal(buildSafeProviderErrorDiagnostic({ code: "unknown-code" }).errorCode, null);
});

test("numeros fuera de limites y booleanos no tipados nunca llegan a SQL", async () => {
  const db = makeMemoryDb();
  await createPixelPaySaleAttemptRecord(db, { ...start, billingAddressLength: 181 });
  await finalizePixelPaySaleAttempt(db, {
    ...start, statusCode: 999, durationMs: 2147483648, billingAddressLength: -1,
    inputErrorUnknownCount: -1, responseApproved: "true", hasPaymentHash: "hash-value",
  });
  assert.equal(db.calls[0].params[5], null);
  assert.equal(db.calls[1].params[1], null);
  assert.equal(db.calls[1].params[3], null);
  assert.equal(db.calls[1].params[9], 0);
  assert.equal(db.calls[1].params[12], null);
  assert.equal(db.calls[1].params[16], null);
  assert.equal(db.calls[1].params[21], null);
  assert.equal(buildSafePixelPaySdkDiagnostics({ statusCode: 0 }).statusCode, null);
  assert.equal(buildSafePixelPaySdkDiagnostics({ cfRay: privateValues[0] }).cfRay, null);
  assert.equal(buildSafePixelPaySdkDiagnostics({ cfRay: `${privateValues[0]}-MIA` }).cfRay, null);
});

test("fallo FINAL produce log critico sanitizado y nunca propaga la excepcion", async () => {
  const logs = [];
  const pool = { async query() { throw new Error(privateValues.join(" ")); } };
  assert.equal(await finalizePixelPaySaleAttemptBestEffort(pool, start, { fatal(payload) { logs.push(payload); } }), false);
  assert.equal(logs[0].event, "PIXELPAY_SALE_FINAL_PERSISTENCE_FAILED");
  assert.equal(logs[0].paymentAttemptId, ID_ATTEMPT);
  for (const value of privateValues) assert.equal(JSON.stringify(logs).includes(value), false);
  assert.equal(await finalizePixelPaySaleAttemptBestEffort(pool, start, { fatal() { throw new Error("fallo logger"); } }), false);
});

test("FINAL excedido usa el timer real de pg 8.16.3 y destruye/retira la conexion del pool", {
  timeout: PIXELPAY_SALE_FINAL_QUERY_TIMEOUT_MS + 10000,
}, async (t) => {
  const { pool, connections } = createHangingPgPool();
  const logs = [];
  t.after(() => pool.end());
  const startedAt = Date.now();
  const finalized = await finalizePixelPaySaleAttemptBestEffort(pool, start, {
    fatal(payload) { logs.push(payload); },
  });
  assert.equal(finalized, false);
  assert.ok(Date.now() - startedAt >= PIXELPAY_SALE_FINAL_QUERY_TIMEOUT_MS - 20);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].executions, 1);
  assert.equal(connections[0].destroyed, true);
  assert.equal(pool.totalCount, 0);
  assert.equal(pool.idleCount, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "PIXELPAY_SALE_FINAL_PERSISTENCE_FAILED");
  assert.equal(logs[0].paymentAttemptId, ID_ATTEMPT);
  assert.equal(logs[0].err, undefined);
  assert.equal(logs[0].message, undefined);
});

test("migration privada define contrato, checks y allowlists identicas a JavaScript", async () => {
  const sql = (await readFile(new URL("../db/migrations/pixel/20261011043911_pixelpay_sale_attempts.sql", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_private\.pixelpay_sale_attempts/);
  assert.match(sql, /payment_attempt_id uuid NOT NULL UNIQUE/);
  assert.match(sql, /REFERENCES public\.payment_intents\(id_intent\)\s+ON UPDATE CASCADE ON DELETE RESTRICT/);
  assert.match(sql, /upstream_http_status BETWEEN 100 AND 599/);
  assert.match(sql, /duration_ms IS NULL OR duration_ms >= 0/);
  assert.match(sql, /input_error_count BETWEEN 0 AND 32 AND input_error_unknown_count >= 0/);
  assert.match(sql, /cardinality\(input_error_fields\) <= 32/);
  assert.match(sql, /input_error_count = cardinality\(input_error_fields\)/);
  assert.match(sql, /array_position\(input_error_fields, NULL\) IS NULL/);
  assert.match(sql, /billing_address_length BETWEEN 0 AND 180/);
  assert.match(sql, /REVOKE ALL ON TABLE app_private\.pixelpay_sale_attempts FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /\(id_intent, created_at DESC\)/);
  assert.match(sql, /WHERE finalized_at IS NULL/);
  assert.doesNotMatch(sql, /\b(?:phase|payload|raw_response|raw_request|secretKey|authHash|publicKey)\b|GRANT|SECURITY DEFINER/);
  const sqlValues = (name) => [...sql.match(new RegExp(`CONSTRAINT ${name}([\\s\\S]*?)(?:,\\n  CONSTRAINT|\\n\\);)`))[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(sqlValues("ck_pixelpay_sale_attempts_inputs"), [...SAFE_PIXELPAY_INPUT_ERROR_FIELDS].sort());
  assert.deepEqual(sqlValues("ck_pixelpay_sale_attempts_outcome"), Object.values(PIXELPAY_SALE_OUTCOME).sort());
  assert.deepEqual(sqlValues("ck_pixelpay_sale_attempts_message"), [...SAFE_PIXELPAY_SDK_MESSAGE_CODES].sort());
  assert.deepEqual(sqlValues("ck_pixelpay_sale_attempts_error_code"), [...SAFE_PIXELPAY_ERROR_CODES].sort());
  const columns = [...sql.matchAll(/^ {2}([a-z_]+) (uuid|varchar\([0-9]+\)|timestamptz|integer|smallint|text\[\]|boolean)/gm)];
  assert.equal(columns.length, 36);
  assert.ok(columns.every(([, name, type]) => !["request_id", "cf_ray", "outcome", "safe_message_code", "error_code", "error_name", "sdk_error_name", "error_constructor_name", "sdk_response_class"].includes(name) || /^varchar\(/.test(type)));
});
