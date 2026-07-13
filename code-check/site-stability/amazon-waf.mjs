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
const errs = [];
const proc = spawn(VELORA, ["serve","--host","127.0.0.1","--port",String(port),"--log-level","warn","--browser-profile","chrome-macos-catalina"],{cwd:REPO,stdio:["ignore","pipe","pipe"]});
proc.stderr.on("data", d => {
  const s = String(d);
  if (/error|warn|script|http|exception|waf|challenge|fail/i.test(s)) errs.push(s.slice(0,300));
});
const endpoint=`http://127.0.0.1:${port}`;
for(let i=0;i<100;i++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(100)}
const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
const ws=new WebSocket(webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
let id=0; const pending=new Map();
const net = [];
ws.on("message", raw=>{
  const m=JSON.parse(String(raw));
  if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}
  if(m.method==="Network.responseReceived"){
    const r=m.params?.response;
    if(r) net.push({url:r.url.slice(0,140), status:r.status, mime:r.mimeType, type:m.params.type});
  }
  if(m.method==="Runtime.exceptionThrown"){
    console.error("EXCEPTION", JSON.stringify(m.params?.exceptionDetails).slice(0,400));
  }
  if(m.method==="Runtime.consoleAPICalled"){
    const args=m.params?.args?.map(a=>a.value??a.description??a.type).join(" ");
    console.error("CONSOLE", m.params?.type, args?.slice(0,300));
  }
});
const call=(method,params={},sid=null,timeout=15000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Network.enable",{},sessionId);
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);

for (let i=0;i<15;i++){
  await delay(1000);
  const r=await call("Runtime.evaluate",{expression:`(()=>({
    title:document.title,
    html:document.documentElement.outerHTML.length,
    url:location.href,
    links:document.querySelectorAll('a[href]').length,
    hasAws: typeof AwsWafIntegration,
    cookies: document.cookie.slice(0,200),
    challengeScripts: [...document.scripts].filter(s=>s.src.includes('awswaf')||s.src.includes('challenge')).map(s=>s.src),
  }))()`,returnByValue:true},sessionId);
  const v=r.result?.value;
  console.error(`[${i}s]`, JSON.stringify(v));
  if((v.html||0)>50000 && v.title) break;
}
console.error("--- net ---");
for (const n of net) console.error(JSON.stringify(n));
console.error("--- log sample ---");
console.error(errs.slice(-20).join("\n"));
proc.kill("SIGKILL");
