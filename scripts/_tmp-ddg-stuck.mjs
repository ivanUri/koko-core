import { spawn } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";
const BIN="/Users/huydev/Desktop/velora/zig-out/bin/velora";
const getPort=()=>new Promise((res,rej)=>{const s=createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>res(p));});s.on("error",rej);});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const port=await getPort();
const proc=spawn(BIN,["serve","--host","127.0.0.1","--port",String(port),"--browser-profile","chrome-local-huys-macbook-pro","--log-level","debug"],{stdio:["ignore","ignore","pipe"],cwd:"/Users/huydev/Desktop/velora"});
let err=""; proc.stderr.on("data",d=>{err+=d;if(err.length>2e6)err=err.slice(-1e6);});
for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}await delay(100);}
const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws=new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej);});
let id=0; const pending=new Map();
ws.on("message",raw=>{const m=JSON.parse(String(raw));if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
const call=(method,params={},sessionId,timeoutMs=20000)=>{const i=++id;const payload={id:i,method,params};if(sessionId)payload.sessionId=sessionId;ws.send(JSON.stringify(payload));return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("t "+method)),timeoutMs);pending.set(i,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});});};
await call("Target.setDiscoverTargets",{discover:true}).catch(()=>{});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
const t0=Date.now();
await call("Page.navigate",{url:"https://duckduckgo.com/"},sessionId,15000);
for(let i=0;i<16;i++){
  await delay(500);
  const r=await call("Runtime.evaluate",{expression:`({
    rs: document.readyState,
    title: document.title,
    bl: (document.body&&document.body.innerText||'').length,
    scripts: [...document.scripts].map(s=>({src:(s.src||'').slice(-40),async:s.async,defer:s.defer,type:s.type})).slice(0,12),
    nScript: document.scripts.length,
  })`,returnByValue:true},sessionId,5000).catch(e=>({err:e.message}));
  console.log(i, Date.now()-t0, JSON.stringify(r.result?.value||r));
  const v=r.result?.value;
  if(v&&(v.rs==='interactive'||v.rs==='complete')) break;
}
console.log('---stderr key---');
console.log(err.split('\n').filter(l=>/duckduckgo|parse html|staticScripts|document is|DCL|domContent|defer document|script fetch|navigate|scheduler_suppressed|is_evaluating|pending|error|Fatal/i.test(l)).slice(0,80).join('\n'));
proc.kill('SIGKILL');ws.close();
