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
const reqIds=[];
ws.on("message", raw=>{
  const m=JSON.parse(String(raw));
  if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result)}
  if(m.method==="Network.responseReceived"){
    const u=m.params?.response?.url||'';
    if(u.includes('inputs')||u.includes('report')||u.includes('verify')){
      reqIds.push({id:m.params.requestId, url:u, status:m.params.response.status});
    }
  }
});
const call=(method,params={},sid=null,timeout=20000)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},timeout)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Network.enable",{},sessionId);
await call("Page.addScriptToEvaluateOnNewDocument",{source:`
// Instrument Error.captureStackTrace and console
window.__errs=[];
const push=(e,tag)=>{
  try{
    window.__errs.push({tag, msg:String(e&&e.message||e), name:e&&e.name, stack:e&&e.stack?String(e.stack).slice(0,1200):null});
  }catch(_){}
};
const _reject = Promise.prototype.then;
// wrap queueMicrotask rejections via unhandled
window.addEventListener('unhandledrejection', e => push(e.reason, 'reject'));
window.addEventListener('error', e => push(e.error||e.message, 'error'));
// Patch Function to detect host call failures is hard; instead wrap common suspects after load
`},sessionId);
await call("Page.navigate",{url:"https://www.amazon.com"},sessionId);
await delay(4000);

// Get network bodies
for (const r of reqIds) {
  try {
    const body = await call("Network.getResponseBody",{requestId:r.id},sessionId);
    console.log("BODY", r.status, r.url.slice(0,100), (body.body||'').slice(0,500));
  } catch(e) { console.log("BODY fail", r.url, e.message); }
}

// On challenge page, test APIs that WAF likely uses
const r = await call("Runtime.evaluate",{expression:`(async () => {
  const out = [];
  const t = async (n, fn) => {
    try { const v = await fn(); out.push({n, ok:true, v: typeof v==='object'?(v&&v.byteLength)||(v&&v.length)||String(v).slice(0,40):v}); }
    catch(e) { out.push({n, ok:false, err:String(e&&e.message||e), name:e&&e.name}); }
  };
  // OfflineAudioContext fingerprint
  await t('oac', async () => {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator();
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0).slice(0,5);
  });
  await t('oac.getChannelData', async () => {
    const ctx = new OfflineAudioContext(1, 100, 44100);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0).length;
  });
  await t('canvas.webgl', () => {
    const c=document.createElement('canvas');
    const gl=c.getContext('webgl');
    const dbg=gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(dbg?dbg.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
  });
  await t('canvas.2d.getImageData', () => {
    const c=document.createElement('canvas'); c.width=16;c.height=16;
    const x=c.getContext('2d'); x.fillRect(0,0,16,16);
    return x.getImageData(0,0,16,16).data.length;
  });
  await t('wasm.instantiate empty', async () => {
    // minimal wasm module
    const bytes = new Uint8Array([0,97,115,109,1,0,0,0]);
    return WebAssembly.validate(bytes);
  });
  await t('importKey raw aes', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), {name:'AES-GCM'}, false, ['encrypt']);
    return key.type;
  });
  await t('encrypt aesgcm', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), {name:'AES-GCM'}, false, ['encrypt']);
    const iv = new Uint8Array(12);
    const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, new Uint8Array([1,2,3]));
    return ct.byteLength;
  });
  await t('hmac sign', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
    const s = await crypto.subtle.sign('HMAC', key, new Uint8Array([1]));
    return s.byteLength;
  });
  await t('AwsWaf.fetch', async () => {
    if (!window.AwsWafIntegration || !AwsWafIntegration.fetch) return 'no';
    return typeof AwsWafIntegration.fetch;
  });
  // Call getToken and capture
  await t('getToken', async () => {
    const t = await Promise.race([
      AwsWafIntegration.getToken(),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout8s')),8000))
    ]);
    return t;
  });
  return {out, errs: window.__errs||[], cookie:document.cookie};
})()`,returnByValue:true, awaitPromise:true}, sessionId, 25000);
console.log(JSON.stringify(r.result?.value, null, 2));
proc.kill("SIGKILL");
