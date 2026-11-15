import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startPostgres17 } from './postgres17.mjs';

// AM: Catalogo remoto sin filas personales. Este helper solo inicia PostgreSQL 17 en loopback.
export async function createMasterpuntosRelease10Fixture() {
  const isolated = await startPostgres17();
  const pool = new pg.Pool({ ...isolated.connectionOptions, max: 8 });
  const source = async file => (await readFile(new URL('../../' + file, import.meta.url), 'utf8')).replace(/\r\n/g,'\n');
  const prod = JSON.parse(await source('test/fixtures/masterpuntos-release10/prod-catalog.json'));
  const extra = JSON.parse(await source('test/fixtures/masterpuntos-release10/prod-extra.json'));
  const keys = JSON.parse(await source('test/fixtures/masterpuntos-release10/prod-primary-keys.json'));
  const close = async () => { await pool.end(); await isolated.stop(); };
  try {
    await pool.query('CREATE SCHEMA app_private; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    await pool.query(await source('db/migrations/20261031143653_masterpuntos_manual_adjustment_idempotency_v1.sql'));
    const tables = new Map();
    for (const c of [...prod.columns,...extra.columns]) {
      if (!tables.has(c.table)) tables.set(c.table,new Map());
      tables.get(c.table).set(c.name,c);
    }
    for (const [table,columns] of tables) {
      await pool.query(`CREATE TABLE public.${table}(${[...columns.values()].map(c =>
        `"${c.name}" ${c.type}${c.default ? ' DEFAULT '+c.default : ''}${c.nullable==='NO' ? ' NOT NULL' : ''}`).join(',')})`);
    }
    for (const c of keys.filter(c=>tables.has(c.table))) await pool.query(`ALTER TABLE public.${c.table} ADD CONSTRAINT ${c.name} ${c.definition}`);
    for (const c of prod.constraints.filter(c=>c.table.startsWith('points_') && !c.definition.startsWith('PRIMARY KEY'))) {
      await pool.query(`ALTER TABLE public.${c.table} ADD CONSTRAINT ${c.name} ${c.definition}`);
    }
    for (const i of prod.indexes.filter(i=>i.table.startsWith('points_') && !keys.some(k=>k.name===i.name)
      && !prod.constraints.some(c=>c.name===i.name && c.definition.startsWith('UNIQUE')))) await pool.query(i.definition);
    for (const f of prod.functions) await pool.query(f.definition);
    for (const v of prod.views) await pool.query(`CREATE VIEW public.${v.name} AS ${v.definition}`);
    for (const t of prod.triggers.filter(t=>t.name.startsWith('tr_points_'))) await pool.query(t.definition);
    for (const t of extra.types) await pool.query('INSERT INTO tipos_puntos(tipo_puntos_codigo,descripcion,signo) VALUES($1,$2,$3)',[t.tipo_puntos_codigo,t.descripcion,t.signo]);
    await pool.query("INSERT INTO points_rules(expiracion_meses) VALUES(NULL); INSERT INTO estados_cita VALUES('completada','Completada');");
    const branch=randomUUID(),otherBranch=randomUUID(),service=randomUUID(),barber=randomUUID(),provider=randomUUID();
    await pool.query("INSERT INTO sucursales(id_sucursal,id_empresa,nombre_sucursal) VALUES($1,$3,'Centro sintetico'),($2,$3,'Otra sintetica')",[branch,otherBranch,randomUUID()]);
    await pool.query("INSERT INTO servicios(id_servicio,nombre_servicio,duracion_min) VALUES($1,'Servicio sintetico',30)",[service]);
    await pool.query("INSERT INTO payment_providers(id_provider,codigo,nombre) VALUES($1,'pixelpay','Proveedor sintetico')",[provider]);
    const owner = async () => {
      const id=randomUUID(),person=randomUUID(),user=randomUUID();
      await pool.query("INSERT INTO personas(id_persona,nombres,apellidos) VALUES($1,'Cliente','Sintetico')",[person]);
      await pool.query("INSERT INTO usuarios(id_usuario,id_persona,estado_acceso) VALUES($1,$2,'activo')",[user,person]);
      await pool.query('INSERT INTO clientes(id_cliente,id_persona,id_usuario,id_sucursal_origen) VALUES($1,$2,$3,$4)',[id,person,user,branch]);
      return {id,person,user};
    };
    const appointment = async (actor,{state='en_espera',atBranch=branch,group=null,order=1,reward=false,total=300}={}) => {
      const id=randomUUID();
      await pool.query(`INSERT INTO citas(id_cita,id_grupo_cita,id_cliente,id_sucursal,id_empleado_barbero,estado_cita_codigo,
        inicio_at,fin_at,total_pagar_hnl,orden_integrante,es_canje_recompensa,creada_por_usuario_id)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day',now()+interval '1 day 30 minutes',$7,$8,$9,$10)`,
      [id,group,actor?.id||null,atBranch,barber,state,total,order,reward,actor?.user||null]);
      return id;
    };
    const paid = async (actor,cita,{amount=300,state='capturado',late=false,reference=randomUUID(),currency='HNL'}={}) => {
      const c=await pool.connect();
      try {
        await c.query('BEGIN');
        const intent=(await c.query(`INSERT INTO payment_intents(id_cita,id_provider,estado_intent_codigo,monto_hnl,
          idempotency_key,expires_at,created_by_usuario_id) VALUES($1,$2,'confirmado',$3,$4,now()+interval '1 hour',$5) RETURNING id_intent`,
        [cita,provider,amount,randomUUID(),actor.user])).rows[0].id_intent;
        await c.query(`INSERT INTO payments(id_intent,estado_pago_codigo,monto_hnl,moneda_codigo,pago_tardio,provider_tx_id,paid_at)
          VALUES($1,$2,$3,$4,$5,$6,now())`,[intent,state,amount,currency,late,reference]);
        await c.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1",[cita]);
        await c.query('COMMIT'); return intent;
      } catch(error) { await c.query('ROLLBACK'); throw error; } finally {c.release();}
    };
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id_points_tx) FROM points_transactions t) ledger,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id_cycle) FROM points_cycles t) cycles`)).rows;
    const balance = async actor => Number((await pool.query('SELECT balance_puntos FROM vw_points_balance WHERE id_cliente=$1',[actor.id])).rows[0]?.balance_puntos||0);
    const sql = name => source('db/manual/release10/'+name);
    const run = async name => pool.query(await sql(name));
    return {pool,source,sql,run,close,owner,appointment,paid,balance,snapshot,branch,otherBranch,service,prod};
  } catch(error) {await close();throw error;}
}
