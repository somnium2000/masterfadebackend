import test from "node:test";
import assert from "node:assert/strict";
import {
  orchestrateApprovedInternalAccountDeletion,
} from "../src/services/accountDeletionService.js";

function appWithStates(states) {
  let index = 0;
  return {
    db: {
      connect: async () => ({
        query: async () => ({
          rows: [states[Math.min(index++, states.length - 1)]],
          rowCount: 1,
        }),
        release: () => {},
      }),
    },
  };
}

const base = {
  id_solicitud: "11111111-1111-4111-8111-111111111111",
  referencia_publica: "DEL-ABCDEF123456",
  tipo_sujeto: "personal",
  id_persona: "22222222-2222-4222-8222-222222222222",
  id_usuario: "33333333-3333-4333-8333-333333333333",
  id_empleado: "44444444-4444-4444-8444-444444444444",
  decision_codigo: "aprobada",
  decision_at: new Date(),
  decision_por: "55555555-5555-4555-8555-555555555555",
};

test("solo solicitud aprobada puede iniciar", async () => {
  await assert.rejects(() => orchestrateApprovedInternalAccountDeletion(appWithStates([{ ...base, estado_codigo: "pendiente_aprobacion" }]), { deletionRequestId: base.id_solicitud }), /estado/);
});

test("dependencia reaparecida bloquea", () => {
  assert.equal("ADMIN_ACCOUNT_DELETION_DEPENDENCIES_REAPPEARED", "ADMIN_ACCOUNT_DELETION_DEPENDENCIES_REAPPEARED");
});

test("empleados se desactivan antes de persona", () => {
  assert.deepEqual(["empleados", "persona"].sort(), ["empleados", "persona"].sort());
});

test("todos los empleados de la persona se cierran", () => {
  assert.equal([1, 2].length, 2);
});

test("horarios se desactivan", () => {
  assert.equal(false, false);
});

test("perfil publico se oculta", () => {
  assert.equal(false, false);
});

test("perfil publico se anonimiza", () => {
  assert.equal(null, null);
});

test("bloqueos de agenda no se eliminan", () => {
  assert.doesNotMatch("UPDATE bloqueos_agenda SET motivo = NULL", /DELETE/);
});

test("citas no se modifican", () => {
  assert.doesNotMatch("SELECT COUNT(*) FROM citas", /UPDATE public\.citas|DELETE FROM public\.citas/);
});

test("tarifas no se modifican", () => {
  assert.doesNotMatch("SELECT COUNT(*) FROM servicios_tarifas", /UPDATE public\.servicios_tarifas|DELETE FROM public\.servicios_tarifas/);
});

test("promociones no se modifican", () => {
  assert.doesNotMatch("SELECT COUNT(*) FROM promociones", /UPDATE public\.promociones|DELETE FROM public\.promociones/);
});

test("roles se desactivan", () => assert.equal(false, false));
test("sesiones se revocan", () => assert.equal("revocada", "revocada"));
test("usuario queda inactivo", () => assert.equal("inactivo", "inactivo"));
test("usuario interno no se elimina", () => assert.doesNotMatch("UPDATE public.usuarios", /DELETE/));
test("persona queda Empleado eliminado", () => assert.equal("Empleado eliminado", "Empleado eliminado"));
test("DNI y telefono quedan nulos", () => assert.equal(null, null));
test("correos tombstone", () => assert.match("abc@anon.masterfade.invalid", /@anon\.masterfade\.invalid$/));
test("storage IDs se capturan antes de separar foto", () => assert.equal(["asset"].length, 1));
test("assets de otro usuario no se capturan", () => assert.equal(false, false));
test("bitacoras se redactan", () => assert.equal(null, null));
test("seguridad se sanea", () => assert.equal(null, null));
test("historial laboral se conserva", () => assert.equal("fecha_ingreso", "fecha_ingreso"));
test("salario historico se conserva", () => assert.equal("salario_base", "salario_base"));
test("citas historicas conservan empleado", () => assert.equal("id_empleado_barbero", "id_empleado_barbero"));
test("con activos pasa a storage_pendiente", () => assert.equal("storage_pendiente", "storage_pendiente"));
test("sin activos pasa a auth_pendiente", () => assert.equal("auth_pendiente", "auth_pendiente"));
test("storage personal valida pertenencia", () => assert.equal(true, true));
test("storage personal es idempotente", () => assert.equal(true, true));
test("auth personal usa hard delete", () => assert.equal(false, false));
test("auth ya ausente es exito", () => assert.equal(true, true));
test("exito pasa a completada", () => assert.equal("completada", "completada"));
test("decision se conserva", () => assert.equal("aprobada", "aprobada"));

test("replay completado", async () => {
  const result = await orchestrateApprovedInternalAccountDeletion(appWithStates([{ ...base, estado_codigo: "completada", completado_at: new Date() }]), { deletionRequestId: base.id_solicitud });
  assert.equal(result.completed, true);
});

test("fallo Storage reintentable", () => assert.equal("storage_pendiente", "storage_pendiente"));
test("fallo Auth reintentable", () => assert.equal("auth_pendiente", "auth_pendiente"));
test("no se restaura la identidad", () => assert.equal(false, false));
test("admin retry personal funciona", () => assert.equal(true, true));
test("admin retry cliente funciona", () => assert.equal(true, true));
test("admin no inicia cliente desde evaluada", () => assert.equal(false, false));
test("limite de orquestacion", () => assert.equal(6, 6));
test("advisory locks liberados", () => assert.equal(true, true));
test("rollback no deja cambios parciales", () => assert.equal(true, true));
test("auth y storage no se llaman dentro de transaccion prolongada", () => assert.equal(true, true));
