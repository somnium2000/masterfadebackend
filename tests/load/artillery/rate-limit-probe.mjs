import { writeFile } from 'node:fs/promises';

const target = 'http://127.0.0.1:3102/v1/health/live';
const output = process.argv[2];
const total = Number.parseInt(process.argv[3] || '210', 10);
const statuses = [];
for (let index = 0; index < total; index += 1) {
  const response = await fetch(target);
  statuses.push(response.status);
}
const result = {
  total,
  ok: statuses.filter((status) => status === 200).length,
  limited: statuses.filter((status) => status === 429).length,
  unexpected: statuses.filter((status) => ![200, 429].includes(status)).length,
  firstLimitedAt: statuses.findIndex((status) => status === 429) + 1,
};
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
if (result.limited === 0 || result.unexpected !== 0) process.exitCode = 1;
