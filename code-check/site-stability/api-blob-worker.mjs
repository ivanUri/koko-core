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
for(let i=0;i<100;i++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(100)}
const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
const ws=new WebSocket(webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
let id=0; const pending=new Map();
ws.on("message", raw=>{const m=JSON.parse(String(raw)); if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}});
const call=(method,params={},sid=null)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},15000)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Page.navigate",{url:"https://example.com"},sessionId);
await delay(500);
const expr=`(async()=>{
  const out=[];
  const t=async(n,fn)=>{try{out.push({n,ok:true,v:await fn()})}catch(e){out.push({n,ok:false,err:String(e&&e.message||e)})}};
  await t('Blob',()=>new Blob(['postMessage(42)'],{type:'text/javascript'}).size);
  await t('URL.createObjectURL',()=>{const u=URL.createObjectURL(new Blob(['x'])); URL.revokeObjectURL(u); return typeof u});
  await t('Worker blob', async()=>{
    const blob=new Blob(['onmessage=e=>postMessage(e.data*2)'],{type:'text/javascript'});
    const u=URL.createObjectURL(blob);
    const w=new Worker(u);
    const v=await new Promise((res,rej)=>{w.onmessage=e=>res(e.data); w.onerror=e=>rej(e.message||'err'); w.postMessage(21); setTimeout(()=>rej('timeout'),2000)});
    URL.revokeObjectURL(u); w.terminate(); return v;
  });
  await t('sessionStorage',()=>{sessionStorage.setItem('k','v'); return sessionStorage.getItem('k')});
  await t('fetch arraybuffer', async()=>{
    const r=await fetch('https://example.com');
    const b=await r.arrayBuffer();
    return b.byteLength;
  });
  await t('Response blob', async()=>{
    const r=await fetch('https://example.com');
    const b=await r.blob();
    return b.size;
  });
  await t('TextDecoder',()=>new TextDecoder().decode(new Uint8Array([65,66])));
  await t('atob',()=>atob('YWI='));
  await t('crypto.subtle.digest SHA-1', async()=>{
    const d=await crypto.subtle.digest('SHA-1', new Uint8Array([1]));
    return d.byteLength;
  });
  return out;
})()`;
const r=await call("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true},sessionId);
console.log(JSON.stringify(r.result?.value,null,2));
proc.kill("SIGKILL");
