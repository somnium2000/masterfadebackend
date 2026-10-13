import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mapSlotsForResponse, buildCuratedSlotExposure, buildCuratedSlotExposureDebug } from "../src/services/agendaService.js";

const cases = [["08:00", "manana"], ["11:45", "manana"], ["12:30", "tarde"], ["17:45", "tarde"], ["18:00", "noche"], ["22:45", "noche"]];
function mapped(hora, duration = 15) {
  const inicio_at = new Date(`2026-10-14T${hora}:00-06:00`);
  return mapSlotsForResponse([{ inicio_at, fin_at: new Date(+inicio_at + duration * 60000) }], { duracion_visible_min: duration })[0];
}

for (const tz of ["UTC", "America/Los_Angeles", "Europe/Madrid", "Asia/Tokyo"]) {
  test(`curated periods and ranking are operational under TZ=${tz}`, () => {
    const program = `
      import assert from 'node:assert/strict';
      import {mapSlotsForResponse,buildCuratedSlotExposure,buildCuratedSlotExposureDebug} from './src/services/agendaService.js';
      const cases=${JSON.stringify(cases)};
      const slots=cases.map(([hora])=>{const inicio_at=new Date('2026-10-14T'+hora+':00-06:00');return mapSlotsForResponse([{inicio_at,fin_at:new Date(+inicio_at+900000)}],{duracion_visible_min:15})[0];});
      const curated=buildCuratedSlotExposure(slots,{alternativeSpacingMin:0});
      for(const [hora,key] of cases){
        const slot=slots.find(s=>s.hora===hora);
        assert.equal(slot.period_key,key);
        const period=curated[key];
        assert.ok([period.recommended,...period.alternatives,...period.overflow].includes(slot));
      }
      for(const [key,p] of Object.entries(curated))for(const s of [p.recommended,...p.alternatives,...p.overflow].filter(Boolean))assert.equal(s.period_key,key);
      console.log(JSON.stringify({curated,debug:buildCuratedSlotExposureDebug(slots)}));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: new URL("../", import.meta.url), env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const slots = cases.map(([hora]) => mapped(hora));
    assert.deepEqual(JSON.parse(run.stdout), { curated: buildCuratedSlotExposure(slots, { alternativeSpacingMin: 0 }), debug: buildCuratedSlotExposureDebug(slots) });
  });
}

test("period boundary crossings are excluded; exact boundaries and midnight are retained", () => {
  for (const hora of ["11:50", "17:50", "05:50", "23:50"]) {
    assert.equal(Object.values(buildCuratedSlotExposure([mapped(hora)])).reduce((sum, p) => sum + p.total, 0), 0);
  }
  for (const [hora, key] of [["11:45", "manana"], ["17:45", "tarde"], ["23:45", "noche"]]) {
    assert.equal(buildCuratedSlotExposure([mapped(hora)])[key].total, 1);
  }
});

test("curated ranking, residual filtering, spacing and overflow keep their contract", () => {
  const slots = ["06:05", "08:00", "08:05", "08:15", "08:30", "09:00", "09:30", "10:00"].map(hora => mapped(hora));
  const period = buildCuratedSlotExposure(slots, { minSellableDurationMin: 15 }).manana;
  assert.equal(period.recommended.hora, "08:00");
  assert.deepEqual(period.alternatives.map(s => s.hora), ["08:30", "09:00", "09:30"]);
  assert.deepEqual(period.overflow.map(s => s.hora), ["08:05", "08:15", "10:00"]);
  assert.equal(period.total, 7);
  assert.equal(period.has_more, true);
  const debug = buildCuratedSlotExposureDebug(slots.slice(1)).manana;
  assert.equal(debug.candidates[0].hora, "08:00");
  assert.equal(debug.candidates[0].residual_before_interval_min, 120);
});
