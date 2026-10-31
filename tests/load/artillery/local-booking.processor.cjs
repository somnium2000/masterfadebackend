const { randomUUID } = require('node:crypto');

let nextSlot = Number.parseInt(process.env.MF_ARTILLERY_SLOT_OFFSET || '0', 10) || 0;
let activeVusers = 0;

function slotFor(index) {
  const slotsPerDay = 8;
  const dayOffset = Math.floor(index / slotsPerDay);
  const withinDay = index % slotsPerDay;
  const weekOffset = Math.floor(dayOffset / 6) * 7;
  const weekdayOffset = dayOffset % 6;
  const totalMinutes = (8 * 60) + (withinDay * 80);
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const date = new Date(Date.UTC(2026, 10, 9 + weekOffset + weekdayOffset, hour + 6, minute));
  return date.toISOString();
}

module.exports = {
  assignSyntheticBooking(userContext, events, done) {
    const index = nextSlot++;
    activeVusers += 1;
    events.emit('histogram', 'masterfade.active_vusers', activeVusers);
    userContext.vars.idempotencyKey = randomUUID();
    userContext.vars.email = `artillery.${randomUUID()}@example.test`;
    userContext.vars.startAt = slotFor(index);
    done();
  },
  recordVuserExit(userContext, events, done) {
    activeVusers = Math.max(0, activeVusers - 1);
    events.emit('histogram', 'masterfade.active_vusers', activeVusers);
    done();
  },
};
