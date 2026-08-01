import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTodoPagoLaunch,
} from "../src/services/payments/todopago/TodoPagoLaunchBuilder.js";

const INPUT = {
  modalUrl: "https://checkout.example.test/modal",
  allowedMessageOrigin: "https://checkout.example.test",
  tokenTodomovil: "opaque-token",
  idTransaccion: "transaction-123",
  amount: 125.5,
  customerName: "Cliente Prueba",
  ordenDeCompra: "order-123",
  currencyCode: "HNL",
  comentario: "Reserva MasterFade",
  encrypted: "opaque-iv:opaque-cipher",
  expiresAt: "2026-08-01T18:00:00.000Z",
};

test("builder TodoPago retorna el contrato iframe_post exacto", () => {
  const launch = buildTodoPagoLaunch(INPUT);

  assert.deepEqual(launch, {
    type: "iframe_post",
    action: INPUT.modalUrl,
    method: "POST",
    fields: {
      tokenTodomovil: INPUT.tokenTodomovil,
      idTransaccion: INPUT.idTransaccion,
      amount: "125.50",
      customerName: INPUT.customerName,
      ordenDeCompra: INPUT.ordenDeCompra,
      currencyCode: INPUT.currencyCode,
      comentario: INPUT.comentario,
      encrypted: INPUT.encrypted,
    },
    allowedMessageOrigin: INPUT.allowedMessageOrigin,
    expiresAt: INPUT.expiresAt,
  });
  assert.equal(Object.hasOwn(launch.fields, "ip"), false);
});

for (const [amount, expected] of [[1, "1.00"], [1.5, "1.50"]]) {
  test(`builder TodoPago convierte ${amount} a ${expected}`, () => {
    assert.equal(buildTodoPagoLaunch({ ...INPUT, amount }).fields.amount, expected);
  });
}

for (const comentario of ["", "   ", null, undefined]) {
  test(`builder TodoPago omite comentario vacio: ${String(comentario)}`, () => {
    const launch = buildTodoPagoLaunch({ ...INPUT, comentario });
    assert.equal(Object.hasOwn(launch.fields, "comentario"), false);
  });
}

test("builder TodoPago rechaza modalUrl HTTP", () => {
  assert.throws(
    () => buildTodoPagoLaunch({ ...INPUT, modalUrl: "http://checkout.example.test/modal" }),
    (error) => error.code === "TODOPAGO_LAUNCH_URL_INVALID"
  );
});

test("builder TodoPago normaliza allowedMessageOrigin con path unicamente al origin", () => {
  const launch = buildTodoPagoLaunch({
    ...INPUT,
    allowedMessageOrigin: "https://checkout.example.test/messages/result?source=test",
  });
  assert.equal(launch.allowedMessageOrigin, "https://checkout.example.test");
});

test("builder TodoPago exige currencyCode sin usar valor predeterminado", () => {
  assert.throws(
    () => buildTodoPagoLaunch({ ...INPUT, currencyCode: "" }),
    (error) => error.code === "TODOPAGO_LAUNCH_FIELD_REQUIRED"
  );
});

test("builder TodoPago no muta el objeto recibido", () => {
  const source = { ...INPUT };
  const snapshot = structuredClone(source);
  Object.freeze(source);

  buildTodoPagoLaunch(source);

  assert.deepEqual(source, snapshot);
});
