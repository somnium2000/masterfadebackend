-- AM: Contratos de tablas verificados en fuentes locales y fixtures existentes; datos sinteticos.

    CREATE TABLE citas(id_cita uuid PRIMARY KEY, id_grupo_cita uuid, id_sucursal uuid, id_empleado_barbero uuid,
      deleted_at timestamptz, estado_cita_codigo text, orden_integrante int, alias_integrante text,
      id_persona_cliente uuid, id_cliente uuid, inicio_at timestamptz, fin_at timestamptz,
      atencion_iniciada_at timestamptz, atencion_finalizada_at timestamptz,
      retraso_inicio_min int, duracion_total_min int, buffer_total_min int, selection_type text,
      id_paquete uuid, total_pagar_hnl numeric, moneda_codigo text, asignada_automaticamente boolean, notas text);
    CREATE TABLE sucursales(id_sucursal uuid,nombre_sucursal text,deleted_at timestamptz,estado boolean);
    CREATE TABLE personas(id_persona uuid,nombres text,apellidos text,telefono_principal text);
    CREATE TABLE empleados(id_empleado uuid,id_persona uuid);
    CREATE TABLE correos(id_correo uuid,id_persona uuid,direccion_correo text,deleted_at timestamptz,es_principal boolean,verificado boolean);
    CREATE TABLE citas_detalles(id_cita_detalle uuid,id_cita uuid,id_servicio uuid);
    CREATE TABLE servicios(id_servicio uuid,nombre_servicio text);
    CREATE TABLE citas_holds(id_cita uuid,estado_hold_codigo text,expires_at timestamptz,created_at timestamptz);
    CREATE TABLE payment_intents(id_cita uuid,estado_intent_codigo text,expires_at timestamptz,created_at timestamptz);
    CREATE TABLE citas_reagendaciones(id_cita uuid,id_lote_reagendacion uuid,id_cita_causante uuid,retraso_min int,tipo_reagendacion_codigo text,created_at timestamptz,id_reagendacion uuid);

ALTER TABLE citas ADD COLUMN contacto_nombre text, ADD COLUMN contacto_email text,
 ADD COLUMN llegada_real_at timestamptz, ADD COLUMN no_show_at timestamptz,
 ADD COLUMN updated_at timestamptz, ADD COLUMN created_at timestamptz DEFAULT now(),
 ADD COLUMN creada_por_usuario_id uuid, ADD COLUMN es_canje_recompensa boolean DEFAULT false,
 ADD COLUMN descuento_hnl numeric DEFAULT 0;
ALTER TABLE personas ADD PRIMARY KEY(id_persona);
ALTER TABLE servicios ADD PRIMARY KEY(id_servicio), ADD COLUMN deleted_at timestamptz,
 ADD COLUMN activo boolean DEFAULT true, ADD COLUMN agendable boolean DEFAULT true, ADD COLUMN visible_publico boolean DEFAULT true;
ALTER TABLE sucursales ADD PRIMARY KEY(id_sucursal);
ALTER TABLE citas_detalles ADD COLUMN subtotal_hnl numeric DEFAULT 0;
CREATE TABLE clientes(id_cliente uuid PRIMARY KEY,id_usuario uuid,id_persona uuid,id_sucursal_origen uuid,estado boolean DEFAULT true,deleted_at timestamptz);
CREATE TABLE citas_grupos(id_grupo_cita uuid PRIMARY KEY,id_cliente_titular uuid,origen_codigo text NOT NULL DEFAULT 'publico');
CREATE TABLE estados_cita(estado_cita_codigo text);
INSERT INTO estados_cita VALUES('completada');
CREATE TABLE tipos_puntos(tipo_puntos_codigo text PRIMARY KEY,signo int);
INSERT INTO tipos_puntos VALUES('acumular',1),('canjear',-1),('ajustar',1),('ajuste_resta',-1),('vencimiento',-1);
CREATE TABLE points_rules(id_rule uuid PRIMARY KEY DEFAULT gen_random_uuid(),id_sucursal uuid,
 umbral_monto_hnl numeric DEFAULT 250,puntos_por_cita int DEFAULT 1,puntos_para_premio int DEFAULT 10,
 expiracion_meses int,activo boolean DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
INSERT INTO points_rules(id_sucursal) VALUES(NULL);
CREATE TABLE points_cycles(id_cycle uuid PRIMARY KEY DEFAULT gen_random_uuid(),id_cliente uuid NOT NULL REFERENCES clientes,
 primer_acumulado_at timestamptz NOT NULL,vence_at timestamptz,estado_ciclo_codigo text DEFAULT 'activo',
 created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
 CONSTRAINT ck_points_cycle_range CHECK(vence_at IS NULL OR vence_at > primer_acumulado_at));
CREATE UNIQUE INDEX uq_points_cycle_active ON points_cycles(id_cliente) WHERE estado_ciclo_codigo='activo';
CREATE TABLE points_transactions(id_points_tx uuid PRIMARY KEY DEFAULT gen_random_uuid(),id_cliente uuid NOT NULL REFERENCES clientes,
 id_cita uuid REFERENCES citas,id_cycle uuid REFERENCES points_cycles,id_sucursal_origen uuid,
 tipo_puntos_codigo text REFERENCES tipos_puntos,origen_punto_codigo text,id_servicio_canje uuid,puntos int NOT NULL,
 vence_at timestamptz,motivo text,creado_por_usuario_id uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX uq_points_tx_acumular_por_cita ON points_transactions(id_cita,tipo_puntos_codigo) WHERE id_cita IS NOT NULL AND tipo_puntos_codigo='acumular';
CREATE UNIQUE INDEX uq_points_tx_canje_por_cita ON points_transactions(id_cliente,id_cita,tipo_puntos_codigo) WHERE id_cita IS NOT NULL AND tipo_puntos_codigo='canjear';
CREATE UNIQUE INDEX uq_points_tx_vencimiento_por_cycle ON points_transactions(id_cycle,tipo_puntos_codigo) WHERE id_cycle IS NOT NULL AND tipo_puntos_codigo='vencimiento';
CREATE TABLE points_rule_services(id_rule uuid,id_servicio uuid,cliente_condicion_codigo text,habilitado boolean DEFAULT true,visible_cliente boolean DEFAULT true,orden_visual int);
CREATE TABLE servicios_tarifas(id_tarifa uuid DEFAULT gen_random_uuid(),id_servicio uuid,id_sucursal uuid,
 deleted_at timestamptz,activo boolean DEFAULT true,vigente_desde date DEFAULT current_date-1,vigente_hasta date,servicio_informativo boolean DEFAULT false);
CREATE TABLE membership_plans(id_plan uuid PRIMARY KEY,nombre_plan text,descripcion text,periodo_membresia_codigo text,categoria_nivel int);
CREATE TABLE subscriptions(id_suscripcion uuid PRIMARY KEY,id_cliente uuid,id_plan uuid,estado_suscripcion_codigo text,
 inicio_at timestamptz,fin_at timestamptz,id_sucursal_contratada uuid,beneficios_snapshot jsonb,motivo_fin_codigo text,
 renovacion_auto boolean DEFAULT false,cancelada_al_fin boolean DEFAULT false,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE subscription_consumptions(id_consumo uuid PRIMARY KEY DEFAULT gen_random_uuid(),id_suscripcion uuid,id_cliente uuid,id_cita uuid,
 orden_integrante int,item_tipo text,id_servicio uuid,id_cortesia uuid,item_codigo text,item_nombre text,cantidad int,
 precio_unitario_hnl numeric,total_hnl numeric,coverage_status text,source_kind text,source_key text,
 invalidado boolean DEFAULT false,invalidado_motivo text,id_usuario_ejecutor uuid,created_at timestamptz DEFAULT now(),UNIQUE(source_key));
CREATE TABLE usuarios(id_usuario uuid PRIMARY KEY,id_persona uuid,estado boolean DEFAULT true,estado_acceso text DEFAULT 'activo',deleted_at timestamptz);

CREATE SCHEMA app_private;
CREATE TABLE app_private.points_manual_adjustment_idempotency (
  idempotency_key uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  id_cliente uuid NOT NULL,
  requested_by_usuario_id uuid NOT NULL,
  id_points_tx uuid NULL,
  response_payload jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT ck_points_manual_adjustment_idempotency_payload_hash
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_points_manual_adjustment_idempotency_completion
    CHECK (
      (id_points_tx IS NULL AND response_payload IS NULL AND completed_at IS NULL)
      OR
      (id_points_tx IS NOT NULL AND response_payload IS NOT NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT ck_points_manual_adjustment_idempotency_response_object
    CHECK (response_payload IS NULL OR jsonb_typeof(response_payload) = 'object')
);

CREATE UNIQUE INDEX ux_points_manual_adjustment_idempotency_tx
  ON app_private.points_manual_adjustment_idempotency (id_points_tx)
  WHERE id_points_tx IS NOT NULL;

CREATE INDEX idx_points_manual_adjustment_idempotency_created_at
  ON app_private.points_manual_adjustment_idempotency (created_at);
