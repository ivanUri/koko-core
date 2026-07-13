import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";
const REPO = "/Users/huydev/Desktop/velora";
const VELORA = resolve(REPO, "zig-out/bin/velora");
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createNetServer(); s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const {port}=s.address(); s.close(()=>res(port)); });
});
const port = await freePort();
const logPath = "/tmp/nyt-full.log";
writeFileSync(logPath, "");
const proc = spawn(VELORA, ["serve","--host","127.0.0.1","--port",String(port),"--log-level","warn","--browser-profile","chrome-macos-catalina"],{
  cwd:REPO,stdio:["ignore","pipe","pipe"]
});
proc.stderr.on("data", d => appendFileSync(logPath, d));
proc.stdout.on("data", d => appendFileSync(logPath, d));
const endpoint=`http://127.0.0.1:${port}`;
for(let i=0;i<100;i++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(100)}
const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
const ws=new WebSocket(webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
let id=0; const pending=new Map();
ws.on("message", raw=>{const m=JSON.parse(String(raw)); if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}});
const call=(method,params={},sid=null)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},25000)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Page.navigate",{url:"https://www.nytimes.com"},sessionId);
for (let i=0;i<40;i++){ await delay(250); if(proc.exitCode!==null||proc.signalCode) break; }
console.log("exit", proc.exitCode, proc.signalCode);
proc.kill("SIGKILL");
const fs=await import("fs");
const s=fs.readFileSync(logPath,"utf8");
// print last 120 lines and any stack-like content
const lines=s.split("\n");
console.log("--- last 80 lines ---");
console.log(lines.slice(-80).join("\n"));
console.log("--- stack-ish ---");
for (const l of lines) {
  if (/errorCallback|ScriptManager|Invalid free|Segmentation|thread|panic|Allocation|HttpClient|CacheLayer|Interception|requestFailed|zig-out|src\//.test(l)) console.log(l);
}
