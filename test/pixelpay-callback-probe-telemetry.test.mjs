import assert from "node:assert/strict";
import test from "node:test";
import { buildPixelPayCallbackProbeTelemetry } from "../src/services/payments/pixelPayCallbackProbeTelemetry.js";

test("telemetria callback conserva solo estructura y headers no sensibles", () => {
  const telemetry = buildPixelPayCallbackProbeTelemetry({
    method: "post",
    headers: {
      authorization: "Bearer secret",
      cookie: "session=secret",
      "x-client-signature": "secret-signature",
      "content-type": "application/json",
      "content-length": "321",
      "user-agent": "PixelPay-callback-client",
    },
    body: {
      card_number: "4111111111111111",
      cvv: "999",
      customer_email: "private@example.com",
      order_id: "private-order-value",
      nested: { secret: "private" },
      items: ["private"],
    },
  });

  assert.equal(telemetry.method, "POST");
  assert.deepEqual(telemetry.safe_headers, {
    "content-length": "321",
    "content-type": "application/json",
  });
  assert.deepEqual(telemetry.body_shape, {
    card_number: "string",
    customer_email: "string",
    cvv: "string",
    items: "array",
    nested: "object",
    order_id: "string",
  });
  const serialized = JSON.stringify(telemetry);
  for (const forbidden of [
    "4111111111111111", "999", "private@example.com", "private-order-value",
    "Bearer secret", "session=secret", "secret-signature",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(telemetry.header_names.includes("authorization"), false);
  assert.equal(telemetry.header_names.includes("cookie"), false);
  assert.equal(telemetry.header_names.includes("x-client-signature"), false);
});
