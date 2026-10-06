import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationRelay,callerFacts} from '../src/conversation-relay.mjs';
import {issueCallSession,twilioSignature} from '../src/security.mjs';
import {createRelayTextModel,RELAY_MODEL} from '../src/relay-text-model.mjs';
const callSid='CA'+'a'.repeat(32), accountSid='AC'+'b'.repeat(32), caller='+13102801111', authToken='local-fixture-only';
function fixture(overrides={}) {
 let clock=1000, revision=0, state={facts:{},history:[]}; const events=[],output=[];
 const signed={answeredAt:1000,deadline:121000,suiteId:'relay-fixture',caller,maximumTurns:6,maximumBrainRequests:12,maximumTtsCharacters:4000};
 const session=issueCallSession(callSid,authToken,signed),lease={...signed,callSid,session,maximumRequests:12,maximumCharacters:4000};
 const request={url:'/conversation-relay',headers:{host:'example.test','x-twilio-signature':twilioSignature('wss://example.test/conversation-relay',{},authToken)}};
 const backend={
  async claimSession(){events.push('session');return{claimed:true,revision:0,callSid,suiteId:signed.suiteId,state};},
  async claimTurn(input){events.push(['turn',input]);assert.equal(input.expectedRevision,revision);revision++;state.facts={...state.facts,...input.callerFacts};state.factEvidence={...state.factEvidence,...input.factEvidence};state.history.push({role:'user',text:input.text});return{revision,callSid,requestId:input.requestId,requestDigest:input.requestDigest,epoch:input.expectedEpoch,state:structuredClone(state)};},
  async reserve(input){events.push('reserve');return{id:'reservation-'+revision,callSid,requestId:input.requestId,revision,authorized:true,pricingSnapshot:{model:'mock',maximumInputTokens:8000,maximumOutputTokens:400}};},
  async settle(input){events.push(['settle',input]);return{state:'settled',reservationId:input.reservationId,requestId:input.requestId,providerRequests:1};},
  async hold(input){events.push(['hold',input]);},async release(){events.push('release');},
  async approveReply(input){events.push('approve');return{approved:!input.text.includes('guaranteed'),text:input.text,receiptIds:[]};},
  async prepareReply(input){events.push('commit');state.history.push({role:'assistant',text:input.text,delivery:input.delivery});return{revision:input.revision,requestId:input.requestId,epoch:input.expectedEpoch};},
  async markSubmitted(input){events.push('submitted');return{requestId:input.requestId,delivery:'submitted'};},
  async claimDispatch(input){events.push('dispatch');return{claimed:true,providerRequests:1,requestId:input.requestId,reservationId:input.reservationId};},
  async interrupt(input){events.push(['interrupt',input]);const last=state.history.at(-1);if(last?.role==='assistant'){last.text=input.spokenPrefix;last.delivery='interrupted';}return{epoch:input.epoch};}
 };
 const model={async generate(input){events.push(['model',input]);return{text:`Thanks ${input.facts.name??'there'}. Let's keep your repair goal in mind.`,rawUsage:{input_tokens:10,output_tokens:20}};}};
 Object.assign(backend,overrides.backend);Object.assign(model,overrides.model);
 const relay=createConversationRelay({request,authToken,accountSid,lease,backend,model,send:m=>output.push(m),now:()=>clock,schedule:()=>1,unschedule:()=>{}});
 const setup=()=>relay.receive({type:'setup',accountSid,callSid,from:caller,customParameters:{session}});
 return{relay,setup,events,output,lease,request,backend,model,advance:ms=>clock+=ms};
}
test('signed setup, plain text model, durable readback, approved text output retains caller facts',async()=>{
 const f=fixture();await f.setup();await f.relay.receive({type:'prompt',last:false,voicePrompt:"I'm Jordan"});assert.equal(f.events.length,1);
 await f.relay.receive({type:'prompt',last:true,voicePrompt:"I'm Jordan. I want to compare a HELOC with refinancing."});
 f.advance(1000);await f.relay.receive({type:'prompt',last:true,voicePrompt:'My mortgage rate is 6.25%. My monthly income is $12,000. I want $60,000 for repairs.'});
 f.advance(1000);await f.relay.receive({type:'prompt',last:true,voicePrompt:'My mortgage rate is now 5.9 percent. What do you remember?'});
 assert.equal(f.output.length,3);assert.equal(f.output[2].type,'text');assert.equal(f.output[2].last,true);
 const ctx=f.events.filter(e=>Array.isArray(e)&&e[0]==='model').at(-1)[1];
 assert.equal(ctx.facts.name,'Jordan');assert.equal(ctx.facts.mortgageRatePercent,5.9);assert.equal(ctx.facts.monthlyIncomeUsd,12000);assert.equal(ctx.facts.repairsUsd,60000);assert.equal(ctx.facts.goal,'compare a HELOC with refinancing');assert.equal(ctx.factEvidence.mortgageRatePercent.supersedesRevision,2);assert.equal(ctx.factEvidence.name.verification,'caller_asserted');assert.equal(ctx.history[0].text,"I'm Jordan. I want to compare a HELOC with refinancing.");
 assert.equal(f.events.filter(e=>e==='reserve').length,3);assert.equal(f.events.filter(e=>e==='commit').length,3);
});
test('wrong handshake, altered signed lease and wrong caller fail before model',async()=>{
 const f=fixture();assert.throws(()=>createConversationRelay({request:{...f.request,headers:{host:'example.test','x-twilio-signature':'bad'}},authToken,accountSid,lease:f.lease,backend:f.backend,model:f.model,send:()=>{}}),/not_authorized/);
 assert.throws(()=>createConversationRelay({request:f.request,authToken,accountSid,lease:{...f.lease,caller:'+14245550123'},backend:f.backend,model:f.model,send:()=>{},now:()=>1000}),/not_authorized/);
 await f.relay.receive({type:'setup',accountSid,callSid,from:'+14245550123',customParameters:{session:f.lease.session}});assert.equal(f.relay.snapshot().closed,true);assert.equal(f.events.length,0);
});
test('duplicate final never buys another request, including delayed redelivery',async()=>{
 const f=fixture();await f.setup();const p={type:'prompt',last:true,voicePrompt:'Hello'};await f.relay.receive(p);await f.relay.receive(p);assert.equal(f.relay.snapshot().requests,1);f.advance(1000);await f.relay.receive(p);assert.equal(f.relay.snapshot().requests,1);
});
test('financial reply requires authoritative approval before TTS',async()=>{
 const f=fixture({model:{async generate(){return{text:'Your approval is guaranteed.',rawUsage:{input_tokens:10,output_tokens:20}};}}});await f.setup();await f.relay.receive({type:'prompt',last:true,voicePrompt:'Am I approved?'});
 assert.equal(f.relay.snapshot().closed,true);assert.equal(f.output.some(m=>m.type==='text'),false);assert.equal(f.events.some(e=>Array.isArray(e)&&e[0]==='settle'),true);
});
test('unknown provider outcome holds reservation and permanently closes without retry',async()=>{
 const f=fixture({model:{async generate(){throw Error('network unknown');}}});await f.setup();await f.relay.receive({type:'prompt',last:true,voicePrompt:'Hi'});await f.relay.receive({type:'prompt',last:true,voicePrompt:'Again'});
 assert.equal(f.relay.snapshot().requests,1);assert.equal(f.events.filter(e=>Array.isArray(e)&&e[0]==='hold').length,1);assert.equal(f.events.some(e=>e==='release'),false);
});
test('interrupt fences late model output, settles returned usage, preserves caller state',async()=>{
 let complete;const f=fixture({model:{generate:()=>new Promise(resolve=>complete=resolve)}});await f.setup();const pending=f.relay.receive({type:'prompt',last:true,voicePrompt:"I'm Jordan. I want repairs."});
 while(!complete)await new Promise(resolve=>setImmediate(resolve));
 await f.relay.receive({type:'interrupt',utteranceUntilInterrupt:'',durationUntilInterruptMs:0});complete({text:'Late response',rawUsage:{input_tokens:10,output_tokens:20}});await pending;
 assert.equal(f.output.some(m=>m.type==='text'),false);assert.equal(f.events.filter(e=>Array.isArray(e)&&e[0]==='settle').length,1);assert.equal(f.relay.snapshot().state.facts.name,'Jordan');
});
test('playback interruption records prefix rather than claiming full reply was heard',async()=>{
 const f=fixture();await f.setup();await f.relay.receive({type:'prompt',last:true,voicePrompt:"I'm Jordan."});await f.relay.receive({type:'interrupt',utteranceUntilInterrupt:'Thanks Jordan.',durationUntilInterruptMs:460});
 const e=f.events.find(e=>Array.isArray(e)&&e[0]==='interrupt')[1];assert.equal(e.spokenPrefix,'Thanks Jordan.');assert.equal(e.delivery,'interrupted');
});
test('deadline and duplicate setup refuse without another generation',async()=>{
 const f=fixture();await f.setup();await f.setup();assert.equal(f.relay.snapshot().closed,true);assert.equal(f.relay.snapshot().requests,0);
 const g=fixture();await g.setup();g.advance(120001);await g.relay.receive({type:'prompt',last:true,voicePrompt:'Hi'});assert.equal(g.relay.snapshot().requests,0);assert.equal(g.output.at(-1).type,'end');
});
test('hypothetical and third-party statements never replace caller facts',()=>{
 assert.deepEqual(callerFacts('If my monthly income is $9,000, what happens?'),{});assert.deepEqual(callerFacts('My friend says my mortgage rate is 3 percent'),{});
 assert.deepEqual(callerFacts('My monthly income is $'+'9'.repeat(400)),{});assert.deepEqual(callerFacts("I'm Looking for a HELOC"),{});
 assert.deepEqual(callerFacts('I can put up to $700 a month toward repairs.'),{repairsPaymentLimitUsd:700});
});
test('actual plain-text adapter completes mocked Twilio-to-model-to-text flow and preserves truncated usage',async()=>{
 let providerCalls=0;
 const adapter=createRelayTextModel({transport:async({body})=>{
  providerCalls++;const c=JSON.parse(body.messages[0].content);
  return{status:200,body:{model:RELAY_MODEL,stop_reason:providerCalls===2?'max_tokens':'end_turn',
   content:[{type:'text',text:`Hello ${c.callerFacts.name}. Your goal is ${c.callerFacts.goal}.`}],usage:{input_tokens:25,output_tokens:20}}};
 }});
 const f=fixture({model:adapter,backend:{async reserve(input){return{id:'r'+providerCalls,callSid,requestId:input.requestId,revision:input.revision,authorized:true,pricingSnapshot:{model:RELAY_MODEL,maximumInputTokens:8000,maximumOutputTokens:400}};}}});
 await f.setup();await f.relay.receive({type:'prompt',last:true,voicePrompt:"I'm Jordan. I want home repairs."});
 assert.equal(f.output[0].token,'Hello Jordan. Your goal is home repairs.');
 f.advance(1000);await f.relay.receive({type:'prompt',last:true,voicePrompt:'What do you remember?'});
 assert.equal(providerCalls,2);assert.equal(f.events.filter(e=>Array.isArray(e)&&e[0]==='settle').length,2);
 assert.equal(f.events.some(e=>Array.isArray(e)&&e[0]==='hold'),false);assert.equal(f.relay.snapshot().closed,true);
 assert.equal(f.output.filter(m=>m.type==='text').length,1);
});

test('send failure leaves prepared state, never claims submitted playback',async()=>{
 const f=fixture();await f.setup();
 const relay=createConversationRelay({request:f.request,authToken,accountSid,lease:f.lease,backend:f.backend,model:f.model,send:msg=>{if(msg.type==='text')throw Error('socket closed');},now:()=>1000,schedule:()=>1,unschedule:()=>{}});
 await relay.receive({type:'setup',accountSid,callSid,from:caller,customParameters:{session:f.lease.session}});
 await relay.receive({type:'prompt',last:true,voicePrompt:'Hello'});
 assert.equal(relay.snapshot().closed,true);assert.equal(f.events.includes('submitted'),false);assert.equal(f.events.includes('commit'),true);
});
test('durable interrupt binds current request during a pending prepared commit and fences TTS',async()=>{
 let commit;const f=fixture({backend:{prepareReply:input=>new Promise(resolve=>commit=()=>resolve({revision:input.revision,requestId:input.requestId,epoch:input.expectedEpoch}))}});await f.setup();
 const turn=f.relay.receive({type:'prompt',last:true,voicePrompt:'Hello'});while(!commit)await new Promise(resolve=>setImmediate(resolve));
 await f.relay.receive({type:'interrupt',utteranceUntilInterrupt:'',durationUntilInterruptMs:0});const fence=f.events.find(e=>Array.isArray(e)&&e[0]==='interrupt')[1];
 assert.equal(fence.fenceRequestId,callSid+':relay:1');assert.equal(fence.playbackRequestId,null);assert.equal(fence.expectedEpoch,0);assert.equal(fence.epoch,1);commit();await turn;assert.equal(f.output.some(m=>m.type==='text'),false);
});
test('foreign reserve readback and interrupt failure close before another purchase',async()=>{
 const f=fixture({backend:{async reserve(){return{id:'foreign',authorized:true,callSid:'CA'+'c'.repeat(32),pricingSnapshot:{}};}}});await f.setup();await f.relay.receive({type:'prompt',last:true,voicePrompt:'Hi'});assert.equal(f.relay.snapshot().requests,0);
 const g=fixture({backend:{async interrupt(){throw Error('backend lost');}}});await g.setup();await g.relay.receive({type:'interrupt',utteranceUntilInterrupt:'',durationUntilInterruptMs:0});assert.equal(g.relay.snapshot().closed,true);
});

test('local text-adapter validation before transport releases without unknown hold',async()=>{
 let requests=0;const model=createRelayTextModel({transport:async()=>{requests++;throw Error('must not submit');}});
 const f=fixture({model,backend:{
  async claimTurn(input){return{callSid,requestId:input.requestId,requestDigest:input.requestDigest,epoch:input.expectedEpoch,revision:1,state:{facts:{memo:'x'.repeat(6100)},history:[]}};},
  async reserve(input){return{id:'local-only',callSid,requestId:input.requestId,revision:1,authorized:true,pricingSnapshot:{model:RELAY_MODEL,maximumInputTokens:8000,maximumOutputTokens:400}};}
 }});await f.setup();await f.relay.receive({type:'prompt',last:true,voicePrompt:'Hi'});
 assert.equal(requests,0);assert.equal(f.events.includes('release'),true);assert.equal(f.events.some(e=>Array.isArray(e)&&e[0]==='hold'),false);
});
