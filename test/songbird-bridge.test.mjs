import test from 'node:test';
import assert from 'node:assert/strict';
import { SongbirdBridge, resolveSongbirdBridgeConfig, sealSongbird, openSongbird } from '../src/services/payments/songbirdBridge.js';
import { assertSongbirdFinalizationBlocked } from '../src/services/payments/songbirdContract.js';

// AM: Synthetic local protocol fixtures, never provider signatures, card data or financial evidence.
export const context = { idIntent:'11111111-1111-4111-8111-111111111111',paymentAttemptId:'22222222-2222-4222-8222-222222222222',
  ownerId:'33333333-3333-4333-8333-333333333333',groupId:'44444444-4444-4444-8444-444444444444',orderId:'MF-OFFLINE',amount:1,currency:'HNL' };
const TOKEN='synthetic.initial.signature';
const VALIDATED='synthetic.validated.signature';
export class MemoryBridgeRepository {
  constructor(){this.row=null;this.tail=Promise.resolve();this.fail=false;}
  async reserve(_client,row){if(this.row)throw new Error('unique');this.row=structuredClone(row);return this.row;}
  async mutate(id,owner,fn){
    let release;const before=this.tail;this.tail=new Promise(resolve=>{release=resolve;});await before;
    try{
      if(this.row&&(this.row.id_intent!==id||this.row.owner_id!==owner))throw Object.assign(new Error('denied'),{statusCode:403});
      const copy=structuredClone(this.row);if(copy)copy.version++;
      const result=await fn(copy);if(this.fail)throw new Error('rollback');this.row=copy;return result;
    }finally{release();}
  }
}
export function fixtureContract(count={lookup:0,validate:0}){
  return {browserPayloadAccredited:true,inspect:token=>token===TOKEN,
    challengeAllowed:c=>c?.acsUrl==='https://acs.offline.invalid/challenge',
    async lookup(){count.lookup++;return {verified:true,challenge:{acsUrl:'https://acs.offline.invalid/challenge',payload:'synthetic-challenge',transactionId:'synthetic-auth',authenticationId:'synthetic-identifier'}};},
    async validate({jwt}){count.validate++;return {verified:jwt===VALIDATED};}};
}
async function rig(options={}){
  const repository=options.repository||new MemoryBridgeRepository();let time=Date.now();
  const config={enabled:true,key:Buffer.alloc(32,8)};
  const bridge=new SongbirdBridge({repository,config,clock:()=>time,...options});
  await bridge.reserve(null,{...context,expiresAt:new Date(time+300000).toISOString()});
  return {bridge,repository,config,expire:()=>{time+=120001;}};
}
const claim=(bridge)=>bridge.claim(context.idIntent,context.ownerId);
const status=(bridge)=>bridge.status(context.idIntent,context.ownerId);

test('production contract persists a blocked state without retaining/exposing an opaque payload',async()=>{
  const {bridge,repository}=await rig();
  const captured=await bridge.capture(context.idIntent,context.ownerId,TOKEN);
  assert.equal(captured.state,'contract_blocked');assert.equal(repository.row.payload_box,null);
  assert.equal(captured.financial_finalization_enabled,false);
  await assert.rejects(claim(bridge),e=>e.code==='PIXELPAY_SONGBIRD_CONTRACT_BLOCKED');
  assert.equal(JSON.stringify(repository.row).includes(TOKEN),false);
});
test('feature defaults off and cannot be enabled in Live/production or without a dedicated key',()=>{
  assert.equal(resolveSongbirdBridgeConfig({}).enabled,false);
  const env={NODE_ENV:'development',ENTORNO:'qa',PAYMENT_PROVIDER:'pixelpay',PIXELPAY_IMPLEMENTATION:'sdk',PIXELPAY_ENV:'sandbox',
    PIXELPAY_ENDPOINT:'https://pixelpay.dev',PIXELPAY_APP_URL:'https://pixelpay.dev',QA_PIXELPAY_SONGBIRD_BRIDGE_ENABLED:'true',
    QA_PIXELPAY_SONGBIRD_BRIDGE_KEY:Buffer.alloc(32,8).toString('base64')};
  assert.equal(resolveSongbirdBridgeConfig(env,{enabled:true}).enabled,true);
  for(const patch of [{NODE_ENV:'production'},{PIXELPAY_ENV:'live'},{PIXELPAY_ENDPOINT:'https://wrong.invalid'},
    {QA_PIXELPAY_SONGBIRD_BRIDGE_KEY:''},{QA_PIXELPAY_SONGBIRD_BRIDGE_ENABLED:'yes'}])assert.throws(()=>resolveSongbirdBridgeConfig({...env,...patch},{enabled:true}));
  assert.throws(()=>resolveSongbirdBridgeConfig(env,{enabled:false}));
});
test('AES-GCM authenticates attempt binding and ciphertext; never plaintext at rest',()=>{
  const key=Buffer.alloc(32,8);const box=sealSongbird(TOKEN,key,'binding');
  assert.equal(box.includes(TOKEN),false);assert.equal(openSongbird(box,key,'binding'),TOKEN);
  assert.throws(()=>openSongbird(box,key,'foreign'));assert.throws(()=>openSongbird(box,Buffer.alloc(32,9),'binding'));
});
test('reserve survives loss of the initial HTTP response without releasing the existing financial claim',async()=>{
  const {bridge,repository}=await rig();
  const restarted=new SongbirdBridge({repository,config:bridge.config});
  assert.equal((await status(restarted)).state,'awaiting_response');
  await assert.rejects(claim(restarted),e=>e.code==='PIXELPAY_SONGBIRD_CONTRACT_BLOCKED');
});
test('one browser wins simultaneous claims; duplicate capture/reload never reissues JWT',async()=>{
  const {bridge,repository}=await rig({contract:fixtureContract()});
  await bridge.capture(context.idIntent,context.ownerId,TOKEN);
  assert.equal(repository.row.payload_box.includes(TOKEN),false);
  const results=await Promise.allSettled([claim(bridge),claim(bridge)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const first=results.find(r=>r.status==='fulfilled').value;
  assert.equal(first.handoff.jwt,TOKEN);assert.equal(repository.row.payload_box,null);
  assert.equal(first.handoff.order_id,context.orderId);
  await bridge.capture(context.idIntent,context.ownerId,'foreign.token.signature');
  const restart=new SongbirdBridge({repository,config:bridge.config,contract:fixtureContract()});
  await assert.rejects(claim(restart),e=>e.code==='SONGBIRD_ALREADY_LEASED');
  assert.equal(JSON.stringify(await status(restart)).includes(TOKEN),false);
});
test('lease/phase binding prevents wrong attempt, out-of-order events, duplicates and finalization',async()=>{
  const count={lookup:0,validate:0};const {bridge}=await rig({contract:fixtureContract(count)});
  await bridge.capture(context.idIntent,context.ownerId,TOKEN);const lease=(await claim(bridge)).handoff.lease_id;
  await assert.rejects(bridge.step(context.idIntent,context.ownerId,'validated',lease,VALIDATED));
  await assert.rejects(bridge.step(context.idIntent,context.ownerId,'setup','foreign','reference'));
  const setup=await bridge.step(context.idIntent,context.ownerId,'setup',lease,'reference');
  assert.equal(setup.state,'challenge_ready');
  await assert.rejects(bridge.step(context.idIntent,context.ownerId,'setup',lease,'reference'));
  assert.equal((await bridge.step(context.idIntent,context.ownerId,'validated',lease,VALIDATED)).state,'authentication_complete');
  assert.deepEqual(count,{lookup:1,validate:1});
  await assert.rejects(bridge.step(context.idIntent,context.ownerId,'validated',lease,VALIDATED));
  assert.throws(assertSongbirdFinalizationBlocked,e=>e.code==='PIXELPAY_3DS_FINALIZATION_BLOCKED');
  assert.equal((await status(bridge)).financial_finalization_enabled,false);
});

test('provider challenge destinations require accreditation and only explicit browser fields leave the backend',async()=>{
  for(const allowed of [false,true]){
    const contract=fixtureContract();const lookup=contract.lookup;
    contract.lookup=async()=>{const result=await lookup();result.challenge.internalCredential='NEVER_RETURN_THIS';return result;};
    contract.challengeAllowed=()=>allowed;
    const {bridge}=await rig({contract});await bridge.capture(context.idIntent,context.ownerId,TOKEN);
    const lease=(await claim(bridge)).handoff.lease_id;
    const result=await bridge.step(context.idIntent,context.ownerId,'setup',lease,'reference');
    assert.equal(result.state,allowed?'challenge_ready':'contract_blocked');
    assert.equal(JSON.stringify(result).includes('NEVER_RETURN_THIS'),false);
    assert.equal(result.financial_finalization_enabled,false);
  }
});
test('authentication phase commits before adapter; concurrent duplicate never repeats lookup',async()=>{
  const count={lookup:0,validate:0};const contract=fixtureContract(count);let finish;
  const lookup=contract.lookup;contract.lookup=async()=>{const r=await lookup();await new Promise(resolve=>{finish=resolve;});return r;};
  const {bridge,repository}=await rig({contract});await bridge.capture(context.idIntent,context.ownerId,TOKEN);
  const lease=(await claim(bridge)).handoff.lease_id;
  const first=bridge.step(context.idIntent,context.ownerId,'setup',lease,'reference');
  while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(repository.row.state,'setup_in_flight');
  await assert.rejects(bridge.step(context.idIntent,context.ownerId,'setup',lease,'reference'));
  finish();await first;assert.equal(count.lookup,1);
});
test('abandonment, transport loss and late responses recover state only, without replay',async()=>{
  const contract=fixtureContract();let finish;contract.lookup=()=>new Promise(resolve=>{finish=resolve;});
  const {bridge}=await rig({contract});await bridge.capture(context.idIntent,context.ownerId,TOKEN);
  const lease=(await claim(bridge)).handoff.lease_id;
  const pending=bridge.step(context.idIntent,context.ownerId,'setup',lease,'reference');
  while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
  await bridge.interrupt(context.idIntent,context.ownerId,lease);
  finish({verified:true,challenge:{}});assert.equal((await pending).state,'interrupted');
  await assert.rejects(bridge.step(context.idIntent,context.ownerId,'setup',lease,'reference'));
});
test('expired/disabled/tampered handoff never returns its token or confirms payment',async()=>{
  for(const mode of ['expiry','disabled','tampered']){
    const {bridge,repository,config,expire}=await rig({contract:fixtureContract()});await bridge.capture(context.idIntent,context.ownerId,TOKEN);
    if(mode==='expiry')expire();if(mode==='disabled')config.enabled=false;if(mode==='tampered')repository.row.payload_box='invalid';
    let response;try{response=await claim(bridge);}catch{response=await status(bridge);}
    assert.equal(JSON.stringify(response).includes(TOKEN),false);assert.equal(response.financial_finalization_enabled,false);
    if(mode==='expiry')assert.equal(repository.row.payload_box,null);
  }
});
test('rollback of a browser claim exposes nothing and leaves the prior durable state intact',async()=>{
  const {bridge,repository}=await rig({contract:fixtureContract()});await bridge.capture(context.idIntent,context.ownerId,TOKEN);repository.fail=true;
  await assert.rejects(claim(bridge));assert.equal(repository.row.state,'handoff_ready');
});
