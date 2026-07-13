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
const call=(method,params={},sid=null)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},25000)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Runtime.enable",{},sessionId);
await call("Page.enable",{},sessionId);
await call("Page.navigate",{url:"about:blank"},sessionId);
await delay(200);

const tests = `
(async () => {
  const out = [];
  const t = async (name, fn) => {
    try { out.push({name, ok:true, v: await fn()}); }
    catch(e) { out.push({name, ok:false, err: String(e&&e.message||e), stack: String(e&&e.stack||'').slice(0,300)}); }
  };
  await t('subtle.digest', async () => {
    const d = await crypto.subtle.digest('SHA-256', new Uint8Array([1,2,3]));
    return d.byteLength;
  });
  await t('subtle.generateKey.aes', async () => {
    const k = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
    return k.type;
  });
  await t('subtle.encrypt.aesgcm', async () => {
    const k = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const c = await crypto.subtle.encrypt({name:'AES-GCM', iv}, k, new Uint8Array([1,2,3,4]));
    return c.byteLength;
  });
  await t('subtle.generateKey.ecdsa', async () => {
    const k = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
    return k.publicKey.type;
  });
  await t('subtle.sign.ecdsa', async () => {
    const k = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
    const s = await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, k.privateKey, new Uint8Array([1,2,3]));
    return s.byteLength;
  });
  await t('localStorage', () => { localStorage.setItem('a','b'); return localStorage.getItem('a'); });
  await t('worker', async () => {
    const w = new Worker('data:text/javascript,postMessage(1)');
    return await new Promise((res,rej) => { w.onmessage=e=>res(e.data); w.onerror=e=>rej(e.message); setTimeout(()=>rej('timeout'),2000); });
  });
  await t('audio', async () => {
    const ac = new OfflineAudioContext(1, 44100, 44100);
    return ac.length;
  });
  await t('canvas', () => {
    const c = document.createElement('canvas'); c.width=16; c.height=16;
    const ctx = c.getContext('2d');
    ctx.fillRect(0,0,16,16);
    return c.toDataURL().slice(0,40);
  });
  return out;
})()
`;
const r = await call("Runtime.evaluate",{expression:tests, awaitPromise:true, returnByValue:true}, sessionId);
console.log(JSON.stringify(r.result?.value ?? r, null, 2));
proc.kill("SIGKILL");
