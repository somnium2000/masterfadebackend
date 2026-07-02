CREATE SCHEMA IF NOT EXISTS public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
  id_grupo_cita uuid PRIMARY KEY,
  total_hnl numeric(12,2) NOT NULL DEFAULT 0,
  estado_grupo_codigo text NOT NULL DEFAULT 'activo',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.citas (
  id_cita uuid PRIMARY KEY,
  id_grupo_cita uuid REFERENCES public.citas_grupos(id_grupo_cita),
  id_sucursal uuid NOT NULL,
  id_empleado_barbero uuid NOT NULL,
  inicio_at timestamptz NOT NULL,
  fin_at timestamptz NOT NULL,
  duracion_total_min integer NOT NULL DEFAULT 0,
  buffer_total_min integer NOT NULL DEFAULT 0,
  subtotal_servicios_hnl numeric(12,2) NOT NULL DEFAULT 0,
  descuento_hnl numeric(12,2) NOT NULL DEFAULT 0,
  total_pagar_hnl numeric(12,2) NOT NULL DEFAULT 0,
  estado_cita_codigo text NOT NULL DEFAULT 'en_espera',
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
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
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payment_intents (
  id_intent uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cita uuid REFERENCES public.citas(id_cita),
  origen_pago_codigo text NOT NULL DEFAULT 'booking',
  monto_hnl numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
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
