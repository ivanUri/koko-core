import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";
const REPO = "/Users/huydev/Desktop/velora";
const VELORA = resolve(REPO, "zig-out/bin/velora");
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const {port}=s.address(); s.close(()=>res(port)); }); });
const port = await freePort();
const logPath = "/tmp/nyt-raw-stderr.log";
writeFileSync(logPath, "");
const proc = spawn(VELORA, ["serve","--host","127.0.0.1","--port",String(port),"--log-level","error","--browser-profile","chrome-macos-catalina"],{cwd:REPO,stdio:["ignore","pipe","pipe"], env:{...process.env, ZIG_DEBUG_STACK_TRACE: "1"}});
proc.stderr.on("data", d => appendFileSync(logPath, d));
proc.stdout.on("data", d => appendFileSync(logPath, d));
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
await call("Page.navigate",{url:"https://www.nytimes.com"},sessionId);
await delay(8000);
console.log("exit", proc.exitCode, proc.signalCode);
// wait a bit more for crash dump flush
await delay(500);
const fs=await import("fs");
const data=fs.readFileSync(logPath);
console.log("log bytes", data.length);
// print from first Allocation
const s=data.toString("utf8");
const i=s.indexOf("Allocation size");
console.log(s.slice(Math.max(0,i-200), i+15000));
proc.kill("SIGKILL");
