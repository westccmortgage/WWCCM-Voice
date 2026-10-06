import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayTextModel,RELAY_MODEL} from '../src/relay-text-model.mjs';
import {createRelayBackend} from '../src/relay-backend.mjs';
const callSid='CA'+'a'.repeat(32),suiteId='relay-fixture';
const context={text:"I'm Jordan. I want repairs.",facts:{name:'Jordan'},history:[],instruction:'Remember confirmed facts.',requestId:'fixture:S1',signal:new AbortController().signal,attempt:{claimed:true,providerRequests:1,requestId:'fixture:S1',reservationId:'r1'},reservation:{id:'r1',pricingSnapshot:{model:RELAY_MODEL,maximumInputTokens:8000,maximumOutputTokens:400}}};
test('plain text provider wire has one phase, no strict tool schema or forced tool choice',async()=>{
 let request;const model=createRelayTextModel({transport:async r=>{request=r;return{status:200,body:{model:RELAY_MODEL,stop_reason:'end_turn',content:[{type:'text',text:'Hi Jordan. What repair outcome matters most?'}],usage:{input_tokens:25,output_tokens:15}}};}});
 const response=await model.generate(context);assert.match(response.text,/Jordan/);assert.equal(request.body.tools,undefined);assert.equal(request.body.tool_choice,undefined);assert.equal(request.body.thinking,undefined);assert.equal(request.body.messages.length,1);assert.equal(request.reservationId,'r1');
});
test('truncated/foreign provider output and missing usage never become usable reply',async()=>{
 let requests=0;const model=createRelayTextModel({transport:async()=>{requests++;return{status:200,body:{model:RELAY_MODEL,stop_reason:'max_tokens',content:[{type:'text',text:'partial'}],usage:{input_tokens:25,output_tokens:400}}};}});
 const result=await model.generate(context);assert.equal(result.text,'');assert.equal(result.rawUsage.output_tokens,400);assert.equal(result.unusableReason,'incomplete_text_result');assert.equal(requests,1);
 const fresh=createRelayTextModel({transport:async()=>{requests++;}});await assert.rejects(fresh.generate({...context,facts:{huge:'a'.repeat(6100)}}),/too_large/);assert.equal(requests,1);
});
test('thin backend verifies operation-bound readback without any planner action',async()=>{
 const seen=[];const backend=createRelayBackend({callSid,suiteId,exchange:async op=>{seen.push(op);return{protocol:'wwccm.relay-control-result.1',action:op.action,operationId:op.operationId,callSid,suiteId,requestDigest:op.requestDigest,committed:true,result:{claimed:true,revision:0}};}});
 assert.equal((await backend.claimSession({callSid})).claimed,true);assert.equal(seen.length,1);assert.equal(seen[0].action,'claimSession');assert.equal(seen[0].requestDigest.length,64);
});
test('unknown readback blocks new generation but allows authoritative hold cleanup without retry',async()=>{
 const seen=[];const backend=createRelayBackend({callSid,suiteId,exchange:async op=>{seen.push(op);if(op.action==='prepareReply')throw Error('lost reply');return{protocol:'wwccm.relay-control-result.1',action:op.action,operationId:op.operationId,callSid,suiteId,requestDigest:op.requestDigest,committed:true,result:{held:true}};}});
 await assert.rejects(backend.prepareReply({callSid}),/lost reply/);await assert.rejects(backend.reserve({callSid}),/closed/);assert.equal((await backend.hold({reservationId:'r1'})).held,true);assert.deepEqual(seen.map(o=>o.action),['prepareReply','hold']);
});

test('a claimed reservation is dispatched at most once by the model adapter',async()=>{
 let calls=0;const model=createRelayTextModel({transport:async()=>{calls++;throw Error('unknown');}});
 await assert.rejects(model.generate(context),/unknown/);await assert.rejects(model.generate(context),/already_submitted/);assert.equal(calls,1);
});
