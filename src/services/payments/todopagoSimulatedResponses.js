const TODO_PAGO_SIMULATED_RESPONSES = new Map([
  ["1.00", { amountKey: "1.00", responseCode: "00", responseText: "APPROVAL 599" }],
  ["1.01", { amountKey: "1.01", responseCode: "01", responseText: "CALL" }],
  ["1.02", { amountKey: "1.02", responseCode: "02", responseText: "CALL" }],
  ["1.03", { amountKey: "1.03", responseCode: "03", responseText: "TERM ID ERROR" }],
  ["1.04", { amountKey: "1.04", responseCode: "04", responseText: "HOLD-CALL" }],
  ["1.05", { amountKey: "1.05", responseCode: "05", responseText: "DECLINE" }],
  ["1.06", { amountKey: "1.06", responseCode: "06", responseText: "ERROR" }],
  ["1.07", { amountKey: "1.07", responseCode: "07", responseText: "HOLD-CALL" }],
  ["1.09", { amountKey: "1.09", responseCode: "12", responseText: "INVALID TRANS" }],
  ["1.10", { amountKey: "1.10", responseCode: "13", responseText: "AMOUNT ERROR" }],
  ["1.11", { amountKey: "1.11", responseCode: "14", responseText: "CARD NO. ERROR" }],
  ["1.12", { amountKey: "1.12", responseCode: "15", responseText: "NO SUCH ISSUER" }],
  ["1.13", { amountKey: "1.13", responseCode: "19", responseText: "RE ENTER" }],
  ["1.14", { amountKey: "1.14", responseCode: "21", responseText: "NO ACTION TAKEN" }],
  ["1.15", { amountKey: "1.15", responseCode: "28", responseText: "NO REPLY" }],
  ["1.18", { amountKey: "1.18", responseCode: "41", responseText: "HOLD-CALL" }],
  ["1.19", { amountKey: "1.19", responseCode: "43", responseText: "HOLD-CALL" }],
  ["1.20", { amountKey: "1.20", responseCode: "51", responseText: "DECLINE" }],
  ["1.21", { amountKey: "1.21", responseCode: "52", responseText: "NO CHECK ACCOUNT" }],
  ["1.22", { amountKey: "1.22", responseCode: "53", responseText: "NO SAVE ACCOUNT" }],
  ["1.23", { amountKey: "1.23", responseCode: "54", responseText: "EXPIRED CARD" }],
  ["1.24", { amountKey: "1.24", responseCode: "55", responseText: "WRONG PIN" }],
  ["1.26", { amountKey: "1.26", responseCode: "57", responseText: "SERV NOT ALLOWED" }],
  ["1.27", { amountKey: "1.27", responseCode: "58", responseText: "SERV NOT ALLOWED" }],
  ["1.29", { amountKey: "1.29", responseCode: "61", responseText: "DECLINE" }],
  ["1.30", { amountKey: "1.30", responseCode: "62", responseText: "DECLINE" }],
  ["1.31", { amountKey: "1.31", responseCode: "63", responseText: "SEC VIOLATION" }],
  ["1.32", { amountKey: "1.32", responseCode: "65", responseText: "DECLINE" }],
  ["1.33", { amountKey: "1.33", responseCode: "75", responseText: "PIN EXCEEDED" }],
  ["1.34", { amountKey: "1.34", responseCode: "76", responseText: "NO ACTION TAKEN" }],
  ["1.35", { amountKey: "1.35", responseCode: "77", responseText: "NO ACTION TAKEN" }],
  ["1.38", { amountKey: "1.38", responseCode: "80", responseText: "DATE ERROR" }],
  ["1.39", { amountKey: "1.39", responseCode: "81", responseText: "ENCRYPTION ERROR" }],
  ["1.40", { amountKey: "1.40", responseCode: "82", responseText: "CASHBACK NOT APP" }],
  ["1.41", { amountKey: "1.41", responseCode: "83", responseText: "CANT VERIFY PIN" }],
  ["1.42", { amountKey: "1.42", responseCode: "85", responseText: "NOT DECLINED" }],
  ["1.45", { amountKey: "1.45", responseCode: "91", responseText: "NO REPLY" }],
  ["1.46", { amountKey: "1.46", responseCode: "92", responseText: "INVALID ROUTING" }],
  ["1.47", { amountKey: "1.47", responseCode: "93", responseText: "DECLINE" }],
  ["1.48", { amountKey: "1.48", responseCode: "94", responseText: "DUP TRANS" }],
  ["1.49", { amountKey: "1.49", responseCode: "96", responseText: "SYSTEM ERROR" }],
  ["1.51", { amountKey: "1.51", responseCode: "EB", responseText: "CHECK DIGIT ERR" }],
  ["1.53", { amountKey: "1.53", responseCode: "ER", responseText: "ERROR" }],
  ["1.54", { amountKey: "1.54", responseCode: "N3", responseText: "CASHBACK NOT AVL" }],
  ["1.55", { amountKey: "1.55", responseCode: "N4", responseText: "DECLINE" }],
  ["1.56", { amountKey: "1.56", responseCode: "N7", responseText: "CVV2 MISMATCH" }],
  ["1.57", { amountKey: "1.57", responseCode: "TO", responseText: "TIMEOUT" }],
  ["1.59", { amountKey: "1.59", responseCode: "10", responseText: "Partial Approval/Authorization" }],
]);

function normalizeAmountKey(montoHnl) {
  const amount = Number(montoHnl);
  if (!Number.isFinite(amount)) return null;
  return amount.toFixed(2);
}

function buildUserMessage(responseCode, responseText, normalizedStatus) {
  switch (normalizedStatus) {
    case "PAID":
      return "Pago aprobado correctamente.";
    case "PENDING":
      if (responseCode === "TO") return "El pago sigue pendiente de confirmacion por timeout del proveedor.";
      if (responseCode === "28" || responseCode === "91") return "El pago sigue pendiente de confirmacion del proveedor.";
      return "El pago requiere validacion adicional antes de confirmar.";
    default:
      if (responseCode === "96" || responseCode === "06" || responseCode === "ER") {
        return "El simulador reporto un error de sistema. Intenta nuevamente.";
      }
      if (responseCode === "54") return "La tarjeta reportada por el simulador esta vencida.";
      if (responseCode === "N7") return "El codigo CVV reportado por el simulador es incorrecto.";
      if (responseCode === "05" || responseCode === "51" || responseCode === "61" || responseCode === "62" || responseCode === "65" || responseCode === "93" || responseCode === "N4") {
        return "El pago fue rechazado por el simulador del proveedor.";
      }
      return `El pago no fue aprobado por el simulador (${responseText || responseCode || "sin detalle"}).`;
  }
}

export function normalizeTodoPagoResponse(responseCode, responseText = "") {
  const code = String(responseCode || "").trim().toUpperCase();
  const text = String(responseText || "").trim().toUpperCase();
  let normalizedStatus = "FAILED";

  if (code === "00") {
    normalizedStatus = "PAID";
  } else if (["TO", "91", "28"].includes(code)) {
    normalizedStatus = "PENDING";
  } else if (["01", "02", "04", "07", "41", "43"].includes(code)) {
    normalizedStatus = "PENDING";
  } else if (code === "10") {
    normalizedStatus = "FAILED";
  }

  return {
    responseCode: code,
    responseText: text,
    normalizedStatus,
    userMessage: buildUserMessage(code, text, normalizedStatus),
  };
}

export function resolveTodoPagoSimulatedResponse(montoHnl) {
  const amountKey = normalizeAmountKey(montoHnl);
  const resolved = (amountKey && TODO_PAGO_SIMULATED_RESPONSES.get(amountKey))
    || { amountKey: amountKey || "0.00", responseCode: "05", responseText: "DECLINE" };
  const normalized = normalizeTodoPagoResponse(resolved.responseCode, resolved.responseText);
  return {
    amountKey: resolved.amountKey,
    responseCode: resolved.responseCode,
    responseText: resolved.responseText,
    normalizedStatus: normalized.normalizedStatus,
    userMessage: normalized.userMessage,
  };
}

export function listTodoPagoSimulatedResponses() {
  return Array.from(TODO_PAGO_SIMULATED_RESPONSES.values());
}
