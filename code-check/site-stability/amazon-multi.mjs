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

async function one(i) {
  const port = await freePort();
  const proc = spawn(VELORA, ["serve","--host","127.0.0.1","--port",String(port),"--log-level","error","--browser-profile","chrome-macos-catalina"],{cwd:REPO,stdio:["ignore","pipe","pipe"]});
  const endpoint=`http://127.0.0.1:${port}`;
  for(let j=0;j<80;j++){try{if((await fetch(endpoint+"/json/version")).ok)break}catch{}await delay(50)}
  const {webSocketDebuggerUrl}=await(await fetch(endpoint+"/json/version")).json();
  const ws=new WebSocket(webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej)});
  let id=0; const pending=new Map();
  let docStatus=null;
  ws.on("message", raw=>{
    const m=JSON.parse(String(raw));
    if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}
    if(m.method==="Network.responseReceived" && m.params?.type==="Document"){
      docStatus = m.params.response.status;
    }
  });
  const call=(method,params={},sid=null)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},15000)});
  try {
    const {targetId}=await call("Target.createTarget",{url:"about:blank"});
    const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
    await call("Page.enable",{},sessionId);
    await call("Runtime.enable",{},sessionId);
    await call("Network.enable",{},sessionId);
    await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
    let last=null;
    for (let t=0;t<12;t++){
      await delay(1000);
      try {
        const r=await call("Runtime.evaluate",{expression:`({title:document.title,html:document.documentElement.outerHTML.length,links:document.querySelectorAll('a[href]').length,aws:typeof AwsWafIntegration,cookie:document.cookie.includes('aws-waf')})`,returnByValue:true},sessionId);
        last=r.result?.value;
        if ((last.html||0)>50000 && last.title) break;
      } catch(e) { last={err:e.message}; }
    }
    console.log(`run${i}`, JSON.stringify({docStatus, alive: proc.exitCode===null, ...last}));
  } finally {
    try{proc.kill("SIGKILL")}catch{}
  }
}
for (let i=1;i<=4;i++) await one(i);
