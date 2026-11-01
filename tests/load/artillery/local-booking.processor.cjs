const { randomUUID } = require('node:crypto');

let nextSlot = Number.parseInt(process.env.MF_ARTILLERY_SLOT_OFFSET || '0', 10) || 0;
let activeVusers = 0;
const iterationPauseMs = Math.max(0, Number.parseFloat(process.env.MF_ARTILLERY_THINK_SECONDS || '0') * 1000);

function slotFor(index) {
  const slotsPerDay = 8;
  const dayOffset = Math.floor(index / slotsPerDay);
  const withinDay = index % slotsPerDay;
  const weekOffset = Math.floor(dayOffset / 6) * 7;
  const weekdayOffset = dayOffset % 6;
  const totalMinutes = (8 * 60) + (withinDay * 80);
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return new Date(Date.UTC(2026, 10, 9 + weekOffset + weekdayOffset, hour + 6, minute)).toISOString();
}

module.exports = {
  assignSyntheticBooking(userContext, events, done) {
    const slotIndex = nextSlot++;
    activeVusers += 1;
    events.emit('histogram', 'masterfade.active_vusers', activeVusers);
    Object.assign(userContext.vars, {
      branchId: '11111111-1111-4111-8111-111111111111',
      barberId: '33333333-3333-4333-8333-333333333333',
      serviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      startAt: slotFor(slotIndex),
    });
    userContext.vars.slotDate = userContext.vars.startAt.slice(0, 10);
    done();
  },
  prepareBookingIteration(userContext, events, done) {
    userContext.vars.idempotencyKey = randomUUID();
    userContext.vars.email = `artillery.${randomUUID()}@example.test`;
    delete userContext.vars.groupId;
    delete userContext.vars.releaseToken;
    done();
  },
  pauseBetweenIterations(userContext, events, done) {
    setTimeout(done, iterationPauseMs);
  },
  recordHoldCreated(requestParams, response, userContext, events, done) {
    if (response.statusCode === 201) events.emit('counter', 'masterfade.holds_created', 1);
    done();
  },
  recordHoldReleased(requestParams, response, userContext, events, done) {
    if (response.statusCode === 200) events.emit('counter', 'masterfade.holds_released', 1);
    done();
  },
  recordVuserExit(userContext, events, done) {
    activeVusers = Math.max(0, activeVusers - 1);
    events.emit('histogram', 'masterfade.active_vusers', activeVusers);
    done();
  },
};
