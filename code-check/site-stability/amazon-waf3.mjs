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
ws.on("message", raw=>{
  const m=JSON.parse(String(raw));
  if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}
  if(m.method==="Runtime.exceptionThrown"){
    const e=m.params?.exceptionDetails;
    console.error("EXC", e?.text, e?.exception?.description?.slice(0,800), e?.url, e?.lineNumber);
  }
});
const call=(method,params={},sid=null,timeout=20000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Page.addScriptToEvaluateOnNewDocument",{source:`
window.__stacks=[];
window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  window.__stacks.push({
    type:'rejection',
    msg: String(r && (r.message||r)),
    stack: r && r.stack ? String(r.stack).slice(0,1500) : null,
  });
});
window.addEventListener('error', e => {
  window.__stacks.push({
    type:'error',
    msg: e.message,
    stack: e.error && e.error.stack ? String(e.error.stack).slice(0,1500) : null,
    file: e.filename, line: e.lineno,
  });
});
// Patch Error to capture first invalid argument
const OE = Error;
`},sessionId);
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
await delay(5000);
const r = await call("Runtime.evaluate",{expression:`JSON.stringify(window.__stacks||[],null,2)`,returnByValue:true},sessionId);
console.log(r.result?.value);
// check hasToken
const r2 = await call("Runtime.evaluate",{expression:`JSON.stringify({
  hasToken: typeof AwsWafIntegration!=='undefined' && AwsWafIntegration.hasToken && AwsWafIntegration.hasToken(),
  cookies: document.cookie,
  crypto: !!(window.crypto&&crypto.subtle),
  worker: typeof Worker,
  wasm: typeof WebAssembly,
  gl: (()=>{try{const c=document.createElement('canvas'); return !!(c.getContext('webgl')||c.getContext('experimental-webgl'))}catch(e){return String(e)}})(),
})`,returnByValue:true},sessionId);
console.log("caps", r2.result?.value);
proc.kill("SIGKILL");
