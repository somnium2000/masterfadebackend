import assert from 'node:assert/strict';
import test from 'node:test';
import { loadReservationMailContracts } from './helpers/reservationMailContract.mjs';

const groupId = '11111111-2222-4333-8444-555555555555';
const rows = ['Padre','Hijo'].map((alias, index) => ({
  id_cita: `cita-${index}`, alias_integrante: alias, orden_integrante: index+1,
  contacto_nombre: alias, contacto_email: `${alias.toLowerCase()}@example.invalid`,
  inicio_at:'2026-10-28T15:00:00Z', nombre_barbero:'Barbero aislado', monto_total_hnl:0,
}));

test('correos reales pagados y de membresia usan el mismo codigo de grupo para todos', async () => {
  const contracts = await loadReservationMailContracts();
  const notifications = [];
  await contracts.queuePostPaymentEmails({ async query(sql, values) {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('INSERT INTO public.notificaciones_email')) { notifications.push(values); return { rows: [] }; }
    assert.match(sql, /WHERE c.id_grupo_cita = \$1::uuid/);
    return { rows };
  } }, { idGrupoCita:groupId, totalGrupo:1 });
  assert.equal(notifications.length,2);
  for (const notification of notifications) {
    assert.equal(notification[1], 'Reserva confirmada #S64WZ');
    assert.match(notification[2], /Código de cita: S64WZ/);
    assert.equal(notification[4],groupId);
  }
  const delivered=[];
  await contracts.sendNoPaymentConfirmationEmails({ mailer: { configured:true, async sendMail(mail) { delivered.push(mail); return { sent:true }; } } }, null, { groupId, confirmationRows:rows });
  assert.equal(delivered.length,2);
  for(const mail of delivered) { assert.equal(mail.subject,'Reserva confirmada #S64WZ'); assert.match(mail.text,/Codigo de cita: S64WZ/); assert.match(mail.html,/S64WZ/); }
  const paidTemplate=contracts.buildPostPaymentEmailTemplate({recipientName:'Cliente',bookingCode:contracts.buildBookingShortCode(groupId,5),totalGrupo:1,detailLines:[]});
  assert.equal(paidTemplate.subject,'Reserva confirmada #S64WZ');
});
