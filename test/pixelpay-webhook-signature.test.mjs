import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createPixelPayWebhookSignature,
  inspectPixelPayWebhookSignature,
} from "../src/services/payments/pixelPayWebhookSignature.js";

const SECRET = "synthetic-webhook-secret-not-real";
const RAW_BODY = JSON.stringify({ uuid: "synthetic-payment", status: "paid", amount: 100 });
const SIGNATURE = createHmac("sha3-512", SECRET).update(Buffer.from(RAW_BODY, "utf8")).digest("hex");

test("firma PixelPay entrante valida HMAC SHA3-512 sobre el cuerpo crudo", () => {
  assert.equal(createPixelPayWebhookSignature(RAW_BODY, SECRET), SIGNATURE);
  for (const headerName of ["x-client-signature", "x-signature"]) {
    const result = inspectPixelPayWebhookSignature({
      headers: { [headerName]: SIGNATURE },
      rawBody: RAW_BODY,
      secretKey: SECRET,
    });
    assert.deepEqual(result, {
      present: true,
      ambiguous: false,
      headerCount: 1,
      headerName,
      formatValid: true,
      rawBodyAvailable: true,
      valid: true,
      enforced: false,
    });
  }
});

test("firma PixelPay invalida, ausente o con cuerpo alterado nunca valida", () => {
  const invalid = inspectPixelPayWebhookSignature({
    headers: { "x-client-signature": "0".repeat(128) },
    rawBody: RAW_BODY,
    secretKey: SECRET,
  });
  assert.equal(invalid.present, true);
  assert.equal(invalid.formatValid, true);
  assert.equal(invalid.valid, false);

  const absent = inspectPixelPayWebhookSignature({ rawBody: RAW_BODY, secretKey: SECRET });
  assert.equal(absent.present, false);
  assert.equal(absent.valid, false);

  const altered = inspectPixelPayWebhookSignature({
    headers: { "x-signature": SIGNATURE },
    rawBody: `${RAW_BODY} `,
    secretKey: SECRET,
  });
  assert.equal(altered.formatValid, true);
  assert.equal(altered.valid, false);
});

test("headers de firma duplicados o ambiguos se invalidan antes de comparar", () => {
  for (const rawHeaders of [
    ["x-client-signature", SIGNATURE, "x-client-signature", SIGNATURE],
    ["x-client-signature", SIGNATURE, "x-signature", SIGNATURE],
  ]) {
    const result = inspectPixelPayWebhookSignature({
      rawHeaders,
      rawBody: RAW_BODY,
      secretKey: SECRET,
    });
    assert.equal(result.present, true);
    assert.equal(result.ambiguous, true);
    assert.equal(result.headerCount, 2);
    assert.equal(result.formatValid, false);
    assert.equal(result.valid, false);
  }
});

test("un reenvio byte por byte conserva firma valida sin exponer firma ni secreto", () => {
  const request = {
    headers: { "x-client-signature": SIGNATURE.toUpperCase() },
    rawBody: Buffer.from(RAW_BODY, "utf8"),
    secretKey: SECRET,
  };
  const first = inspectPixelPayWebhookSignature(request);
  const replay = inspectPixelPayWebhookSignature(request);
  assert.deepEqual(replay, first);
  assert.equal(replay.valid, true);
  assert.doesNotMatch(JSON.stringify(replay), new RegExp(SIGNATURE, "i"));
  assert.doesNotMatch(JSON.stringify(replay), new RegExp(SECRET));
});
