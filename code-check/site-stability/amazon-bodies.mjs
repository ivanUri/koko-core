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
const reqIdToUrl = new Map();
const bodies = [];
ws.on("message", raw=>{
  const m=JSON.parse(String(raw));
  if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}
  if(m.method==="Network.requestWillBeSent"){
    reqIdToUrl.set(m.params.requestId, m.params.request.url);
    if (m.params.request.url.includes('report') || m.params.request.url.includes('inputs') || m.params.request.url.includes('verify')) {
      bodies.push({type:'req', url:m.params.request.url.slice(0,120), method:m.params.request.method, post:m.params.request.postData?.slice(0,2000)});
    }
  }
  if(m.method==="Network.loadingFinished"){
    // get body later
  }
});
const call=(method,params={},sid=null,timeout=20000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Network.enable",{},sessionId);
// Hook fetch to capture request/response of waf
await call("Page.addScriptToEvaluateOnNewDocument",{source:`
window.__fetchLog=[];
const of = window.fetch;
window.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url);
  let body = init && init.body;
  if (body && typeof body !== 'string') { try { body = await new Response(body).text(); } catch(e) { body = String(body); } }
  try {
    const res = await of.apply(this, arguments);
    const clone = res.clone();
    let text = '';
    try { text = await clone.text(); } catch(e) {}
    window.__fetchLog.push({url:String(url).slice(0,150), status:res.status, reqBody: String(body||'').slice(0,1500), resBody: text.slice(0,2000)});
    return res;
  } catch (e) {
    window.__fetchLog.push({url:String(url).slice(0,150), err:String(e)});
    throw e;
  }
};
// Also wrap Error to get better stacks for invalid argument
const OE = Error;
const TE = TypeError;
window.TypeError = function(...a) {
  const e = new TE(...a);
  if (String(a[0]).includes('invalid') || String(a[0]).includes('argument')) {
    try { window.__fetchLog.push({typeerror: String(a[0]), stack: e.stack.slice(0,800)}); } catch(_){}
  }
  return e;
};
window.TypeError.prototype = TE.prototype;
`},sessionId);
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
await delay(6000);
const r=await call("Runtime.evaluate",{expression:`JSON.stringify(window.__fetchLog||[],null,2)`,returnByValue:true},sessionId);
console.log(r.result?.value);
console.log("BODIES", JSON.stringify(bodies,null,2));
proc.kill("SIGKILL");
