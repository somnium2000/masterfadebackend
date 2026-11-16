-- AM: Solo metadatos de ciclos. La politica de fechas de carga fue aprobada por el propietario.
-- AM: El preflight completo debe pasar antes; nunca actualiza ni sustituye movimientos del ledger.
CREATE TABLE IF NOT EXISTS app_private.release10_cycle_bootstrap_backup (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  ledger_md5 text NOT NULL,
  cycles_before_md5 text NOT NULL,
  cycles_before jsonb NOT NULL,
  cycles_after jsonb NOT NULL,
  seal text NOT NULL
);
ALTER TABLE app_private.release10_cycle_bootstrap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.release10_cycle_bootstrap_backup FROM PUBLIC,anon,authenticated,service_role;
GRANT ALL ON app_private.release10_cycle_bootstrap_backup TO postgres;

DO $bootstrap$
DECLARE v_saved app_private.release10_cycle_bootstrap_backup%ROWTYPE;
  v_ledger text; v_cycles text; v_before jsonb; v_after jsonb;
BEGIN
  IF current_user<>'postgres' THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_POSTGRES_REQUIRED'; END IF;
  SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) INTO v_ledger
    FROM public.points_transactions t;
  SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')),
    COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id_cycle),'[]') INTO v_cycles,v_before FROM public.points_cycles t;
  SELECT * INTO v_saved FROM app_private.release10_cycle_bootstrap_backup WHERE singleton;
  IF FOUND THEN
    IF v_saved.ledger_md5<>v_ledger OR v_saved.seal<>md5(v_saved.ledger_md5||v_saved.cycles_before_md5||v_saved.cycles_before::text||v_saved.cycles_after::text)
      OR (v_before<>v_saved.cycles_before AND v_before<>v_saved.cycles_after) THEN
      RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BOOTSTRAP_BASELINE_CHANGED';
    END IF;
    IF v_before=v_saved.cycles_before THEN
      INSERT INTO public.points_cycles SELECT r.* FROM jsonb_populate_recordset(NULL::public.points_cycles,v_saved.cycles_after) r
        WHERE NOT EXISTS(SELECT 1 FROM public.points_cycles pc WHERE pc.id_cycle=r.id_cycle);
    END IF;
  ELSE
    INSERT INTO public.points_cycles(id_cliente,primer_acumulado_at,vence_at,estado_ciclo_codigo)
    SELECT id_cliente,min(created_at) FILTER(WHERE puntos>0),
      ((min(created_at) FILTER(WHERE puntos>0) AT TIME ZONE 'America/Tegucigalpa')+interval '12 months') AT TIME ZONE 'America/Tegucigalpa','activo'
    FROM public.points_transactions pt WHERE pt.id_cycle IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.points_cycles pc WHERE pc.id_cliente=pt.id_cliente)
    GROUP BY id_cliente HAVING sum(puntos::bigint)>0;
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id_cycle),'[]') INTO v_after FROM public.points_cycles t;
    INSERT INTO app_private.release10_cycle_bootstrap_backup(singleton,ledger_md5,cycles_before_md5,cycles_before,cycles_after,seal)
      VALUES(true,v_ledger,v_cycles,v_before,v_after,md5(v_ledger||v_cycles||v_before::text||v_after::text));
  END IF;
END;
$bootstrap$;
