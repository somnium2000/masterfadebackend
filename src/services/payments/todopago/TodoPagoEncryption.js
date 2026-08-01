import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const AES_ALGORITHM = "aes-256-cbc";
const AES_IV_LENGTH = 16;

export class TodoPagoEncryptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TodoPagoEncryptionError";
    this.code = code;
  }
}

function requireNonEmptyText(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TodoPagoEncryptionError(
      "TODOPAGO_ENCRYPTION_INPUT_REQUIRED",
      `Datos de cifrado TodoPago incompletos: ${fieldName}.`
    );
  }
  return value;
}

function resolveIv(testIv) {
  if (testIv == null) return randomBytes(AES_IV_LENGTH);
  if (!Buffer.isBuffer(testIv) && !(testIv instanceof Uint8Array)) {
    throw new TodoPagoEncryptionError(
      "TODOPAGO_ENCRYPTION_IV_INVALID",
      "El IV de cifrado TodoPago debe tener exactamente 16 bytes."
    );
  }

  const iv = Buffer.from(testIv);
  if (iv.length !== AES_IV_LENGTH) {
    throw new TodoPagoEncryptionError(
      "TODOPAGO_ENCRYPTION_IV_INVALID",
      "El IV de cifrado TodoPago debe tener exactamente 16 bytes."
    );
  }
  return iv;
}

export function encryptTodoPagoData({
  secret,
  ip,
  userTodopago,
  passwordTodopago,
  tenantId,
  terminalNbr,
} = {}, { testIv } = {}) {
  const encryptionSecret = requireNonEmptyText(secret, "secret");
  const payload = {
    ip: requireNonEmptyText(ip, "ip"),
    userTodopago: requireNonEmptyText(userTodopago, "userTodopago"),
    passwordTodopago: requireNonEmptyText(passwordTodopago, "passwordTodopago"),
    tenantId: requireNonEmptyText(tenantId, "tenantId"),
    terminalNbr: requireNonEmptyText(terminalNbr, "terminalNbr"),
  };
  const iv = resolveIv(testIv);
  const key = createHash("sha256").update(encryptionSecret, "utf8").digest();
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return `${iv.toString("base64")}:${encrypted.toString("base64")}`;
}
