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
proc.on("exit",(c,s)=>console.error("exit",c,s));
const endpoint=`http://127.0.0.1:${port}`;
for(let i=0;i<100;i++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(100)}
const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
const ws=new WebSocket(webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
let id=0; const pending=new Map();
ws.on("message", raw=>{const m=JSON.parse(String(raw)); if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}});
const call=(method,params={},sid=null,timeout=8000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Page.navigate",{url:"https://example.com"},sessionId);
await delay(400);

const tests = [
  `({blob: new Blob(['hi'],{type:'text/plain'}).size})`,
  `({url: URL.createObjectURL(new Blob(['x']))})`,
  `({ss: (()=>{sessionStorage.setItem('a','b'); return sessionStorage.getItem('a')})()})`,
  `(async()=>{const r=await fetch('https://example.com'); const b=await r.arrayBuffer(); return {ab:b.byteLength}})()`,
  `(async()=>{const r=await fetch('https://example.com'); const b=await r.blob(); return {blob:b.size}})()`,
  `({dec: new TextDecoder().decode(new Uint8Array([65]))})`,
  `(async()=>{const d=await crypto.subtle.digest('SHA-1',new Uint8Array([1])); return {sha1:d.byteLength}})()`,
  `(async()=>{
    const blob=new Blob(['onmessage=e=>postMessage(e.data+1)'],{type:'application/javascript'});
    const u=URL.createObjectURL(blob);
    try {
      const w=new Worker(u);
      const v=await new Promise((res,rej)=>{
        w.onmessage=e=>res(e.data);
        w.onerror=e=>rej(new Error(e.message||'worker error'));
        setTimeout(()=>rej(new Error('timeout')),3000);
        w.postMessage(1);
      });
      w.terminate();
      return {worker:v};
    } finally { URL.revokeObjectURL(u); }
  })()`,
];
for (const expr of tests) {
  try {
    const r=await call("Runtime.evaluate",{expression:expr, awaitPromise:true, returnByValue:true},sessionId, 10000);
    console.log("OK", JSON.stringify(r.result?.value ?? r));
  } catch(e) {
    console.log("FAIL", e.message, "alive", proc.exitCode===null && !proc.signalCode);
  }
}
try{proc.kill("SIGKILL")}catch{}
