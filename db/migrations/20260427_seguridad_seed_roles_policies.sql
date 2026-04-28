BEGIN;

INSERT INTO public.roles (nombre)
SELECT v.nombre
FROM (
  VALUES
    ('security_admin'::text),
    ('security_auditor'::text)
) AS v(nombre)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.roles r
  WHERE lower(r.nombre) = lower(v.nombre)
);

WITH role_policy_seed AS (
  SELECT
    r.id_rol,
    r.nombre,
    CASE
      WHEN r.nombre = 'cliente' THEN 1
      ELSE 5
    END AS max_active_sessions,
    CASE
      WHEN r.nombre = 'cliente' THEN 'confirm_replace'
      ELSE 'allow'
    END AS collision_action
  FROM public.roles r
  WHERE r.nombre IN ('cliente', 'admin', 'barbero', 'super_admin', 'security_admin', 'security_auditor')
)
INSERT INTO public.seguridad_session_policy (
  id_rol,
  max_active_sessions,
  collision_action,
  created_at,
  updated_at
)
SELECT
  seed.id_rol,
  seed.max_active_sessions,
  seed.collision_action,
  NOW(),
  NOW()
FROM role_policy_seed seed
ON CONFLICT (id_rol)
DO UPDATE SET
  max_active_sessions = EXCLUDED.max_active_sessions,
  collision_action = EXCLUDED.collision_action,
  updated_at = NOW();

COMMIT;
