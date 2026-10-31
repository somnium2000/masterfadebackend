-- QA-MP-02: idempotencia durable para ajustes manuales administrativos.
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

REVOKE ALL ON TABLE app_private.points_manual_adjustment_idempotency FROM PUBLIC;
REVOKE ALL ON TABLE app_private.points_manual_adjustment_idempotency FROM anon;
REVOKE ALL ON TABLE app_private.points_manual_adjustment_idempotency FROM authenticated;
REVOKE ALL ON TABLE app_private.points_manual_adjustment_idempotency FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE app_private.points_manual_adjustment_idempotency TO postgres;

COMMENT ON TABLE app_private.points_manual_adjustment_idempotency IS
  'Deduplicacion transaccional de ajustes manuales MasterPuntos; no expuesta por Data API.';
