BEGIN;

-- AM: Corrige despliegues donde se creó un trigger inválido en payment_events.
DROP TRIGGER IF EXISTS tr_set_updated_at_payment_events ON public.payment_events;
DROP TRIGGER IF EXISTS tr_payment_events_set_updated_at ON public.payment_events;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'payment_events'
      AND c.column_name = 'updated_at'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_set_updated_at'
  ) THEN
    CREATE TRIGGER tr_set_updated_at_payment_events
    BEFORE UPDATE ON public.payment_events
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_set_updated_at();
  END IF;
END $$;

COMMIT;

