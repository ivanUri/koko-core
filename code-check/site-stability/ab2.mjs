import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve } from "node:path";
const REPO="/Users/huydev/Desktop/velora";
const VELORA=resolve(REPO,"zig-out/bin/velora");
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise((res,rej)=>{const s=createNetServer();s.on("error",rej);s.listen(0,"127.0.0.1",()=>{const {port}=s.address();s.close(()=>res(port));});});
const port=await freePort();
const proc=spawn(VELORA,["serve","--host","127.0.0.1","--port",String(port),"--log-level","error","--browser-profile","chrome-macos-catalina"],{cwd:REPO,stdio:["ignore","pipe","pipe"]});
const endpoint=`http://127.0.0.1:${port}`;
for(let i=0;i<100;i++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(50)}
const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
const ws=new WebSocket(webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
let id=0;const pending=new Map();
ws.on("message",raw=>{const m=JSON.parse(String(raw));if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result)}});
const call=(method,params={},sid=null,timeout=30000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId); await call("Runtime.enable",{},sessionId);
await call("Page.navigate",{url:"https://example.com"},sessionId);
await delay(1000);
// Don't awaitPromise on outer - use promise resolve in page via callback? just use awaitPromise
const expr=`(async () => {
  const r = await fetch('data:application/octet-stream;base64,AQIDBA==');
  const b = await r.arrayBuffer();
  return b.byteLength;
})()`;
try {
  const r=await call("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true},sessionId,15000);
  console.log("data url ab", r.result);
} catch(e){console.log("data url fail", e.message)}
const expr2=`(async () => {
  const r = await fetch('https://example.com/');
  const t = await r.text();
  return t.length;
})()`;
try {
  const r=await call("Runtime.evaluate",{expression:expr2,awaitPromise:true,returnByValue:true},sessionId,15000);
  console.log("text", r.result);
} catch(e){console.log("text fail", e.message)}
const expr3=`(async () => {
  const r = await fetch('https://example.com/');
  const b = await r.arrayBuffer();
  return b.byteLength;
})()`;
try {
  const r=await call("Runtime.evaluate",{expression:expr3,awaitPromise:true,returnByValue:true},sessionId,15000);
  console.log("http ab", r.result);
} catch(e){console.log("http ab fail", e.message)}
proc.kill("SIGKILL");
