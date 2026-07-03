DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;

  CREATE SCHEMA IF NOT EXISTS cron;

  CREATE TABLE IF NOT EXISTS cron.job (
    jobid bigserial PRIMARY KEY,
    schedule text NOT NULL,
    command text NOT NULL,
    nodename text,
    nodeport integer,
    database text,
    username text,
    active boolean NOT NULL DEFAULT true,
    jobname text
  );

  CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
  RETURNS bigint
  LANGUAGE plpgsql
  AS $function$
  DECLARE
    v_jobid bigint;
  BEGIN
    INSERT INTO cron.job (jobname, schedule, command)
    VALUES (p_jobname, p_schedule, p_command)
    RETURNING jobid INTO v_jobid;
    RETURN v_jobid;
  END;
  $function$;

  CREATE OR REPLACE FUNCTION cron.unschedule(p_jobid bigint)
  RETURNS boolean
  LANGUAGE plpgsql
  AS $function$
  BEGIN
    DELETE FROM cron.job WHERE jobid = p_jobid;
    RETURN true;
  END;
  $function$;

  CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname text)
  RETURNS boolean
  LANGUAGE plpgsql
  AS $function$
  BEGIN
    DELETE FROM cron.job WHERE jobname = p_jobname;
    RETURN true;
  END;
  $function$;
END $$;
