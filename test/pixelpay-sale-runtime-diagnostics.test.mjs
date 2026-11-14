import assert from "node:assert/strict";
import test from "node:test";
import { classifyPixelPaySaleRuntimeError, sanitizePixelPaySaleRuntimeDiagnostics } from "../src/services/payments/pixelPaySaleRuntime.js";
import { buildPixelPaySaleEvent, createPixelPaySaleAttempt } from "../src/services/payments/pixelPaySaleTelemetry.js";

const received = { executionPhase: "response_processing", httpResponseReceived: true, requestMayHaveBeenSent: true, statusCode: 200 };

test("runtime diagnostics separate JavaScript, transport and response parsing failures", () => {
  for (const [error, execution, expected] of [
    [new ReferenceError("document is not defined"), received, "SDK_REFERENCE_ERROR"],
    [new TypeError("private payload"), received, "SDK_RUNTIME_ERROR"],
    [new SyntaxError("private body"), received, "SDK_RESPONSE_PARSE_ERROR"],
    [Object.assign(new Error("private socket detail"), { code: "ECONNRESET" }), {}, "SDK_NETWORK_ERROR"],
    [Object.assign(new Error("private timeout detail"), { code: "ETIMEDOUT" }), {}, "SDK_HTTP_TIMEOUT"],
    [new Error("arbitrary message"), {}, "SDK_RUNTIME_ERROR"],
  ]) {
    assert.equal(classifyPixelPaySaleRuntimeError(error, execution).safeMessageCode, expected);
  }
});

test("runtime logs retain only allowlisted symbol and relative SDK frame", () => {
  const secret = "sentinel-secret-that-must-never-be-logged";
  const error = new ReferenceError("document is not defined");
  error.stack = `ReferenceError: ${secret}\n    at loadPayload (/private/${secret}/node_modules/@pixelpay/sdk-core/lib/libraries/PayloadManager.js:43:35)\n    at secret (https://evil.invalid/${secret}:8:9)`;
  const details = classifyPixelPaySaleRuntimeError(error, received);
  assert.equal(details.referenceSymbol, "document");
  assert.equal(details.sdkStackFile, "lib/libraries/PayloadManager.js");
  assert.equal(details.sdkStackLine, 43);
  assert.equal(details.sdkStackColumn, 35);
  const event = buildPixelPaySaleEvent("PIXELPAY_SALE_FAILED", createPixelPaySaleAttempt({ env: "live" }), {
    ...details, message: secret, stack: error.stack, payload: { card_number: "4111111111111111", cvv: "987" },
  });
  assert.equal(event.env, "live");
  assert.equal(event.httpResponseReceived, true);
  assert.equal(event.requestMayHaveBeenSent, true);
  assert.doesNotMatch(JSON.stringify(event), /sentinel-secret|4111111111111111|987|evil[.]invalid|private/);
});

test("diagnostic sanitizer rejects injected filenames, symbols, phases and status", () => {
  const result = sanitizePixelPaySaleRuntimeDiagnostics({
    executionPhase: "secret", sdkStackFile: "../../secret.js", sdkStackLine: -1, sdkStackColumn: Infinity,
    referenceSymbol: "secret", httpResponseReceived: "true", requestMayHaveBeenSent: "false", statusCode: "secret",
  });
  for (const key of ["executionPhase", "sdkStackFile", "sdkStackLine", "sdkStackColumn", "referenceSymbol", "httpResponseReceived", "requestMayHaveBeenSent", "statusCode"]) {
    assert.equal(result[key], null, key);
  }
});
