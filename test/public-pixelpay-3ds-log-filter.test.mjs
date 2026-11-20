import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('documented SSH filter preserves start diagnostics while excluding poisoned metadata', () => {
  const document = readFileSync(new URL('../docs/pixelpay-public-3ds.md', import.meta.url), 'utf8');
  const source = document.match(/python3 - [^\n]+ <<'PY'\r?\n([\s\S]*?)\r?\nPY/)?.[1];
  assert.ok(source, 'the documented SSH command must remain executable');
  const id = '99999999-9999-4999-8999-999999999999';
  const attempt = '88888888-8888-4888-8888-888888888888';
  const base = { event: 'pixelpay_public_3ds_phase', id_intent: id, paymentAttemptId: attempt };
  const events = [
    { ...base, phase: 'start_result', state: 'unsupported', continuation_diagnostic: {
      code: 'PIXELPAY_3DS_COLLECTION_URL_ABSENT', upstream_http_status: 202, sale_environment: 'live',
      sdk_data: { payload: { present: true, type: 'string', length: 300, value: 'NEVER_LOG_PAYLOAD' },
        collection_url: { present: false, type: 'absent', origin: 'https://NEVER_LOG_HOST' },
        transaction_type_kind: 'songbird' },
      raw_to_sdk_equal: { payload: true, collection_url: false, transaction_type: true },
      error: 'NEVER_LOG_ERROR', payload: 'NEVER_LOG_JWT',
    } },
    { ...base, phase: 'start_failed', stage: 'worker_start', code: 'PIXELPAY_PUBLIC_3DS_START_UNCERTAIN',
      error: 'NEVER_LOG_SECRET', upstream_status: 'NEVER_LOG_STATUS' },
    { ...base, phase: 'start_result', state: 'NEVER_LOG_STATE', continuation_diagnostic: {
      code: 'NEVER_LOG_CODE', sale_environment: 'NEVER_LOG_ENV', sdk_data: {
        payload: { present: 'NEVER_LOG_BOOLEAN', type: 'NEVER_LOG_TYPE', length: 'NEVER_LOG_LENGTH' },
        transaction_type_kind: 'NEVER_LOG_TYPE',
      }, raw_to_sdk_equal: { payload: 'NEVER_LOG_COMPARISON' },
    } },
    { ...base, phase: 'NEVER_LOG_PHASE' },
    { ...base, id_intent: '00000000-0000-4000-8000-000000000000', phase: 'start_failed' },
  ];
  const runner = `
import io, json, subprocess, sys
fixture = json.load(sys.stdin)
class Logs:
    def __init__(self, *args, **kwargs):
        self.stdout = io.StringIO(''.join('2026-11-20T06:38:52Z ' + json.dumps(event) + '\\n' for event in fixture['events']))
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def wait(self): return 0
subprocess.Popen = Logs
sys.argv = ['filter', 'synthetic-only', fixture['id']]
exec(fixture['source'])
`;
  const execution = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', runner], {
    input: JSON.stringify({ source, events, id }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(execution.error, undefined);
  assert.equal(execution.status, 0, execution.stderr);
  assert.doesNotMatch(execution.stdout, /NEVER_LOG|"error"/);
  const rows = execution.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].phase, 'start_result');
  assert.equal(rows[0].state, 'unsupported');
  assert.equal(rows[0].continuation_diagnostic.code, 'PIXELPAY_3DS_COLLECTION_URL_ABSENT');
  assert.deepEqual(rows[0].continuation_diagnostic.sdk_data.payload, { present: true, type: 'string', length: 300 });
  assert.equal(rows[0].continuation_diagnostic.sdk_data.transaction_type_kind, 'songbird');
  assert.equal(rows[1].stage, 'worker_start');
  assert.equal(rows[1].http, null);
  assert.equal(rows[2].state, null);
  assert.equal(rows[2].continuation_diagnostic.code, null);
  assert.deepEqual(rows[2].continuation_diagnostic.sdk_data.payload, { present: null, type: null, length: null });
  assert.deepEqual(rows[3], { docker_exit_code: 0 });
});
