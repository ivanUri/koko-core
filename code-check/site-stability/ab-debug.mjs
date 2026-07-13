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
const logs=[];
proc.stderr.on("data", d => logs.push(String(d)));
const endpoint=`http://127.0.0.1:${port}`;
for(let i=0;i<100;i++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(50)}
const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
const ws=new WebSocket(webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
let id=0; const pending=new Map();
ws.on("message", raw=>{const m=JSON.parse(String(raw)); if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}});
const call=(method,params={},sid=null,timeout=12000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId); await call("Runtime.enable",{},sessionId);
await call("Page.navigate",{url:"https://example.com"},sessionId);
await delay(800);

const tests = [
  // 1. Response from constructor with body string
  `(async()=>{ const r=new Response("hello"); const b=await r.arrayBuffer(); return {fromCtor:b.byteLength}; })()`,
  // 2. text() on fetch
  `(async()=>{ const r=await fetch(location.href); const t=await r.text(); return {textLen:t.length}; })()`,
  // 3. arrayBuffer on same-page fetch with race timeout
  `(async()=>{
    const r=await fetch(location.href);
    const p=r.arrayBuffer().then(b=>({ok:true,len:b.byteLength}),e=>({ok:false,err:String(e)}));
    const t=new Promise(res=>setTimeout(()=>res({ok:false,err:'timeout3s'}),3000));
    return Promise.race([p,t]);
  })()`,
  // 4. manual stream read
  `(async()=>{
    const r=await fetch(location.href);
    const reader=r.body.getReader();
    let n=0, chunks=0;
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      chunks++; n += value ? value.byteLength||value.length||0 : 0;
      if(chunks>100) return {err:'too many chunks',n,chunks};
    }
    return {streamRead:n,chunks};
  })()`,
];
for (const [i,expr] of tests.entries()) {
  try {
    const r=await call("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true},sessionId,15000);
    console.log(i, JSON.stringify(r.result?.value ?? r));
  } catch(e) {
    console.log(i, "FAIL", e.message);
  }
}
console.log("LOG", logs.join("").split("\n").filter(l=>/stream|arrayBuffer|body|error|warn/i.test(l)).slice(-30).join("\n"));
proc.kill("SIGKILL");
