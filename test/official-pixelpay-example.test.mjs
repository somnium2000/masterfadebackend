import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { buildOfficialSale } from './fixtures/officialPixelPaySale.mjs';
const require=createRequire(import.meta.url);
const sdk=require('@pixelpay/sdk-core');
const axios=require('axios');
const nacl=require('tweetnacl');

test('official unmodified SDK: Node basic Sale, explicit 3DS rejection and TransactionResult is not approval',async()=>{
  const connect=net.Socket.prototype.connect,adapter=axios.defaults.adapter;
  let sockets=0,posts=0,status=200;
  net.Socket.prototype.connect=function(){sockets++;throw new Error('EXTERNAL_NETWORK_BLOCKED');};
  const methods=[sdk.Services.Transaction.prototype.doSale,sdk.Requests.SaleTransaction.prototype.withAuthenticationRequest];
  axios.defaults.adapter=async config=>{
    assert.equal(config.baseURL,'https://offline-pixelpay.invalid');
    let data;
    if(config.url.endsWith('public_key'))data={public_key:Buffer.from(nacl.box.keyPair().publicKey).toString('base64')};
    else {posts++;data=status===202?{transaction_type:'songbird',payload:'synthetic.initial.jwt'}:
      {response_approved:true,response_incomplete:false,response_code:'00',transaction_id:'synthetic-tx',transaction_amount:1};}
    return {status:config.url.endsWith('public_key')?200:status,data:{success:true,data},config,headers:{}};
  };
  try{
    const basic=buildOfficialSale(sdk);const response=await basic.service.doSale(basic.sale);
    assert.equal(posts,1);assert.equal(sdk.Entities.TransactionResult.validateResponse(response),true);
    assert.equal(sdk.Entities.TransactionResult.fromResponse(response).transaction_amount,1);
    const requested=buildOfficialSale(sdk,{authentication:true});
    await assert.rejects(requested.service.doSale(requested.sale),e=>e.message==='This platform not support 3DS transactions');
    assert.equal(posts,1);
    status=202;const implicit=buildOfficialSale(sdk);
    await assert.rejects(implicit.service.doSale(implicit.sale),e=>e instanceof ReferenceError&&e.message==='document is not defined');
    assert.equal(posts,2);
    for(const Response of [sdk.Responses.PaymentDeclinedResponse,sdk.Responses.TimeoutResponse]){
      const r=new Response();r.data={response_approved:false};
      assert.equal(sdk.Entities.TransactionResult.validateResponse(r),true);
      assert.equal(sdk.Entities.TransactionResult.fromResponse(r).response_approved,false);
    }
    assert.deepEqual(methods,[sdk.Services.Transaction.prototype.doSale,sdk.Requests.SaleTransaction.prototype.withAuthenticationRequest]);
  }finally{net.Socket.prototype.connect=connect;axios.defaults.adapter=adapter;assert.equal(sockets,0);}
});
