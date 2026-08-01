import assert from "node:assert/strict";
import {
  createDecipheriv,
  createHash,
} from "node:crypto";
import test from "node:test";
import {
  encryptTodoPagoData,
} from "../src/services/payments/todopago/TodoPagoEncryption.js";

const FIXED_IV = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
const INPUT = {
  secret: "unit-test-secret",
  ip: "192.0.2.10",
  userTodopago: "test-user",
  passwordTodopago: "test-password",
  tenantId: "tenant-001",
  terminalNbr: "terminal-001",
};
const EXPECTED_PAYLOAD = {
  ip: INPUT.ip,
  userTodopago: INPUT.userTodopago,
  passwordTodopago: INPUT.passwordTodopago,
  tenantId: INPUT.tenantId,
  terminalNbr: INPUT.terminalNbr,
};
const DETERMINISTIC_VECTOR = "AAECAwQFBgcICQoLDA0ODw==:f1HqCIFVhcNVUqv/Y8oYvc9sCab9h+jHx+MC7L00L6CA8oXjGpAWoR/uOM5jxXb+w1EqI8LYhvRkc0b0UFDw5bfkM3o708B+4r8zp74zXCvkSmVwlVwufPuqMuUp78W3VxX2oUZ74oCADc6GzkIak/JgHlww3fNhoFeim63N0Vtrg64NVRuYwewn2wHgtztN";

function decryptResult(result, secret) {
  const [ivBase64, cipherBase64] = result.split(":");
  const key = createHash("sha256").update(secret, "utf8").digest();
  const decipher = createDecipheriv(
    "aes-256-cbc",
    key,
    Buffer.from(ivBase64, "base64")
  );
  return Buffer.concat([
    decipher.update(Buffer.from(cipherBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

test("cifrado TodoPago retorna exclusivamente el formato ivBase64:cipherBase64", () => {
  const result = encryptTodoPagoData(INPUT, { testIv: FIXED_IV });
  const parts = result.split(":");

  assert.equal(parts.length, 2);
  assert.match(parts[0], /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(parts[1], /^[A-Za-z0-9+/]+={0,2}$/);
});

test("IV Base64 del cifrado TodoPago decodifica a exactamente 16 bytes", () => {
  const [ivBase64] = encryptTodoPagoData(INPUT, { testIv: FIXED_IV }).split(":");
  assert.equal(Buffer.from(ivBase64, "base64").length, 16);
});

test("cifrado TodoPago coincide con el vector deterministico de IV fijo", () => {
  assert.equal(
    encryptTodoPagoData(INPUT, { testIv: FIXED_IV }),
    DETERMINISTIC_VECTOR
  );
});

test("descifrado de prueba recupera el JSON exacto requerido por TodoPago", () => {
  const result = encryptTodoPagoData(INPUT, { testIv: FIXED_IV });
  const decrypted = decryptResult(result, INPUT.secret);

  assert.equal(decrypted, JSON.stringify(EXPECTED_PAYLOAD));
  assert.deepEqual(JSON.parse(decrypted), EXPECTED_PAYLOAD);
});

test("dos cifrados con IV aleatorio producen resultados diferentes", () => {
  const first = encryptTodoPagoData(INPUT);
  const second = encryptTodoPagoData(INPUT);
  assert.notEqual(first, second);
});

for (const fieldName of [
  "secret",
  "ip",
  "userTodopago",
  "passwordTodopago",
  "tenantId",
  "terminalNbr",
]) {
  test(`cifrado TodoPago rechaza ${fieldName} vacio`, () => {
    assert.throws(
      () => encryptTodoPagoData({ ...INPUT, [fieldName]: "  " }),
      (error) => error.code === "TODOPAGO_ENCRYPTION_INPUT_REQUIRED"
    );
  });
}

test("cifrado TodoPago rechaza IV que no tenga 16 bytes", () => {
  assert.throws(
    () => encryptTodoPagoData(INPUT, { testIv: Buffer.alloc(15) }),
    (error) => error.code === "TODOPAGO_ENCRYPTION_IV_INVALID"
  );
});

test("errores de cifrado TodoPago no exponen secretos", () => {
  const sensitiveInput = {
    ...INPUT,
    secret: "sensitive-encryption-secret",
    userTodopago: "sensitive-user",
    passwordTodopago: "sensitive-password",
  };
  const secrets = [
    sensitiveInput.secret,
    sensitiveInput.userTodopago,
    sensitiveInput.passwordTodopago,
  ];

  assert.throws(
    () => encryptTodoPagoData(sensitiveInput, { testIv: Buffer.alloc(17) }),
    (error) => {
      const serializedError = `${error.message}\n${error.stack}`;
      assert.equal(secrets.some((secret) => serializedError.includes(secret)), false);
      return true;
    }
  );
});
