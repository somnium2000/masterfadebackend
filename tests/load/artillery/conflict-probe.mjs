import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const target = 'http://127.0.0.1:3102';
const output = process.argv[2];
const races = Number.parseInt(process.argv[3] || '20', 10);
const delayMs = Number.parseInt(process.argv[4] || '0', 10);
const results = [];

function payload(index, contender) {
  const businessDay = Math.floor(index / 4);
  const week = Math.floor(businessDay / 6);
  const weekday = businessDay % 6;
  const day = 4 + (week * 7) + weekday;
  const hour = 14 + (index % 4);
  const startAt = new Date(Date.UTC(2027, 0, day, hour, 0)).toISOString();
  return {
    id_sucursal: '11111111-1111-4111-8111-111111111111',
    titular: { nombre: `Conflicto Sintetico ${contender}`, email: `conflict.${randomUUID()}@example.test`, telefono: '99990000' },
    id_barbero: '33333333-3333-4333-8333-333333333333',
    fecha_inicio: startAt,
    selection_type: 'services',
    servicios: [{ id_servicio: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
  };
}

async function createHold(body) {
  const response = await fetch(`${target}/v1/public/citas/hold`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': randomUUID() }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

for (let index = 0; index < races; index += 1) {
  const base = payload(index, 1);
  const attempts = await Promise.all([createHold(base), createHold({ ...base, titular: payload(index, 2).titular })]);
  const winner = attempts.find((entry) => entry.status === 201);
  if (winner) {
    await fetch(`${target}/v1/public/citas/hold/${winner.body.data.id_grupo_cita}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ release_token: winner.body.data.release_token }),
    });
  }
  results.push({ race: index + 1, statuses: attempts.map((entry) => entry.status) });
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const summary = {
  races,
  passed: results.filter((entry) => entry.statuses.includes(201) && entry.statuses.includes(409)).length,
  created: results.flatMap((entry) => entry.statuses).filter((status) => status === 201).length,
  conflicts: results.flatMap((entry) => entry.statuses).filter((status) => status === 409).length,
  unexpected: results.flatMap((entry) => entry.statuses).filter((status) => ![201, 409].includes(status)).length,
  results,
};
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
if (summary.passed !== races || summary.unexpected !== 0) process.exitCode = 1;
