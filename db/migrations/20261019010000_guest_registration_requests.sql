-- AM: LOCAL PROPOSAL: review and apply separately before enabling historical registration.
BEGIN;
CREATE TABLE app_private.guest_registration_requests (
  id uuid PRIMARY KEY,
  email text UNIQUE CHECK (email = lower(btrim(email))),
  id_correo uuid REFERENCES public.correos(id_correo) ON DELETE SET NULL,
  original_persona_id uuid REFERENCES public.personas(id_persona) ON DELETE SET NULL,
  auth_user_id uuid NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed')),
  result_persona_id uuid REFERENCES public.personas(id_persona) ON DELETE SET NULL,
  result_cliente_id uuid REFERENCES public.clientes(id_cliente) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'pending' AND email IS NOT NULL AND completed_at IS NULL AND result_persona_id IS NULL AND result_cliente_id IS NULL)
    OR (state = 'completed' AND email IS NULL AND completed_at IS NOT NULL))
);
ALTER TABLE app_private.guest_registration_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.guest_registration_requests FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE app_private.guest_registration_requests IS
  'Backend-only historical email registration. No plaintext token or password. Auth UUID preallocated for safe reconciliation.';
COMMIT;
-- Rollback only BEFORE enabling the feature and only if the table is empty:
-- BEGIN; LOCK TABLE app_private.guest_registration_requests IN ACCESS EXCLUSIVE MODE;
-- DO $$ BEGIN IF EXISTS (SELECT 1 FROM app_private.guest_registration_requests)
-- THEN RAISE EXCEPTION 'Reconcile registration operations before rollback'; END IF; END $$;
-- DROP TABLE app_private.guest_registration_requests; COMMIT;
