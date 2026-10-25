import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';

const triggerDefinition = "CREATE OR REPLACE FUNCTION public.fn_validar_persona_empleado_campos_obligatorios()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  v_dni text;\n  v_telefono text;\n  v_existe_empleado_activo boolean;\nBEGIN\n  -- Caso A: se inserta/actualiza empleado\n  IF TG_TABLE_NAME = 'empleados' THEN\n    -- Si el registro de empleado se está soft-deleteando, no validar\n    IF NEW.deleted_at IS NOT NULL THEN\n      RETURN NEW;\n    END IF;\n\n    SELECT\n      regexp_replace(COALESCE(p.dni, ''), '\\D', '', 'g'),\n      BTRIM(COALESCE(p.telefono_principal, ''))\n    INTO\n      v_dni,\n      v_telefono\n    FROM public.personas p\n    WHERE p.id_persona = NEW.id_persona\n      AND p.deleted_at IS NULL;\n\n    IF NOT FOUND THEN\n      RAISE EXCEPTION\n        USING ERRCODE = '23514',\n              MESSAGE = 'No se puede crear/actualizar empleado: la persona asociada no existe o está eliminada.';\n    END IF;\n\n    IF v_dni = '' THEN\n      RAISE EXCEPTION\n        USING ERRCODE = '23514',\n              MESSAGE = 'No se puede crear/actualizar empleado: el DNI es obligatorio para empleados.';\n    END IF;\n\n    IF v_telefono = '' THEN\n      RAISE EXCEPTION\n        USING ERRCODE = '23514',\n              MESSAGE = 'No se puede crear/actualizar empleado: el teléfono principal es obligatorio para empleados.';\n    END IF;\n\n    RETURN NEW;\n  END IF;\n\n  -- Caso B: se actualiza persona que ya está vinculada a un empleado activo\n  IF TG_TABLE_NAME = 'personas' THEN\n    SELECT EXISTS (\n      SELECT 1\n      FROM public.empleados e\n      WHERE e.id_persona = NEW.id_persona\n        AND e.deleted_at IS NULL\n    )\n    INTO v_existe_empleado_activo;\n\n    IF v_existe_empleado_activo THEN\n      IF regexp_replace(COALESCE(NEW.dni, ''), '\\D', '', 'g') = '' THEN\n        RAISE EXCEPTION\n          USING ERRCODE = '23514',\n                MESSAGE = 'No se puede actualizar la persona: el DNI es obligatorio porque está vinculada a un empleado activo.';\n      END IF;\n\n      IF BTRIM(COALESCE(NEW.telefono_principal, '')) = '' THEN\n        RAISE EXCEPTION\n          USING ERRCODE = '23514',\n                MESSAGE = 'No se puede actualizar la persona: el teléfono principal es obligatorio porque está vinculada a un empleado activo.';\n      END IF;\n    END IF;\n\n    RETURN NEW;\n  END IF;\n\n  RETURN NEW;\nEND;\n$function$\n";
const RUN = process.env.RUN_EMPLOYEE_GUEST_PG === 'true';

test('PostgreSQL aislado: trigger QA rechaza DNI ausente, admite completado y revierte fallo posterior', { skip: !RUN }, async () => {
  const bin = process.env.MASTERFADE_TEST_PG_BIN;
  assert.ok(bin, 'MASTERFADE_TEST_PG_BIN requerido');
  const directory = await mkdtemp(path.join(tmpdir(), 'masterfade-employee-guest-'));
  const data = path.join(directory, 'data');
  const run = (name, args) => {
    const result = spawnSync(path.join(bin, process.platform === 'win32' ? name + '.exe' : name), args,
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  let started = false;
  let client;
  try {
    const listener = createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C', '--no-sync']);
    run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port, '-w', 'start']);
    started = true;
    client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', ssl: false });
    await client.connect();
    await client.query(`CREATE TABLE public.personas(id_persona uuid PRIMARY KEY, nombres text, dni text UNIQUE, telefono_principal text, deleted_at timestamptz, updated_at timestamptz);
      CREATE TABLE public.empleados(id_persona uuid REFERENCES public.personas, deleted_at timestamptz);
      CREATE TABLE public.citas(id_persona uuid REFERENCES public.personas, referencia text);`);
    await client.query(triggerDefinition);
    await client.query(`CREATE TRIGGER validar_empleado BEFORE INSERT OR UPDATE ON public.empleados FOR EACH ROW EXECUTE FUNCTION public.fn_validar_persona_empleado_campos_obligatorios();
      CREATE TRIGGER validar_persona BEFORE UPDATE ON public.personas FOR EACH ROW EXECUTE FUNCTION public.fn_validar_persona_empleado_campos_obligatorios();`);
    const id = '700910df-fdc7-45e5-8192-11907dc7c24c';
    await client.query("INSERT INTO public.personas VALUES ($1, 'Historica', NULL, '88880000', NULL, NULL)", [id]);
    await client.query("INSERT INTO public.citas VALUES ($1, 'historial intacto')", [id]);
    await assert.rejects(client.query('INSERT INTO public.empleados(id_persona) VALUES ($1)', [id]), { code: '23514' });
    const source = await readFile(new URL('../src/routes/v1/admin/personas.js', import.meta.url), 'utf8');
    const update = source.match(/`(UPDATE public.personas\s+SET dni = \$2, telefono_principal = \$3, updated_at = NOW\(\)\s+WHERE id_persona = \$1::uuid)`/)[1];
    await client.query('BEGIN');
    await client.query(update, [id, '0801199012345', '88880000']);
    await client.query('INSERT INTO public.empleados(id_persona) VALUES ($1)', [id]);
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT dni FROM public.personas')).rows[0].dni, null);
    assert.equal((await client.query('SELECT * FROM public.empleados')).rowCount, 0);
    await client.query('BEGIN');
    await client.query(update, [id, '0801199012345', '88880000']);
    await client.query('INSERT INTO public.empleados(id_persona) VALUES ($1)', [id]);
    await client.query('COMMIT');
    assert.equal((await client.query('SELECT * FROM public.personas')).rowCount, 1);
    assert.deepEqual((await client.query('SELECT nombres, dni, telefono_principal FROM public.personas')).rows[0],
      { nombres: 'Historica', dni: '0801199012345', telefono_principal: '88880000' });
    assert.equal((await client.query('SELECT referencia FROM public.citas WHERE id_persona=$1', [id])).rows[0].referencia, 'historial intacto');
    await assert.rejects(client.query("INSERT INTO public.personas(id_persona,dni) VALUES ('11111111-1111-4111-8111-111111111111','0801199012345')"), { code: '23505' });
  } finally {
    await client?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('masterfade-employee-guest-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

