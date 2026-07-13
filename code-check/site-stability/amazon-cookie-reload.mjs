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
const call=(method,params={},sid=null)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},20000)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
// navigate to example.com first for real origin
await call("Page.navigate",{url:"https://example.com"},sessionId);
await delay(1500);
let r = await call("Runtime.evaluate",{expression:`(() => {
  const out = [];
  try { document.cookie = 'aws-waf-token=testtoken123; path=/; max-age=3600'; out.push({set:true, cookie:document.cookie}); }
  catch(e){ out.push({set:false, err:String(e.message||e)}); }
  try { location.reload(true); out.push({reloadTrue:'called'}); }
  catch(e){ out.push({reloadTrue:false, err:String(e.message||e)}); }
  return out;
})()`,returnByValue:true},sessionId);
console.log("before reload", JSON.stringify(r.result?.value));
await delay(2000);
r = await call("Runtime.evaluate",{expression:`({url:location.href, title:document.title, cookie:document.cookie, html:document.documentElement.outerHTML.length})`,returnByValue:true},sessionId);
console.log("after", JSON.stringify(r.result?.value));
// now amazon specifically - set cookie manually then reload
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
await delay(3000);
r = await call("Runtime.evaluate",{expression:`(() => {
  const before = document.cookie;
  try {
    document.cookie = 'aws-waf-token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.test; path=/; Secure; SameSite=None';
  } catch(e) { return {err:String(e)}; }
  return {before, after: document.cookie, html: document.documentElement.outerHTML.length, hasAws: typeof AwsWafIntegration};
})()`,returnByValue:true},sessionId);
console.log("amazon cookie", JSON.stringify(r.result?.value));
// try force getToken and catch reload error
r = await call("Runtime.evaluate",{expression:`(async () => {
  try {
    const t = await AwsWafIntegration.getToken();
    let reloadErr = null;
    try { location.reload(true); } catch(e) { reloadErr = String(e.message||e); }
    return {token: String(t).slice(0,100), cookie: document.cookie, reloadErr};
  } catch(e) {
    return {getTokenErr: String(e.message||e), stack: String(e.stack||'').slice(0,500)};
  }
})()`,returnByValue:true, awaitPromise:true},sessionId);
console.log("getToken+reload", JSON.stringify(r.result?.value));
await delay(5000);
r = await call("Runtime.evaluate",{expression:`({url:location.href, title:document.title, cookie:document.cookie.slice(0,200), html:document.documentElement.outerHTML.length})`,returnByValue:true},sessionId);
console.log("final", JSON.stringify(r.result?.value));
proc.kill("SIGKILL");
