import assert from "node:assert/strict";
import test from "node:test";
import { canStartPixelPaySale } from "../src/routes/v1/public/pagos.js";

test("doble submit no puede iniciar otro sale cuando el intent ya fue reclamado", () => {
  assert.equal(canStartPixelPaySale("link_generado"), true);
  assert.equal(canStartPixelPaySale("pendiente_confirmacion"), false);
  assert.equal(canStartPixelPaySale("confirmado"), false);
  assert.equal(canStartPixelPaySale("fallido"), false);
});
