INSERT INTO public.servicios (id_servicio, nombre_servicio, duracion_min, buffer_min)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Corte fixture', 30, 5);

INSERT INTO public.servicios_tarifas (
  id_tarifa,
  id_servicio,
  id_sucursal,
  id_empleado,
  precio_hnl,
  incluye_isv,
  isv_porcentaje,
  duracion_min,
  buffer_min,
  vigente_desde,
  activo
)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  300.00,
  false,
  15.00,
  30,
  5,
  '2026-07-01',
  true
);

INSERT INTO public.citas_grupos (id_grupo_cita)
VALUES ('99999999-9999-4999-8999-999999999999');

INSERT INTO public.citas (
  id_cita,
  id_grupo_cita,
  id_sucursal,
  id_empleado_barbero,
  inicio_at,
  fin_at,
  duracion_total_min,
  buffer_total_min,
  subtotal_servicios_hnl,
  total_pagar_hnl
)
VALUES
  (
    '66666666-6666-4666-8666-666666666666',
    '99999999-9999-4999-8999-999999999999',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    '2026-07-15T15:00:00Z',
    '2026-07-15T15:35:00Z',
    30,
    5,
    300,
    300
  ),
  (
    '77777777-7777-4777-8777-777777777777',
    '99999999-9999-4999-8999-999999999999',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    '2026-07-15T16:00:00Z',
    '2026-07-15T16:35:00Z',
    30,
    5,
    300,
    300
  );

INSERT INTO public.citas_detalles (
  id_cita_detalle,
  id_cita,
  id_servicio,
  cantidad,
  duracion_min,
  buffer_min,
  precio_unitario_hnl,
  subtotal_hnl,
  nombre_servicio_snapshot
)
VALUES (
  '88888888-8888-4888-8888-888888888888',
  '66666666-6666-4666-8666-666666666666',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  1,
  30,
  5,
  300.00,
  300.00,
  'Corte fixture'
);

INSERT INTO public.payment_intents (id_intent, id_cita, monto_hnl)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  300.00
);
