import { AppError } from "../utils/errors.js";

export async function confirmAppointmentWithoutPayment(client, {
  id_cita,
  motivo_confirmacion = "simulacion_sin_pago",
} = {}) {
  const appointmentId = String(id_cita || "").trim();
  if (!appointmentId) {
    throw new AppError(400, "id_cita es obligatorio para confirmar cita", {
      code: "APPOINTMENT_CONFIRM_ID_REQUIRED",
    });
  }

  const appointmentUpdate = await client.query(
    `
      UPDATE public.citas
      SET estado_cita_codigo = 'confirmada',
          updated_at = now()
      WHERE id_cita = $1::uuid
        AND deleted_at IS NULL
        AND estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada')
      RETURNING id_cita, estado_cita_codigo
    `,
    [appointmentId]
  );

  if (!appointmentUpdate.rows[0]) {
    throw new AppError(409, "La cita no se puede confirmar sin pago en su estado actual", {
      code: "APPOINTMENT_CONFIRM_STATE_INVALID",
      details: { id_cita: appointmentId },
    });
  }

  await client.query(
    `
      UPDATE public.citas_holds
      SET estado_hold_codigo = 'consumido',
          updated_at = now()
      WHERE id_cita = $1::uuid
        AND estado_hold_codigo = 'activo'
    `,
    [appointmentId]
  );

  await client.query(
    `
      UPDATE public.payment_intents
      SET estado_intent_codigo = 'expirado',
          updated_at = now()
      WHERE id_cita = $1::uuid
        AND estado_intent_codigo IN ('creado', 'link_generado', 'pendiente_confirmacion')
    `,
    [appointmentId]
  );

  await client.query(
    `
      INSERT INTO public.audit_logs (accion, metadata, created_at)
      VALUES (
        'cita_confirmada_sin_pago',
        jsonb_build_object(
          'id_cita', $1::uuid,
          'motivo_confirmacion', $2::text
        ),
        now()
      )
    `,
    [appointmentId, String(motivo_confirmacion || "simulacion_sin_pago")]
  ).catch(() => {
    // Compatibilidad: algunos entornos no tienen audit_logs.
  });

  return appointmentUpdate.rows[0];
}

export async function confirmAppointmentsWithoutPayment(client, {
  citas = [],
  motivo_confirmacion = "simulacion_sin_pago",
} = {}) {
  const ids = Array.isArray(citas) ? citas.map((item) => String(item || "").trim()).filter(Boolean) : [];
  for (const citaId of ids) {
    await confirmAppointmentWithoutPayment(client, {
      id_cita: citaId,
      motivo_confirmacion,
    });
  }
  return ids.length;
}
