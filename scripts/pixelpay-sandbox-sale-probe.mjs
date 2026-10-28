import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import PixelPaySdk from "@pixelpay/sdk-core";
import { assertPixelPaySandboxCardAllowed } from "../src/routes/v1/public/pagos.js";
import { createPixelPaySaleSignature } from "../src/services/payments/PixelPayDirectProvider.js";

function text(value) {
  return String(value ?? "").trim();
}

function safeIdentifier(value) {
  const normalized = text(value);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized) ? normalized.slice(0, 80) : null;
}

function safeErrorMessage(value) {
  const normalized = text(value).replace(/[\r\n]+/g, " ").slice(0, 160);
  if (!normalized) return null;
  if (/pan|cvv|cardholder|billing|auth[_ -]?(key|hash)|secret|public[_ -]?key|payment[_ -]?hash|x-client-signature|authorization/i.test(normalized)) {
    return "REDACTED";
  }
  return normalized.replace(/\d{3,}/g, "[REDACTED]");
}

function safeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "";
}

function responseStatus(response) {
  const raw = typeof response?.getStatus === "function"
    ? response.getStatus()
    : response?.status;
  const normalized = Number(raw);
  return Number.isInteger(normalized) ? normalized : null;
}

function readTransactionResult(sdk, response) {
  const TransactionResult = sdk.Entities.TransactionResult;
  const valid = TransactionResult.validateResponse(response) === true;
  if (!valid) return { result: null, valid, parsed: false };
  try {
    const result = objectOrNull(TransactionResult.fromResponse(response));
    return { result, valid, parsed: Boolean(result) };
  } catch {
    return { result: null, valid, parsed: false };
  }
}

function writeSafeEvent(write, event, context, details = {}) {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    probeId: context.probeId,
    orderId: context.orderId,
    amount: context.amount,
    currency: context.currency,
  };
  if (event === "AFTER_SALE") {
    Object.assign(payload, {
      responseClass: safeIdentifier(details.responseClass),
      statusCode: Number.isInteger(Number(details.statusCode)) ? Number(details.statusCode) : null,
      success: safeBoolean(details.success),
      outcome: text(details.outcome).slice(0, 80) || null,
      transactionResultValid: safeBoolean(details.transactionResultValid),
      transactionResultParsed: safeBoolean(details.transactionResultParsed),
      responseApproved: safeBoolean(details.responseApproved),
      responseIncomplete: safeBoolean(details.responseIncomplete),
      paymentUuidPresent: safeBoolean(details.paymentUuidPresent),
      transactionIdPresent: safeBoolean(details.transactionIdPresent),
      paymentHashPresent: safeBoolean(details.paymentHashPresent),
      paymentHashValid: safeBoolean(details.paymentHashValid),
      transactionAmountMatches: safeBoolean(details.transactionAmountMatches),
      approvedAmountMatches: safeBoolean(details.approvedAmountMatches),
    });
  } else {
    Object.assign(payload, {
      outcome: text(details.outcome).slice(0, 80) || null,
      errorName: safeIdentifier(details.errorName),
      errorMessage: safeErrorMessage(details.errorMessage),
    });
  }
  write(JSON.stringify(payload));
}

function buildModels(sdk, env, context) {
  const settings = new sdk.Models.Settings();
  settings.setupSandbox();

  const order = new sdk.Models.Order();
  order.id = context.orderId;
  order.currency = context.currency;
  order.amount = context.amount;
  order.customer_name = "PIXELPAY SANDBOX PROBE";
  order.customer_email = "pixelpay-probe@masterfade.invalid";

  const card = new sdk.Models.Card();
  card.number = assertPixelPaySandboxCardAllowed(env.PIXELPAY_PROBE_CARD_NUMBER);
  card.cardholder = "PIXELPAY SANDBOX PROBE";
  card.expire_month = Number(env.PIXELPAY_PROBE_CARD_EXPIRE_MONTH);
  card.expire_year = Number(env.PIXELPAY_PROBE_CARD_EXPIRE_YEAR);
  card.cvv2 = text(env.PIXELPAY_PROBE_CARD_CVV);

  const billing = new sdk.Models.Billing();
  billing.address = "Tegucigalpa Sandbox";
  billing.country = "HN";
  billing.state = "HN-FM";
  billing.city = "Tegucigalpa";
  billing.phone = "99999999";

  const sale = new sdk.Requests.SaleTransaction();
  sale.setOrder(order);
  sale.setCard(card);
  sale.setBilling(billing);
  const models = { settings, order, card, billing, sale };
  const expectedTypes = [
    ["Settings", settings, sdk.Models.Settings],
    ["Order", order, sdk.Models.Order],
    ["Card", card, sdk.Models.Card],
    ["Billing", billing, sdk.Models.Billing],
    ["SaleTransaction", sale, sdk.Requests.SaleTransaction],
  ];
  for (const [name, value, Constructor] of expectedTypes) {
    if (typeof Constructor !== "function" || !(value instanceof Constructor)) {
      throw new TypeError(`INVALID_${name.toUpperCase()}_MODEL`);
    }
  }
  return models;
}

export async function runPixelPaySandboxSaleProbe({
  env = process.env,
  sdk = PixelPaySdk,
  write = (line) => process.stdout.write(`${line}\n`),
  randomUUID = crypto.randomUUID,
  createService = (settings) => new sdk.Services.Transaction(settings),
} = {}) {
  const context = {
    probeId: randomUUID(),
    orderId: `MF-QA-PROBE-${Date.now()}-${randomUUID().slice(0, 8)}`,
    amount: 1,
    currency: "HNL",
  };
  writeSafeEvent(write, "PROBE_START", context);

  if (text(env.PIXELPAY_ENV).toLowerCase() !== "sandbox") {
    writeSafeEvent(write, "SALE_ERROR", context, { outcome: "ERROR", errorName: "ENV_NOT_SANDBOX" });
    return { exitCode: 2, saleCount: 0, outcome: "ERROR", context };
  }
  if (text(env.PIXELPAY_ENDPOINT).replace(/\/+$/, "") !== "https://pixelpay.dev") {
    writeSafeEvent(write, "SALE_ERROR", context, { outcome: "ERROR", errorName: "ENDPOINT_NOT_SANDBOX" });
    return { exitCode: 2, saleCount: 0, outcome: "ERROR", context };
  }
  let saleCount = 0;
  try {
    const models = buildModels(sdk, env, context);
    if (text(env.PIXELPAY_PROBE_DRY_RUN).toLowerCase() === "true") {
      writeSafeEvent(write, "DRY_RUN_OK", context, { outcome: "DRY_RUN" });
      return { exitCode: 0, saleCount: 0, outcome: "DRY_RUN", context };
    }
    const signature = createPixelPaySaleSignature({
      secretKey: env.PIXELPAY_SECRET_KEY,
      appKey: env.PIXELPAY_KEY_ID,
      orderId: context.orderId,
      appUrl: env.PIXELPAY_APP_URL,
    });
    models.settings.setupHeaders({ "x-client-signature": signature });
    const service = createService(models.settings);
    writeSafeEvent(write, "BEFORE_SALE", context);
    saleCount = 1;
    const response = await service.doSale(models.sale);
    const statusCode = responseStatus(response);
    const transactionResult = readTransactionResult(sdk, response);
    const result = transactionResult.result;
    const paymentUuidPresent = Boolean(text(result?.payment_uuid));
    const transactionIdPresent = Boolean(text(result?.transaction_id));
    const paymentHashPresent = Boolean(text(result?.payment_hash));
    let paymentHashValid = false;
    if (paymentHashPresent) {
      try {
        paymentHashValid = service.verifyPaymentHash(
          result.payment_hash,
          context.orderId,
          env.PIXELPAY_SECRET_KEY
        ) === true;
      } catch {
        paymentHashValid = false;
      }
    }
    const transactionAmountMatches = money(result?.transaction_amount) === money(context.amount);
    const approvedAmountMatches = money(result?.transaction_approved_amount) === money(context.amount);
    const approved = statusCode != null
      && statusCode >= 200
      && statusCode < 300
      && response?.success === true
      && transactionResult.valid
      && transactionResult.parsed
      && result?.response_approved === true
      && result?.response_incomplete === false
      && paymentUuidPresent
      && transactionIdPresent
      && paymentHashPresent
      && paymentHashValid
      && transactionAmountMatches
      && approvedAmountMatches;
    const outcome = approved ? "APPROVED" : "UNCERTAIN";
    writeSafeEvent(write, "AFTER_SALE", context, {
      responseClass: response?.constructor?.name,
      statusCode,
      success: response?.success,
      outcome,
      transactionResultValid: transactionResult.valid,
      transactionResultParsed: transactionResult.parsed,
      responseApproved: typeof result?.response_approved === "boolean" ? result.response_approved : null,
      responseIncomplete: typeof result?.response_incomplete === "boolean" ? result.response_incomplete : null,
      paymentUuidPresent,
      transactionIdPresent,
      paymentHashPresent,
      paymentHashValid,
      transactionAmountMatches,
      approvedAmountMatches,
    });
    return { exitCode: approved ? 0 : 3, saleCount, outcome, context };
  } catch (error) {
    writeSafeEvent(write, "SALE_ERROR", context, {
      outcome: saleCount === 1 ? "UNCERTAIN" : "ERROR",
      errorName: error?.name,
      errorMessage: error?.message,
    });
    return {
      exitCode: saleCount === 1 ? 3 : 2,
      saleCount,
      outcome: saleCount === 1 ? "UNCERTAIN" : "ERROR",
      context,
    };
  }
}

async function main() {
  try {
    const result = await runPixelPaySandboxSaleProbe();
    process.exitCode = result.exitCode;
  } catch {
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
