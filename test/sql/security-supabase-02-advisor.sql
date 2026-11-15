-- AM: Solo SELECT local; checks oficiales de Supabase Splinter sin crear vistas.
-- AM: Fuente fijada en commit cd238c833d279c22863d46d7692d6d1d4ec39f6b, consultada 2026-11-13.
-- AM: https://github.com/supabase/splinter/tree/cd238c833d279c22863d46d7692d6d1d4ec39f6b/lints
-- AM: Cambios: envoltorios CREATE VIEW sustituidos por CTEs; predicados y columnas originales intactos.
/* AM: Licencia upstream:
The PostgreSQL License

Copyright (c) 2024, Supabase

Permission to use, copy, modify, and distribute this software and its documentation for any purpose, without fee, and without a written agreement is hereby granted, provided that the above copyright notice and this paragraph and the following two paragraphs appear in all copies.

IN NO EVENT SHALL Supabase BE LIABLE TO ANY PARTY FOR DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN IF Supabase HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Supabase SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE SOFTWARE PROVIDED HEREUNDER IS ON AN "AS IS" BASIS, AND Supabase HAS NO OBLIGATIONS TO PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.

*/
WITH lint_0008 AS (
select
    'rls_enabled_no_policy' as name,
    'RLS Enabled No Policy' as title,
    'INFO' as level,
    'EXTERNAL' as facing,
    array['SECURITY'] as categories,
    'Detects cases where row level security (RLS) has been enabled on a table but no RLS policies have been created.' as description,
    format(
        'Table \`%s.%s\` has RLS enabled, but no policies exist',
        n.nspname,
        c.relname
    ) as detail,
    'https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy' as remediation,
    jsonb_build_object(
        'schema', n.nspname,
        'name', c.relname,
        'type', 'table'
    ) as metadata,
    format(
        'rls_enabled_no_policy_%s_%s',
        n.nspname,
        c.relname
    ) as cache_key
from
    pg_catalog.pg_class c
    left join pg_catalog.pg_policy p
        on p.polrelid = c.oid
    join pg_catalog.pg_namespace n
        on c.relnamespace = n.oid
    left join pg_catalog.pg_depend dep
        on c.oid = dep.objid
        and dep.deptype = 'e'
        and dep.classid = 'pg_catalog.pg_class'::regclass
where
    c.relkind = 'r' -- regular tables
    and n.nspname not in (
        '_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema', 'net', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks', 'pgtle', 'pgbouncer', 'pg_catalog', 'realtime', 'repack', 'storage', 'supabase_functions', 'supabase_migrations', 'tiger', 'topology', 'vault'
    )
    -- RLS is enabled
    and c.relrowsecurity
    and p.polname is null
    and dep.objid is null -- exclude tables owned by extensions
group by
    n.nspname,
    c.relname
),
lint_0011 AS (
select
    'function_search_path_mutable' as name,
    'Function Search Path Mutable' as title,
    'WARN' as level,
    'EXTERNAL' as facing,
    array['SECURITY'] as categories,
    'Detects functions where the search_path parameter is not set.' as description,
    format(
        'Function \`%s.%s\` has a role mutable search_path',
        n.nspname,
        p.proname
    ) as detail,
    'https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable' as remediation,
    jsonb_build_object(
        'schema', n.nspname,
        'name', p.proname,
        'type', 'function'
    ) as metadata,
    format(
        'function_search_path_mutable_%s_%s_%s',
        n.nspname,
        p.proname,
        md5(p.prosrc) -- required when function is polymorphic
    ) as cache_key
from
    pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n
        on p.pronamespace = n.oid
    left join pg_catalog.pg_depend dep
        on p.oid = dep.objid
        and dep.deptype = 'e'
        and dep.classid = 'pg_catalog.pg_proc'::regclass
where
    n.nspname not in (
        '_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema', 'net', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks', 'pgtle', 'pgbouncer', 'pg_catalog', 'realtime', 'repack', 'storage', 'supabase_functions', 'supabase_migrations', 'tiger', 'topology', 'vault'
    )
    and dep.objid is null -- exclude functions owned by extensions
    -- Search path not set
    and not exists (
        select 1
        from unnest(coalesce(p.proconfig, '{}')) as config
        where config like 'search_path=%'
    )
),
lint_0028 AS (
-- Detects SECURITY DEFINER functions that the `anon` role has EXECUTE
-- on. SECURITY DEFINER functions run with the privileges of their
-- owner (typically a superuser-equivalent role) rather than the
-- caller, so they bypass RLS on every table they read or write.
-- Granting EXECUTE to `anon` therefore lets any holder of the public
-- anon key invoke a privileged operation through PostgREST
-- `/rest/v1/rpc/<name>`, and through `/graphql/v1` Query/Mutation
-- fields when pg_graphql is installed and the return type is
-- supported.
--
-- See lint 0029 for the equivalent check against the `authenticated`
-- role. Together with 0026/0027 they cover the four direct
-- exposure paths: anon-vs-authenticated × table-vs-function.
--
-- This lint deliberately does not gate on pg_graphql being installed:
-- PostgREST exposes `/rest/v1/rpc` independently and is the more
-- commonly deployed surface for the same risk.
select
    'anon_security_definer_function_executable' as name,
    'Public Can Execute SECURITY DEFINER Function' as title,
    'WARN' as level,
    'EXTERNAL' as facing,
    array['SECURITY'] as categories,
    'Detects `SECURITY DEFINER` functions that are callable without signing in. Revoke `EXECUTE`, switch the function to `SECURITY INVOKER`, or move it out of your exposed API schema if it is not meant to be public.' as description,
    format(
        'Function `%s.%s(%s)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/%s`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.',
        schema_name,
        function_name,
        function_args,
        function_name
    ) as detail,
    'https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable' as remediation,
    jsonb_build_object(
        'schema', schema_name,
        'name', function_name,
        'arguments', function_args,
        'language', function_language,
        'security_definer', true
    ) as metadata,
    format(
        'anon_security_definer_function_executable_%s_%s_%s',
        schema_name,
        function_name,
        function_args
    ) as cache_key
from
    (
        select
            n.nspname as schema_name,
            p.proname as function_name,
            pg_catalog.pg_get_function_identity_arguments(p.oid) as function_args,
            l.lanname as function_language
        from
            pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n
                on p.pronamespace = n.oid
            join pg_catalog.pg_language l
                on p.prolang = l.oid
        where
            p.prosecdef = true
            and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
            and n.nspname = any(array(select trim(unnest(string_to_array(coalesce(current_setting('pgrst.db_schemas', 't'), 'public'), ',')))))
            and n.nspname not in (
                '_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema', 'net', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks', 'pgtle', 'pgbouncer', 'pg_catalog', 'realtime', 'repack', 'storage', 'supabase_functions', 'supabase_migrations', 'tiger', 'topology', 'vault'
            )
    ) exposed_functions
order by
    schema_name,
    function_name,
    function_args
),
lint_0029 AS (
-- Detects SECURITY DEFINER functions that the `authenticated` role
-- has EXECUTE on. SECURITY DEFINER functions run with the privileges
-- of their owner (typically a superuser-equivalent role) rather than
-- the caller, so they bypass RLS on every table they read or write.
-- Granting EXECUTE to `authenticated` therefore lets any signed-up
-- user invoke a privileged operation through PostgREST
-- `/rest/v1/rpc/<name>`, and through `/graphql/v1` Query/Mutation
-- fields when pg_graphql is installed and the return type is
-- supported. Under open or auto-confirm signup, "authenticated" is in
-- practice anyone with a throwaway email.
--
-- See lint 0028 for the equivalent check against the `anon` role.
-- Together with 0026/0027 they cover the four direct exposure paths:
-- anon-vs-authenticated × table-vs-function.
--
-- This lint deliberately does not gate on pg_graphql being installed:
-- PostgREST exposes `/rest/v1/rpc` independently and is the more
-- commonly deployed surface for the same risk.
select
    'authenticated_security_definer_function_executable' as name,
    'Signed-In Users Can Execute SECURITY DEFINER Function' as title,
    'WARN' as level,
    'EXTERNAL' as facing,
    array['SECURITY'] as categories,
    'Detects `SECURITY DEFINER` functions that are callable by signed-in users. Revoke `EXECUTE`, switch the function to `SECURITY INVOKER`, or move it out of your exposed API schema if signed-in users should not call it.' as description,
    format(
        'Function `%s.%s(%s)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/%s`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.',
        schema_name,
        function_name,
        function_args,
        function_name
    ) as detail,
    'https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable' as remediation,
    jsonb_build_object(
        'schema', schema_name,
        'name', function_name,
        'arguments', function_args,
        'language', function_language,
        'security_definer', true
    ) as metadata,
    format(
        'authenticated_security_definer_function_executable_%s_%s_%s',
        schema_name,
        function_name,
        function_args
    ) as cache_key
from
    (
        select
            n.nspname as schema_name,
            p.proname as function_name,
            pg_catalog.pg_get_function_identity_arguments(p.oid) as function_args,
            l.lanname as function_language
        from
            pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n
                on p.pronamespace = n.oid
            join pg_catalog.pg_language l
                on p.prolang = l.oid
        where
            p.prosecdef = true
            and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
            and n.nspname = any(array(select trim(unnest(string_to_array(coalesce(current_setting('pgrst.db_schemas', 't'), 'public'), ',')))))
            and n.nspname not in (
                '_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema', 'net', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks', 'pgtle', 'pgbouncer', 'pg_catalog', 'realtime', 'repack', 'storage', 'supabase_functions', 'supabase_migrations', 'tiger', 'topology', 'vault'
            )
    ) exposed_functions
order by
    schema_name,
    function_name,
    function_args
)
SELECT * FROM lint_0008
UNION ALL SELECT * FROM lint_0011
UNION ALL SELECT * FROM lint_0028
UNION ALL SELECT * FROM lint_0029
ORDER BY name, cache_key;
