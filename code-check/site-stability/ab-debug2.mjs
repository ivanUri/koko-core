import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve } from "node:path";
const REPO = resolve(".");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createNetServer(); s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const {port}=s.address(); s.close(()=>res(port)); });
});
const port = await freePort();
const proc = spawn(VELORA, ["serve","--host","127.0.0.1","--port",String(port),"--log-level","warn","--browser-profile","chrome-macos-catalina"],{cwd:REPO,stdio:["ignore","pipe","pipe"]});
const endpoint=`http://127.0.0.1:${port}`;
for(let i=0;i<100;i++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(50)}
const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
const ws=new WebSocket(webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
let id=0; const pending=new Map();
ws.on("message", raw=>{const m=JSON.parse(String(raw)); if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}});
const call=(method,params={},sid=null,timeout=12000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId); await call("Runtime.enable",{},sessionId);
await call("Page.navigate",{url:"https://example.com"},sessionId);
await delay(800);

// Inspect shape of reader.read() result and body_used
const r=await call("Runtime.evaluate",{expression:`(async()=>{
  const r=await fetch(location.href);
  const body=r.body;
  const reader=body.getReader();
  const first=await reader.read();
  const keys=first && Object.keys(first);
  const vtype=first && first.value && first.value.constructor && first.value.constructor.name;
  const second=await reader.read();
  // also try text after body locked?
  let textErr=null;
  try { await r.text(); } catch(e){ textErr=String(e.message||e); }
  return {
    firstDone: first.done,
    firstKeys: keys,
    vtype,
    vlen: first.value && (first.value.byteLength||first.value.length),
    secondDone: second.done,
    secondValue: second.value,
    bodyUsed: r.bodyUsed,
    textErr,
  };
})()`,awaitPromise:true,returnByValue:true},sessionId,15000);
console.log("read shape", JSON.stringify(r.result?.value));

// Pure then-chain equivalent of StreamConsumer
const r2=await call("Runtime.evaluate",{expression:`(async()=>{
  const r=await fetch(location.href);
  // polyfill stream consumer like Response.arrayBuffer does via Zig
  const reader=r.body.getReader();
  const chunks=[];
  let total=0;
  while(true){
    const x=await reader.read();
    if(x.done) break;
    chunks.push(x.value);
    total += x.value.byteLength;
  }
  return {total, n: chunks.length};
})()`,awaitPromise:true,returnByValue:true},sessionId,10000);
console.log("manual", JSON.stringify(r2.result?.value));

// text with race
const r3=await call("Runtime.evaluate",{expression:`(async()=>{
  const r=await fetch(location.href);
  return Promise.race([
    r.text().then(t=>({ok:true,len:t.length}),e=>({ok:false,err:String(e)})),
    new Promise(res=>setTimeout(()=>res({ok:false,err:'timeout'}),4000)),
  ]);
})()`,awaitPromise:true,returnByValue:true},sessionId,10000);
console.log("text race", JSON.stringify(r3.result?.value));

proc.kill("SIGKILL");
