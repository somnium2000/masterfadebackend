import assert from "node:assert/strict";
import test from "node:test";
import {
  assessHostedVerificationAcceptance,
  HOSTED_VERIFICATION_BLOCKERS,
  HOSTED_VERIFICATION_EVIDENCE_REQUIRED,
} from "../src/services/payments/pixelPayHostedVerification.js";

// AM: Ficha sintetica interna; no representa un response ni un contrato financiero oficial PixelPay.
const canonical = Object.freeze({
  merchantId: "fixture-account-identity",
  orderId: "fixture-canonical-order",
  requestedPaymentUuid: "S-fixture-callback-candidate",
  amountMinor: 10000,
  currency: "HNL",
});
const completeCandidate = Object.freeze({
  merchantId: canonical.merchantId,
  orderId: canonical.orderId,
  paymentUuid: canonical.requestedPaymentUuid,
  transactionId: "fixture-financial-transaction",
  amountMinor: canonical.amountMinor,
  currency: "HNL",
  financialResult: "synthetic-result-without-proven-provider-meaning",
  paidAt: "2026-11-14T12:00:00.123456Z",
});

function blocked(candidate, expectedReasons = []) {
  const result = assessHostedVerificationAcceptance({ canonical, candidate });
  assert.equal(result.status, "blocked");
  assert.equal(result.financial_verified, false);
  assert.equal(result.can_confirm, false);
  assert.equal(result.automatic_confirmation, false);
  for (const reason of [...HOSTED_VERIFICATION_BLOCKERS, ...expectedReasons]) {
    assert.ok(result.reasons.includes(reason), `Missing rejection reason ${reason}`);
  }
  return result;
}

test("ficha completa y coincidencias no inventan un contrato autenticado ni permiten confirmar", () => {
  assert.deepEqual(blocked(completeCandidate).reasons, HOSTED_VERIFICATION_BLOCKERS);
  assert.ok(Object.isFrozen(HOSTED_VERIFICATION_BLOCKERS));
  assert.ok(Object.isFrozen(HOSTED_VERIFICATION_EVIDENCE_REQUIRED));
});

test("Status oficial documentado con solo status/attemps/history no verifica finanzas", () => {
  blocked({ success: true, data: { status: "paid", attemps: 1, history: {} } }, [
    "MERCHANT_MISSING_OR_INVALID", "ORDER_MISSING_OR_INVALID", "PAYMENT_UUID_MISSING_OR_INVALID",
    "AMOUNT_MISSING_OR_INVALID", "CURRENCY_MISSING_OR_MISMATCH", "FINANCIAL_RESULT_MISSING_OR_INVALID",
  ]);
});

test("hash-only y retorno complete no autentican el resultado", () => {
  blocked({ payment_hash: "a".repeat(32), paymentHash: "a".repeat(32), hosted_return: "complete", status: "paid" }, [
    "MERCHANT_MISSING_OR_INVALID", "ORDER_MISSING_OR_INVALID", "AMOUNT_MISSING_OR_INVALID",
  ]);
});

for (const [name, change, reason] of [
  ["uuid ajeno", { paymentUuid: "S-foreign-callback-candidate" }, "PAYMENT_UUID_MISMATCH"],
  ["uuid ausente", { paymentUuid: undefined }, "PAYMENT_UUID_MISSING_OR_INVALID"],
  ["merchant ajeno", { merchantId: "foreign-account" }, "MERCHANT_MISMATCH"],
  ["merchant ausente", { merchantId: undefined }, "MERCHANT_MISSING_OR_INVALID"],
  ["orden ajena", { orderId: "foreign-order" }, "ORDER_MISMATCH"],
  ["orden ausente", { orderId: undefined }, "ORDER_MISSING_OR_INVALID"],
  ["importe incorrecto", { amountMinor: 9999 }, "AMOUNT_MISMATCH"],
  ["importe ausente", { amountMinor: undefined }, "AMOUNT_MISSING_OR_INVALID"],
  ["importe string", { amountMinor: "10000" }, "AMOUNT_MISSING_OR_INVALID"],
  ["importe fraccionario", { amountMinor: 10000.001 }, "AMOUNT_MISSING_OR_INVALID"],
  ["importe inseguro", { amountMinor: Number.MAX_SAFE_INTEGER + 1 }, "AMOUNT_MISSING_OR_INVALID"],
  ["moneda incorrecta", { currency: "USD" }, "CURRENCY_MISSING_OR_MISMATCH"],
  ["moneda ausente", { currency: undefined }, "CURRENCY_MISSING_OR_MISMATCH"],
  ["transaccion ausente", { transactionId: undefined }, "TRANSACTION_ID_MISSING_OR_INVALID"],
  ["resultado financiero ausente", { financialResult: undefined }, "FINANCIAL_RESULT_MISSING_OR_INVALID"],
  ["hora ausente", { paidAt: undefined }, "PAYMENT_TIME_MISSING_OR_INVALID"],
  ["hora sin zona", { paidAt: "2026-11-14 12:00:00" }, "PAYMENT_TIME_MISSING_OR_INVALID"],
]) test(`acceptance gate rechaza ${name}`, () => {
  blocked({ ...completeCandidate, ...change }, [reason]);
});

test("flags del caller o campos SDK no crean confianza ni hacen equivalentes merchant IDs", () => {
  blocked({ ...completeCandidate, authenticated: true, authenticationVerified: true, providerContractValid: true,
    response_approved: true, response_incomplete: false, payment_hash_valid: true, transaction_merchant: canonical.merchantId });
  blocked({ transaction_merchant: canonical.merchantId, order_id: canonical.orderId,
    payment_uuid: canonical.requestedPaymentUuid, transaction_amount: 100, transaction_approved_amount: 100,
    order_currency: "HNL", response_approved: true, response_incomplete: false, status: "COMPLETED" }, [
    "MERCHANT_MISSING_OR_INVALID", "ORDER_MISSING_OR_INVALID", "PAYMENT_UUID_MISSING_OR_INVALID",
  ]);
});

test("expectativa canonica incompleta falla cerrada", () => {
  const result = assessHostedVerificationAcceptance({ candidate: completeCandidate });
  for (const reason of ["CANONICAL_MERCHANT_INVALID", "CANONICAL_ORDER_INVALID", "CANONICAL_PAYMENT_UUID_INVALID",
    "CANONICAL_AMOUNT_INVALID", "CANONICAL_CURRENCY_INVALID"]) assert.ok(result.reasons.includes(reason));
  assert.equal(result.can_confirm, false);
  assert.equal(assessHostedVerificationAcceptance().can_confirm, false);
  assert.equal(assessHostedVerificationAcceptance({ canonical: null, candidate: null }).financial_verified, false);
});

test("checklist es puro: no ejecuta transporte/DB, no muta entrada ni devuelve datos sensibles", () => {
  const candidate = { ...completeCandidate, secretKey: "private-fixture-secret", rawBody: "private-fixture-body" };
  const before = structuredClone(candidate);
  const result = blocked(candidate);
  assert.deepEqual(candidate, before);
  const output = JSON.stringify(result);
  for (const value of [canonical.orderId, canonical.merchantId, canonical.requestedPaymentUuid,
    candidate.transactionId, candidate.secretKey, candidate.rawBody]) assert.equal(output.includes(value), false);
});
