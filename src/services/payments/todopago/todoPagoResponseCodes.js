const RESPONSE_CODES = [
  ["00", "APPROVAL", "PAID"],
  ["01", "CALL", "REVIEW"],
  ["02", "CALL", "REVIEW"],
  ["03", "TERM ID ERROR", "ERROR"],
  ["04", "HOLD-CALL", "REVIEW"],
  ["05", "DECLINE", "DECLINED"],
  ["06", "ERROR", "ERROR"],
  ["07", "HOLD-CALL", "REVIEW"],
  ["10", "PARTIAL APPROVAL/AUTHORIZATION", "REVIEW"],
  ["12", "INVALID TRANS", "ERROR"],
  ["13", "AMOUNT ERROR", "ERROR"],
  ["14", "CARD NO. ERROR", "DECLINED"],
  ["15", "NO SUCH ISSUER", "DECLINED"],
  ["19", "RE ENTER", "REVIEW"],
  ["21", "NO ACTION TAKEN", "DECLINED"],
  ["28", "NO REPLY", "TIMEOUT"],
  ["41", "HOLD-CALL", "REVIEW"],
  ["43", "HOLD-CALL", "REVIEW"],
  ["51", "DECLINE", "DECLINED"],
  ["52", "NO CHECK ACCOUNT", "DECLINED"],
  ["53", "NO SAVE ACCOUNT", "DECLINED"],
  ["54", "EXPIRED CARD", "DECLINED"],
  ["55", "WRONG PIN", "DECLINED"],
  ["57", "SERV NOT ALLOWED", "DECLINED"],
  ["58", "SERV NOT ALLOWED", "DECLINED"],
  ["61", "DECLINE", "DECLINED"],
  ["62", "DECLINE", "DECLINED"],
  ["63", "SEC VIOLATION", "DECLINED"],
  ["65", "DECLINE", "DECLINED"],
  ["75", "PIN EXCEEDED", "DECLINED"],
  ["76", "NO ACTION TAKEN", "DECLINED"],
  ["77", "NO ACTION TAKEN", "DECLINED"],
  ["80", "DATE ERROR", "ERROR"],
  ["81", "ENCRYPTION ERROR", "ERROR"],
  ["82", "CASHBACK NOT APP", "DECLINED"],
  ["83", "CANT VERIFY PIN", "DECLINED"],
  ["85", "NOT DECLINED", "REVIEW"],
  ["91", "NO REPLY", "TIMEOUT"],
  ["92", "INVALID ROUTING", "ERROR"],
  ["93", "DECLINE", "DECLINED"],
  ["94", "DUP TRANS", "ERROR"],
  ["96", "SYSTEM ERROR", "ERROR"],
  ["EB", "CHECK DIGIT ERR", "ERROR"],
  ["ER", "ERROR", "ERROR"],
  ["N3", "CASHBACK NOT AVL", "DECLINED"],
  ["N4", "DECLINE", "DECLINED"],
  ["N7", "CVV2 MISMATCH", "DECLINED"],
  ["TO", "TIMEOUT", "TIMEOUT"],
];

export const TODO_PAGO_RESPONSE_CODES = Object.freeze(
  RESPONSE_CODES.map(([code, description, normalizedStatus]) => Object.freeze({
    code,
    description,
    normalizedStatus,
    known: true,
  }))
);

const RESPONSE_CODE_BY_CODE = new Map(
  TODO_PAGO_RESPONSE_CODES.map((entry) => [entry.code, entry])
);

export function getTodoPagoResponseCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return RESPONSE_CODE_BY_CODE.get(code) || Object.freeze({
    code: code || "UNKNOWN",
    description: "Codigo de respuesta TodoPago no reconocido.",
    normalizedStatus: "REVIEW",
    known: false,
  });
}
