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
const proc = spawn(VELORA, ["serve","--host","127.0.0.1","--port",String(port),"--log-level","debug","--browser-profile","chrome-macos-catalina"],{cwd:REPO,stdio:["ignore","pipe","pipe"]});
const logChunks=[];
proc.stderr.on("data", d => logChunks.push(String(d)));
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
    console.error("EXC", JSON.stringify(m.params?.exceptionDetails,null,0).slice(0,600));
  }
  if(m.method==="Runtime.consoleAPICalled"){
    const args=m.params?.args?.map(a=>a.value??a.description??JSON.stringify(a)).join(" | ");
    console.error("CON", m.params?.type, String(args).slice(0,400));
  }
});
const call=(method,params={},sid=null,timeout=20000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Network.enable",{},sessionId);
// hook before navigate
await call("Page.addScriptToEvaluateOnNewDocument",{source:`
window.__wafLog=[];
const log=(...a)=>{try{window.__wafLog.push(a.map(String).join(' ').slice(0,300)); console.log('[waf]',...a)}catch(e){}};
const orig=Promise.prototype.then;
// don't wrap all promises - just track unhandled
window.addEventListener('unhandledrejection',e=>log('unhandled', e.reason&& (e.reason.stack||e.reason.message||e.reason)));
window.addEventListener('error',e=>log('error', e.message, e.filename, e.lineno));
`},sessionId);
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
await delay(4000);

// Inspect AwsWafIntegration APIs
let r = await call("Runtime.evaluate",{expression:`(() => {
  const A = window.AwsWafIntegration;
  if (!A) return {err:'no AwsWafIntegration'};
  const keys = Object.keys(A).concat(Object.getOwnPropertyNames(A));
  return {
    keys: [...new Set(keys)].slice(0,40),
    type: typeof A,
    log: window.__wafLog || [],
    cookie: document.cookie,
  };
})()`,returnByValue:true,awaitPromise:false},sessionId);
console.error("inspect1", JSON.stringify(r.result?.value, null, 2));

// Try getToken with timeout
r = await call("Runtime.evaluate",{
  expression: `(() => {
    const A = window.AwsWafIntegration;
    return Promise.race([
      A.getToken().then(t => ({ok:true, token: String(t).slice(0,80), cookie: document.cookie.slice(0,200)})),
      A.checkForceRefresh().then(f => ({force:f})).catch(e=>({forceErr:String(e)})),
      new Promise(res => setTimeout(() => res({timeout:true, cookie:document.cookie, log:window.__wafLog}), 8000)),
    ]);
  })()`,
  returnByValue: true,
  awaitPromise: true,
}, sessionId, 20000);
console.error("getToken race", JSON.stringify(r.result?.value ?? r, null, 2));

// fetch status of telemetry endpoints
r = await call("Runtime.evaluate",{expression:`JSON.stringify(window.__wafLog||[])`,returnByValue:true},sessionId);
console.error("wafLog", r.result?.value);

// dump interesting stderr
const full = logChunks.join("");
const lines = full.split("\n").filter(l => /script fetch|eval script|JsException|waf|challenge|error|fail|worker|crypto|webgl|canvas/i.test(l)).slice(-50);
console.error("--- stderr ---");
console.error(lines.join("\n"));
proc.kill("SIGKILL");
