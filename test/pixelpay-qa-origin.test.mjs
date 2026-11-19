import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPixelPayQaOrigin } from '../src/services/payments/pixelPayQaOrigin.js';
import { createPixelPaySaleAttemptRecord } from '../src/services/payments/pixelPaySaleAttemptStore.js';
const id='11111111-1111-4111-8111-111111111111';
test('unknown or unreadable QA origin fails closed; ordinary historical rows stay unmarked',async()=>{
  for(const result of [{rows:[{qa_test_origin:'forged'}]},new Error('timeout')]){
    const db={async query(){if(result instanceof Error)throw result;return result;}};
    await assert.rejects(loadPixelPayQaOrigin(db,id),e=>e.code==='PIXELPAY_QA_ORIGIN_UNAVAILABLE');
  }
  assert.equal(await loadPixelPayQaOrigin({async query(){return{rows:[]};}},id),null);
});
test('a marked START cannot silently fall back when the migration is absent',async()=>{
  let inserts=0;
  const db={async query(sql){inserts++;assert.match(sql,/qa_test_origin/);throw Object.assign(new Error('missing column'),{code:'42703'});}};
  await assert.rejects(createPixelPaySaleAttemptRecord(db,{idIntent:id,paymentAttemptId:id,qaTestOrigin:'sandbox_session'}),e=>e.code==='42703');
  assert.equal(inserts,1);
});
