-- AM: SOLO LECTURA. pgAdmin QA: guardar resultados ANTES y repetir DESPUES de la migracion.
SELECT current_database() AS base, current_user AS ejecutor, version() AS postgres;

-- AM: Capturar estas definiciones antes del cambio para una eventual reversion DDL revisada.
SELECT n.nspname AS esquema, p.proname, pg_get_function_identity_arguments(p.oid) AS argumentos,
  pg_get_functiondef(p.oid) AS definicion
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'public' AND p.proname IN ('fn_points_get_or_create_active_cycle',
  'fn_points_tx_guard_acumular_final', 'fn_trg_otorgar_puntos_por_cita', 'fn_trg_otorgar_puntos_plan_confirmada'))
  OR (n.nspname = 'app_private' AND p.proname IN ('points_payment_valid_v1', 'points_appointment_paid_v1',
    'points_award_paid_appointment_v1', 'points_award_paid_event_v1'))
ORDER BY n.nspname, p.proname, argumentos;

SELECT t.tgrelid::regclass AS tabla, t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred,
  pg_get_triggerdef(t.oid) AS definicion
FROM pg_trigger t
WHERE NOT t.tgisinternal AND t.tgrelid IN ('public.citas'::regclass, 'public.payments'::regclass,
  'public.payment_intents'::regclass, 'public.points_transactions'::regclass, 'public.subscription_consumptions'::regclass)
ORDER BY t.tgrelid::regclass::text, t.tgname;

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('points_transactions', 'points_cycles')
ORDER BY tablename, indexname;

SELECT (SELECT count(*) FROM public.points_transactions) AS movimientos,
  (SELECT COALESCE(sum(puntos::bigint), 0) FROM public.points_transactions) AS suma_ledger,
  (SELECT count(*) FROM public.points_cycles) AS ciclos,
  (SELECT count(*) FROM (SELECT id_cita FROM public.points_transactions
    WHERE id_cita IS NOT NULL AND tipo_puntos_codigo = 'acumular'
    GROUP BY id_cita HAVING count(*) > 1) d) AS citas_duplicadas;

-- AM: Despues deben existir cuatro triggers habilitados, diferibles e inicialmente diferidos.
SELECT count(*) AS triggers_nuevos_correctos FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE t.tgname IN ('tr_points_paid_citas', 'tr_points_paid_payments', 'tr_points_paid_payment_intents',
  'tr_points_paid_subscription_consumptions') AND t.tgenabled = 'O' AND t.tgdeferrable AND t.tginitdeferred
  AND NOT t.tgisinternal AND n.nspname = 'app_private' AND p.proname = 'points_award_paid_event_v1';

-- AM: Los helpers internos no deben quedar ejecutables mediante grants PUBLIC/anon/authenticated.
SELECT p.proname, p.prosecdef AS security_definer, p.proacl AS permisos
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_private' AND p.proname IN ('points_payment_valid_v1', 'points_appointment_paid_v1',
  'points_award_paid_appointment_v1', 'points_award_paid_event_v1') ORDER BY p.proname;
