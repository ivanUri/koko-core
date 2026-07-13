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
const proc = spawn(VELORA, ["serve","--host","127.0.0.1","--port",String(port),"--log-level","info","--browser-profile","chrome-macos-catalina"],{cwd:REPO,stdio:["ignore","pipe","pipe"]});
const logs=[];
proc.stderr.on("data", d => logs.push(String(d)));
const endpoint=`http://127.0.0.1:${port}`;
for(let i=0;i<100;i++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(100)}
const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
const ws=new WebSocket(webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
let id=0; const pending=new Map();
const net=[];
ws.on("message", raw=>{
  const m=JSON.parse(String(raw));
  if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}
  if(m.method==="Network.requestWillBeSent"){
    const r=m.params?.request;
    if(r) net.push({phase:"req", url:r.url.slice(0,140), method:r.method, post:r.postData?.slice(0,100)});
  }
  if(m.method==="Network.responseReceived"){
    const r=m.params?.response;
    if(r) net.push({phase:"res", url:r.url.slice(0,140), status:r.status});
  }
  if(m.method==="Network.loadingFailed"){
    net.push({phase:"fail", url:m.params?.requestId, err:m.params?.errorText});
  }
});
const call=(method,params={},sid=null,timeout=20000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Network.enable",{},sessionId);
await call("Page.addScriptToEvaluateOnNewDocument",{source:`
window.__log=[];
const L=(...a)=>window.__log.push(a.map(x=>{try{return typeof x==='string'?x:JSON.stringify(x)}catch{return String(x)}}).join(' ').slice(0,200));
// cookie
const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
if (desc && desc.set) {
  const os=desc.set, og=desc.get;
  Object.defineProperty(document, 'cookie', {
    configurable:true,
    get(){return og.call(this)},
    set(v){ L('cookie.set', v.slice(0,120)); return os.call(this,v); }
  });
}
// reload
const or = location.reload.bind(location);
location.reload = function(...a){ L('reload', a); return or(...a); };
// assign
const oa = Object.getOwnPropertyDescriptor(Location.prototype,'href');
// worker
const OW=Worker;
window.Worker=function(u,...r){ L('Worker', String(u).slice(0,150)); const w=new OW(u,...r); w.addEventListener('error',e=>L('worker.err', e.message)); w.addEventListener('message',e=>L('worker.msg', String(e.data).slice(0,80))); return w; };
window.Worker.prototype=OW.prototype;
window.addEventListener('unhandledrejection',e=>L('reject', e.reason&&(e.reason.stack||e.reason.message||e.reason)));
window.addEventListener('error',e=>L('error', e.message, e.filename, e.lineno));
`},sessionId);
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
await delay(8000);
const r=await call("Runtime.evaluate",{expression:`JSON.stringify({
  log: window.__log||[],
  cookie: document.cookie,
  title: document.title,
  html: document.documentElement.outerHTML.length,
  hasAws: typeof AwsWafIntegration,
  hasToken: typeof AwsWafIntegration!=='undefined' && AwsWafIntegration.hasToken(),
})`,returnByValue:true},sessionId);
console.log("STATE", r.result?.value);
console.log("NET", JSON.stringify(net,null,2));
// stderr filter
const s=logs.join('');
console.log("STDERR", s.split('\n').filter(l=>/not_implemented|JsException|invalid|cookie|Worker|waf|script fetch error|Maximum/i.test(l)).slice(-40).join('\n'));
proc.kill("SIGKILL");
