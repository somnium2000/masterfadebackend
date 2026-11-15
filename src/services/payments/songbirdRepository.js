import { AppError } from '../../utils/errors.js';
const denied = () => new AppError(403, 'Autenticacion no disponible.', { code: 'SONGBIRD_OWNER_OR_CONTEXT_INVALID' });

export class SongbirdRepository {
  constructor(pool) { this.pool = pool; }
  async preflight() {
    const r = await this.pool.query("SELECT to_regclass('app_private.pixelpay_songbird_handoffs') IS NOT NULL AS ready");
    if (r.rows[0]?.ready !== true) throw new AppError(503, 'Autenticacion no disponible.', { code: 'SONGBIRD_SCHEMA_REQUIRED' });
  }
  async reserve(client, row) {
    const result = await client.query(`INSERT INTO app_private.pixelpay_songbird_handoffs
      (id_intent,payment_attempt_id,owner_id,group_id,order_id,amount_hnl,currency,state,expires_at,payload_box)
      SELECT pi.id_intent,a.payment_attempt_id,$3::uuid,$4::uuid,$5::text,$6::numeric,$7::text,$8::text,$9::timestamptz,$10::text
      FROM public.payment_intents pi JOIN app_private.pixelpay_sale_attempts a ON a.id_intent=pi.id_intent
      WHERE pi.id_intent=$1::uuid AND a.payment_attempt_id=$2::uuid AND pi.created_by_usuario_id=$3::uuid
        AND pi.id_grupo_cita=$4::uuid AND pi.orden_compra=$5::text AND pi.monto_hnl=$6::numeric
        AND pi.moneda_codigo=$7::text AND pi.estado_intent_codigo='pendiente_confirmacion'
      RETURNING *`,
    [row.id_intent,row.payment_attempt_id,row.owner_id,row.group_id,row.order_id,row.amount_hnl,row.currency,row.state,row.expires_at,row.payload_box]);
    if (!result.rows[0]) throw denied();
    return result.rows[0];
  }
  async mutate(id, owner, work) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[`pixelpay-sale:${id}`]);
      const rows = await c.query(`SELECT h.*,pi.estado_intent_codigo AS intent_state FROM app_private.pixelpay_songbird_handoffs h
        JOIN public.payment_intents pi ON pi.id_intent=h.id_intent
        WHERE h.id_intent=$1::uuid AND h.owner_id=$2::uuid AND pi.created_by_usuario_id=$2::uuid
          AND pi.id_grupo_cita=h.group_id AND pi.orden_compra=h.order_id
          AND pi.monto_hnl=h.amount_hnl AND pi.moneda_codigo=h.currency
        FOR UPDATE OF pi,h`,[id,owner]);
      const row = rows.rows[0];
      if (!row) { const result = await work(null); await c.query('COMMIT'); return result; }
      const citas = await c.query(`SELECT id_cita,estado_cita_codigo FROM public.citas
        WHERE id_grupo_cita=$1::uuid AND deleted_at IS NULL ORDER BY id_cita FOR UPDATE`,[row.group_id]);
      const holds = await c.query(`SELECT h.estado_hold_codigo,h.expires_at FROM public.citas_holds h
        JOIN public.citas ci ON ci.id_cita=h.id_cita WHERE ci.id_grupo_cita=$1::uuid AND ci.deleted_at IS NULL
        ORDER BY h.id_hold FOR UPDATE OF h`,[row.group_id]);
      // AM: No stale hold or changed financial context can resume authentication.
      if (row.intent_state !== 'pendiente_confirmacion' || !citas.rows.length || holds.rows.length !== citas.rows.length
        || citas.rows.some(ci=>ci.estado_cita_codigo!=='pendiente_pago')
        || holds.rows.some(h=>h.estado_hold_codigo!=='activo'||!Number.isFinite(Date.parse(h.expires_at))||Date.parse(h.expires_at)<=Date.now())) {
        row.state='expired'; row.payload_box=null; row.challenge_box=null;
      }
      row.version++;
      const result = await work(row);
      await c.query(`UPDATE app_private.pixelpay_songbird_handoffs SET state=$2,version=$7,lease_id=$3::uuid,
        payload_box=$4,challenge_box=$5,input_hash=$6,authentication_id=$8,updated_at=clock_timestamp() WHERE id_intent=$1::uuid`,
      [id,row.state,row.lease_id,row.payload_box,row.challenge_box,row.input_hash||null,row.version,row.authentication_id||null]);
      await c.query('COMMIT'); return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
}
