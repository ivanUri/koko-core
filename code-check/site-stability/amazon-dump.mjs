import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
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
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
await delay(3000);
const r=await call("Runtime.evaluate",{expression:`document.documentElement.outerHTML`,returnByValue:true},sessionId);
const html=r.result?.value||"";
writeFileSync("/tmp/amazon-page.html", html);
console.log("len", html.length);
console.log(html);
// also check cookies / console
const r2=await call("Runtime.evaluate",{expression:`JSON.stringify({
  scripts:[...document.scripts].map(s=>({src:s.src,len:(s.textContent||'').length, head:(s.textContent||'').slice(0,200)})),
  cookies:document.cookie,
  errors: window.__e || null
})`,returnByValue:true},sessionId);
console.log("meta", r2.result?.value);
proc.kill("SIGKILL");
