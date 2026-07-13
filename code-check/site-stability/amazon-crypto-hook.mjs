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
const call=(method,params={},sid=null,timeout=25000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Page.addScriptToEvaluateOnNewDocument",{source:`
window.__cryptoLog = [];
(function(){
  const s = crypto.subtle;
  const wrap = (name) => {
    const orig = s[name].bind(s);
    s[name] = function(...args) {
      const algo = args[0];
      const algoStr = typeof algo === 'string' ? algo : (algo && (algo.name || JSON.stringify(algo).slice(0,80)));
      const p = orig(...args);
      return Promise.resolve(p).then(v => {
        window.__cryptoLog.push({op:name, algo:algoStr, ok:true, type: v && v.constructor && v.constructor.name});
        return v;
      }, e => {
        window.__cryptoLog.push({op:name, algo:algoStr, ok:false, err:String(e&&e.message||e)});
        throw e;
      });
    };
  };
  for (const n of ['encrypt','decrypt','sign','verify','digest','generateKey','importKey','exportKey','deriveBits','deriveKey','wrapKey','unwrapKey']) {
    if (typeof s[n]==='function') wrap(n);
  }
  const OW = Worker;
  window.Worker = function(...a) {
    window.__cryptoLog.push({op:'Worker', algo:String(a[0]).slice(0,120), ok:true});
    return new OW(...a);
  };
  window.Worker.prototype = OW.prototype;
})();
`},sessionId);
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
await delay(6000);
const r = await call("Runtime.evaluate",{expression:`JSON.stringify({
  log: window.__cryptoLog || [],
  cookie: document.cookie,
  hasToken: typeof AwsWafIntegration!=='undefined' && AwsWafIntegration.hasToken(),
  html: document.documentElement.outerHTML.length,
  title: document.title,
})`,returnByValue:true},sessionId);
console.log(JSON.stringify(JSON.parse(r.result?.value||'{}'), null, 2));
proc.kill("SIGKILL");
