INSERT INTO public.sucursales (id_sucursal, nombre_sucursal)
VALUES ('11111111-1111-4111-8111-111111111111', 'Sucursal fixture');

INSERT INTO public.personas (id_persona, nombres, apellidos)
VALUES
  ('22222222-2222-4222-8222-222222222222', 'Cliente', 'Fixture'),
  ('23232323-2323-4323-8323-232323232323', 'Barbero', 'Fixture'),
  ('24242424-2424-4424-8424-242424242424', 'Barbero Dos', 'Fixture');

INSERT INTO public.clientes (id_cliente, id_persona)
VALUES ('12121212-1212-4212-8212-121212121212', '22222222-2222-4222-8222-222222222222');

INSERT INTO public.usuarios (id_usuario, id_persona)
VALUES ('13131313-1313-4313-8313-131313131313', '22222222-2222-4222-8222-222222222222');

INSERT INTO public.empleados (id_empleado, id_sucursal, id_persona, es_barbero)
VALUES
  (
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    '23232323-2323-4323-8323-232323232323',
    true
  ),
  (
    '34343434-3434-4434-8434-343434343434',
    '11111111-1111-4111-8111-111111111111',
    '24242424-2424-4424-8424-242424242424',
    true
  );

INSERT INTO public.horarios_semanales_sucursales (
  id_horario_sucursal,
  id_sucursal,
  estado_horario_codigo,
  vigencia_desde
)
VALUES (
  '14141414-1414-4414-8414-141414141414',
  '11111111-1111-4111-8111-111111111111',
  'publicado',
  '2026-01-01'
);

INSERT INTO public.horarios_semanales_sucursales_bloques (
  id_horario_sucursal,
  dia_semana,
  hora_inicio,
  hora_fin
)
SELECT
  '14141414-1414-4414-8414-141414141414',
  day_number,
  time '08:00',
  time '19:00'
FROM generate_series(1, 6) AS day_number;

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
