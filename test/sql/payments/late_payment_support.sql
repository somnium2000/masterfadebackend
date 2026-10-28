-- AM: Soporte del fixture CI existente, exclusivamente en cluster PostgreSQL temporal.
CREATE SCHEMA app_private;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

ALTER TABLE public.payments ADD COLUMN pago_tardio boolean NOT NULL DEFAULT false;
ALTER TABLE public.payment_intents ADD COLUMN provider_session_id text;
ALTER TABLE public.clientes ADD COLUMN id_usuario uuid;
ALTER TABLE public.citas_detalles
  ADD COLUMN descuento_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN incluye_isv_snapshot boolean NOT NULL DEFAULT false,
  ADD COLUMN isv_porcentaje numeric(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN isv_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN total_linea_hnl numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.citas_paquetes ADD COLUMN nombre_paquete_snapshot text;
ALTER TABLE public.citas_promociones
  ADD COLUMN id_promocion_sucursal uuid,
  ADD COLUMN id_promocion_codigo uuid;
ALTER TABLE public.notificaciones_email
  ADD COLUMN correo_destino text,
  ADD COLUMN asunto text,
  ADD COLUMN cuerpo text;

CREATE TABLE public.payment_providers (id_provider uuid PRIMARY KEY, codigo text NOT NULL);
CREATE TABLE public.correos (
  id_persona uuid, direccion_correo text, es_principal boolean DEFAULT true, deleted_at timestamptz
);
