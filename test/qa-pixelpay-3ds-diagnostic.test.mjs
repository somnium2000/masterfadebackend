import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQaPixelPay3dsDiagnostic, qa3dsWindowOpen, isQa3dsIntent, assertQa3dsFreshIntent,
  assertQa3dsInitialPayload, assertQa3dsCardAllowed, isQa3dsCardHashAllowed, sanitizeQa3dsObservation } from '../src/services/payments/qaPixelPay3dsDiagnostic.js';
const ID = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2026-11-15T12:00:00Z');
const env = { NODE_ENV:'development', ENTORNO:'qa', PAYMENT_PROVIDER:'pixelpay', PIXELPAY_IMPLEMENTATION:'sdk', PIXELPAY_ENV:'sandbox',
  PIXELPAY_ENDPOINT:'https://pixelpay.dev', PIXELPAY_APP_URL:'https://pixelpay.dev', QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED:'true',
  QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID:ID, QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL:'2026-11-15T12:08:00Z' };
const config = () => resolveQaPixelPay3dsDiagnostic(env, {bookingEnabled:true,now});
const intent = () => ({id_intent:ID,estado_intent_codigo:'link_generado',monto_hnl:1,moneda_codigo:'HNL',orden_compra:`MF-PIXELPAY-${ID.replaceAll('-','').toUpperCase()}`});

test('3DS observation defaults off; retained target stays identifiable after rollback',()=>{
  assert.equal(resolveQaPixelPay3dsDiagnostic({}).enabled,false);
  const off=resolveQaPixelPay3dsDiagnostic({QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID:ID});
  assert.equal(qa3dsWindowOpen(off,now),false); assert.equal(isQa3dsIntent(off,ID),true);
  assert.equal(qa3dsWindowOpen(config(),now),true); assert.equal(qa3dsWindowOpen(config(),now+480000),false);
});
for (const [name,patch] of Object.entries({ invalidFlag:{QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED:'yes'}, production:{NODE_ENV:'production'},
  entorno:{ENTORNO:'production'},live:{PIXELPAY_ENV:'live'},direct:{PIXELPAY_IMPLEMENTATION:'direct'},provider:{PAYMENT_PROVIDER:'mock'},
  endpoint:{PIXELPAY_ENDPOINT:'https://pixelpay.app'},appUrl:{PIXELPAY_APP_URL:'https://pixelpay.app'},sale:{QA_PRIVATE_COMMERCE_SANDBOX_SALE_ENABLED:'true'},
  legacySale:{QA_PRIVATE_COMMERCE_SALE_ENABLED:'true'},legacyPilot:{PRIVATE_COMMERCE_PILOT_ENABLED:'true'},sim:{ENABLE_QA_PAYMENT_SIMULATION:'true'},vip:{ENABLE_QA_VIP_PURCHASE_SIMULATION:'true'},
  missingTarget:{QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID:''},twoTargets:{QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID:ID+','+ID},
  missingUntil:{QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL:''},invalidDate:{QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL:'2026-02-30T11:59:00Z'},
  over10min:{QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL:'2026-11-15T12:10:01Z'},nonUtc:{QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL:'2026-11-15T06:08:00-06:00'} })) {
  test('3DS observation rejects '+name,()=>assert.throws(()=>resolveQaPixelPay3dsDiagnostic({...env,...patch},{bookingEnabled:true,now})));
}
test('3DS observation requires the existing verified identity booking policy',()=>assert.throws(()=>resolveQaPixelPay3dsDiagnostic(env,{now})));
test('restart with expired valid configuration stays available but grants no Sale',()=>{
  const expired=resolveQaPixelPay3dsDiagnostic({...env,QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL:'2026-11-15T11:59:00Z'},{bookingEnabled:true,now});
  assert.equal(expired.enabled,true); assert.equal(qa3dsWindowOpen(expired,now),false); assert.equal(isQa3dsIntent(expired,ID),true);
  assert.throws(()=>assertQa3dsFreshIntent(expired,intent(),1,false,now));
});
test('only fresh canonical one-HNL intent with no dispatch/session is admissible',()=>{
  assert.doesNotThrow(()=>assertQa3dsFreshIntent(config(),intent(),1,false,now));
  for(const patch of [{estado_intent_codigo:'pendiente_confirmacion'},{estado_intent_codigo:'confirmado'},{referencia_externa:'opaque'},
    {provider_session_id:'opaque'},{link_pago_url:'https://provider.invalid'},{moneda_codigo:'USD'},{monto_hnl:2},{orden_compra:'foreign'}, {id_intent:'22222222-2222-4222-8222-222222222222'}]) {
    assert.throws(()=>assertQa3dsFreshIntent(config(),{...intent(),...patch},1,false,now));
  }
  assert.throws(()=>assertQa3dsFreshIntent(config(),intent(),1,true,now));
  assert.throws(()=>assertQa3dsFreshIntent(config(),intent(),2,false,now));
  assert.throws(()=>assertQa3dsFreshIntent(config(),intent(),1,false,now+480000));
});
test('continuation, forged capability, money, JWT and relay fields are rejected before any provider operation',()=>{
  assert.doesNotThrow(()=>assertQa3dsInitialPayload({id_intent:ID}));
  for(const field of ['authentication_identifier','authentication_request','identifier','payload','jwt','op','url','headers','amount','currency','qa3dsDiagnostic','qa_3ds_diagnostic','continue_success']) {
    assert.throws(()=>assertQa3dsInitialPayload({id_intent:ID,[field]:'synthetic'}),e=>e.code==='QA_3DS_INITIAL_ONLY');
  }
});
test('diagnostic uses only official case2.9 digests without broadening normal card rules',()=>{
  for(const hash of ['9437b269faa268b21d82ac4d61427916332f584498a00debe3d69ab90a0d744c','ca4ce285007723743c0e3d7126dfb1cdde0edd50ea4fbf456a216808917a128a']) assert.equal(isQa3dsCardHashAllowed(hash),true);
  assert.equal(isQa3dsCardHashAllowed('untrusted'),false);
  assert.throws(()=>assertQa3dsCardAllowed('synthetic-non-card'),e=>e.code==='QA_3DS_CARD_NOT_ALLOWED');
});
test('observation sanitizer never passes opaque data or untrusted labels',()=>{
  const safe=sanitizeQa3dsObservation({payload:'SECRET',jwt:'SECRET',public_key:'SECRET',auth_hash:'SECRET',response_class:'SECRET',transaction_type:'SECRET',
    upstream_http_status:202,opaque_payload_present:true,browser_authentication_data_exposed:true,continuation_accredited:true});
  assert.equal(JSON.stringify(safe).includes('SECRET'),false);
  assert.equal(safe.upstream_http_status,202); assert.equal(safe.opaque_payload_present,true);
  assert.equal(safe.response_class,null); assert.equal(safe.browser_authentication_data_exposed,false); assert.equal(safe.continuation_accredited,false);
});
