CREATE SCHEMA IF NOT EXISTS public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE public.sucursales (
  id_sucursal uuid PRIMARY KEY,
  nombre_sucursal text NOT NULL DEFAULT 'Sucursal fixture',
  estado boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.personas (
  id_persona uuid PRIMARY KEY,
  nombres text NOT NULL DEFAULT 'Persona',
  apellidos text NOT NULL DEFAULT 'Fixture',
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.clientes (
  id_cliente uuid PRIMARY KEY,
  id_persona uuid NOT NULL REFERENCES public.personas(id_persona),
  estado boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.usuarios (
  id_usuario uuid PRIMARY KEY,
  id_persona uuid NOT NULL REFERENCES public.personas(id_persona),
  estado boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.empleados (
  id_empleado uuid PRIMARY KEY,
  id_sucursal uuid NOT NULL REFERENCES public.sucursales(id_sucursal),
  id_persona uuid REFERENCES public.personas(id_persona),
  estado boolean NOT NULL DEFAULT true,
  es_barbero boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.parametros_sistema (
  clave text PRIMARY KEY,
  valor_numero numeric,
  valor_booleano boolean,
  descripcion text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bloqueos_agenda (
  id_bloqueo uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_sucursal uuid NOT NULL,
  id_empleado uuid NOT NULL,
  rango tstzrange NOT NULL,
  motivo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.horarios_semanales_sucursales (
  id_horario_sucursal uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_sucursal uuid NOT NULL,
  estado_horario_codigo text NOT NULL DEFAULT 'publicado',
  vigencia_desde date NOT NULL DEFAULT current_date,
  vigencia_hasta date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.horarios_semanales_sucursales_bloques (
  id_horario_sucursal_bloque uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_horario_sucursal uuid NOT NULL REFERENCES public.horarios_semanales_sucursales(id_horario_sucursal),
  dia_semana smallint NOT NULL,
  hora_inicio time NOT NULL,
  hora_fin time NOT NULL
);

CREATE TABLE public.horarios_semanales_empleados (
  id_horario_empleado uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_empleado uuid NOT NULL,
  dia_semana smallint NOT NULL,
  hora_inicio time NOT NULL,
  hora_fin time NOT NULL,
  almuerzo_inicio time,
  almuerzo_fin time,
  activo boolean NOT NULL DEFAULT true
);

CREATE TABLE public.servicios (
  id_servicio uuid PRIMARY KEY,
  nombre_servicio text NOT NULL,
  duracion_min integer NOT NULL,
  buffer_min integer NOT NULL DEFAULT 0
);

CREATE TABLE public.servicios_tarifas (
  id_tarifa uuid PRIMARY KEY,
  id_servicio uuid NOT NULL REFERENCES public.servicios(id_servicio),
  id_sucursal uuid NOT NULL,
  id_empleado uuid,
  precio_hnl numeric(12,2) NOT NULL,
  incluye_isv boolean NOT NULL DEFAULT false,
  isv_porcentaje numeric(5,2) NOT NULL DEFAULT 0,
  duracion_min integer,
  buffer_min integer,
  vigente_desde date NOT NULL,
  vigente_hasta date,
  activo boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.citas_grupos (
  id_grupo_cita uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_sucursal uuid,
  id_persona_titular uuid,
  id_cliente_titular uuid,
  id_usuario_titular uuid,
  origen_codigo text NOT NULL DEFAULT 'publico',
  codigo_reserva text NOT NULL DEFAULT ('MF' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  total_hnl numeric(12,2) NOT NULL DEFAULT 0,
  estado_grupo_codigo text NOT NULL DEFAULT 'activo',
  notas text,
  release_token_hash text,
  release_token_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.citas_integrantes (
  id_cita_integrante uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_grupo_cita uuid NOT NULL REFERENCES public.citas_grupos(id_grupo_cita),
  orden_integrante integer NOT NULL,
  rol_integrante_codigo text NOT NULL,
  tipo_cliente_codigo text NOT NULL,
  id_usuario uuid,
  id_persona uuid,
  id_cliente uuid,
  contacto_nombre_snapshot text,
  contacto_email_snapshot text,
  contacto_telefono_snapshot text,
  alias_integrante text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id_grupo_cita, orden_integrante)
);

CREATE TABLE public.citas (
  id_cita uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_grupo_cita uuid REFERENCES public.citas_grupos(id_grupo_cita),
  id_cita_integrante uuid REFERENCES public.citas_integrantes(id_cita_integrante),
  orden_integrante integer,
  alias_integrante text,
  id_sucursal uuid NOT NULL,
  id_empleado_barbero uuid NOT NULL,
  id_persona_cliente uuid,
  id_cliente uuid,
  creada_por_usuario_id uuid,
  asignada_automaticamente boolean NOT NULL DEFAULT false,
  inicio_at timestamptz NOT NULL,
  fin_at timestamptz NOT NULL,
  duracion_total_min integer NOT NULL DEFAULT 0,
  buffer_total_min integer NOT NULL DEFAULT 0,
  subtotal_servicios_hnl numeric(12,2) NOT NULL DEFAULT 0,
  descuento_hnl numeric(12,2) NOT NULL DEFAULT 0,
  total_pagar_hnl numeric(12,2) NOT NULL DEFAULT 0,
  estado_cita_codigo text NOT NULL DEFAULT 'en_espera',
  es_canje_recompensa boolean NOT NULL DEFAULT false,
  selection_type text NOT NULL DEFAULT 'services',
  id_paquete uuid,
  contacto_nombre text,
  contacto_email text,
  contacto_telefono text,
  notas text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.citas
  ADD CONSTRAINT ex_citas_solape_barbero
  EXCLUDE USING gist (
    id_empleado_barbero WITH =,
    tstzrange(inicio_at, fin_at, '[)') WITH &&
  )
  WHERE (
    deleted_at IS NULL
    AND estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion')
  );

CREATE TABLE public.citas_detalles (
  id_cita_detalle uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cita uuid NOT NULL REFERENCES public.citas(id_cita),
  id_servicio uuid NOT NULL REFERENCES public.servicios(id_servicio),
  cantidad integer NOT NULL DEFAULT 1,
  duracion_min integer NOT NULL,
  buffer_min integer NOT NULL DEFAULT 0,
  precio_unitario_hnl numeric(12,2) NOT NULL,
  subtotal_hnl numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  id_cita_paquete uuid,
  origen_item_codigo text NOT NULL DEFAULT 'servicio_manual',
  nombre_servicio_snapshot text NOT NULL
);

CREATE TABLE public.citas_paquetes (
  id_cita_paquete uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cita uuid NOT NULL REFERENCES public.citas(id_cita),
  precio_lista_hnl numeric(12,2) NOT NULL DEFAULT 0,
  descuento_hnl numeric(12,2) NOT NULL DEFAULT 0,
  total_hnl numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE public.citas_holds (
  id_hold uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cita uuid NOT NULL REFERENCES public.citas(id_cita),
  id_usuario uuid,
  estado_hold_codigo text NOT NULL DEFAULT 'activo',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_hold_cita UNIQUE (id_cita)
);

CREATE TABLE public.payment_intents (
  id_intent uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cita uuid REFERENCES public.citas(id_cita),
  id_grupo_cita uuid REFERENCES public.citas_grupos(id_grupo_cita),
  id_provider uuid,
  id_hold uuid REFERENCES public.citas_holds(id_hold),
  origen_pago_codigo text NOT NULL DEFAULT 'cita',
  estado_intent_codigo text NOT NULL DEFAULT 'creado',
  monto_hnl numeric(12,2) NOT NULL DEFAULT 0,
  moneda_codigo text NOT NULL DEFAULT 'HNL',
  link_pago_url text,
  referencia_externa text,
  idempotency_key text,
  expires_at timestamptz,
  created_by_usuario_id uuid,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payments (
  id_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_intent uuid NOT NULL REFERENCES public.payment_intents(id_intent),
  estado_pago_codigo text NOT NULL,
  provider_tx_id text,
  monto_hnl numeric(12,2) NOT NULL DEFAULT 0,
  moneda_codigo text NOT NULL DEFAULT 'HNL',
  paid_at timestamptz,
  registrado_manualmente boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_tx_id)
);

CREATE TABLE public.promociones_sucursal (
  id_promocion_sucursal uuid PRIMARY KEY,
  id_promocion uuid NOT NULL,
  id_sucursal uuid NOT NULL
);

CREATE TABLE public.promociones_codigos (
  id_promocion_codigo uuid PRIMARY KEY,
  id_promocion_regla uuid NOT NULL,
  codigo text NOT NULL,
  activo boolean NOT NULL DEFAULT true
);

CREATE TABLE public.citas_promociones (
  id_cita_promocion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_grupo_cita uuid NOT NULL REFERENCES public.citas_grupos(id_grupo_cita),
  id_cita uuid REFERENCES public.citas(id_cita),
  id_cita_integrante uuid,
  id_promocion uuid NOT NULL,
  id_promocion_regla uuid,
  id_cita_paquete uuid,
  id_cita_detalle uuid REFERENCES public.citas_detalles(id_cita_detalle),
  aplica_a_codigo text NOT NULL,
  nombre_promocion_snapshot text NOT NULL,
  tipo_descuento_codigo text NOT NULL,
  valor_descuento numeric(12,2) NOT NULL DEFAULT 0,
  base_calculo_hnl numeric(12,2) NOT NULL DEFAULT 0,
  descuento_calculado_hnl numeric(12,2) NOT NULL DEFAULT 0,
  prioridad_aplicacion integer NOT NULL DEFAULT 100,
  es_acumulable boolean NOT NULL DEFAULT false,
  estado_aplicacion_codigo text NOT NULL DEFAULT 'aplicada',
  motivo_no_aplicada text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.promociones_usos (
  id_promocion_uso uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cita_promocion uuid NOT NULL REFERENCES public.citas_promociones(id_cita_promocion),
  id_promocion_regla uuid NOT NULL,
  id_grupo_cita uuid NOT NULL REFERENCES public.citas_grupos(id_grupo_cita),
  id_cita uuid REFERENCES public.citas(id_cita),
  id_cliente uuid,
  id_persona uuid,
  id_promocion_sucursal uuid REFERENCES public.promociones_sucursal(id_promocion_sucursal),
  fecha_operativa date NOT NULL,
  estado_uso_codigo text NOT NULL DEFAULT 'reservado',
  usado_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
