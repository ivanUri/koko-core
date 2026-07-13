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
const call=(method,params={},sid=null)=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});const p={id:mid,method,params};if(sid)p.sessionId=sid;ws.send(JSON.stringify(p));setTimeout(()=>{if(pending.has(mid)){pending.delete(mid);rej(new Error("to "+method))}},15000)});
const {targetId}=await call("Target.createTarget",{url:"about:blank"});
const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
await call("Page.enable",{},sessionId);
await call("Runtime.enable",{},sessionId);
await call("Page.navigate",{url:"about:blank"},sessionId);
await delay(300);
const tests = `
(() => {
  const out=[];
  const t=(n,fn)=>{try{out.push({n, ok:true, v:fn()})}catch(e){out.push({n, ok:false, err:String(e.message||e)})}};
  t('reload()', () => { location.reload(); return 'ok'; });
  t('reload(true)', () => { location.reload(true); return 'ok'; });
  t('reload(false)', () => { location.reload(false); return 'ok'; });
  t('cookie set', () => { document.cookie = 'aws-waf-token=abc; path=/'; return document.cookie; });
  t('history.replaceState', () => { history.replaceState(null,'',location.href); return 'ok'; });
  t('performance.now', () => performance.now());
  t('performance.getEntries', () => performance.getEntries().length);
  t('navigator.webdriver', () => navigator.webdriver);
  t('navigator.plugins', () => navigator.plugins.length);
  t('navigator.languages', () => [...navigator.languages]);
  t('Intl.DateTimeFormat', () => new Intl.DateTimeFormat().resolvedOptions().timeZone);
  t('TextEncoder', () => new TextEncoder().encode('hi').length);
  t('btoa', () => btoa('hi'));
  t('Proxy', () => { const p=new Proxy({},{get:(t,k)=>k}); return p.foo; });
  t('createElement script', () => { const s=document.createElement('script'); s.src='data:text/javascript,1'; return s.src; });
  t('URL', () => new URL('https://a.com/x?y=1').searchParams.get('y'));
  t('crypto.getRandomValues', () => { const a=new Uint8Array(16); crypto.getRandomValues(a); return a.length; });
  t('structuredClone', () => structuredClone({a:1}).a);
  t('queueMicrotask', () => { queueMicrotask(()=>{}); return 'ok'; });
  return out;
})()
`;
// Note: reload may navigate away - skip reload tests that navigate
const tests2 = tests.replace(/t\('reload[\s\S]*?t\('cookie/,'t(\'cookie');
const r = await call("Runtime.evaluate",{expression:tests2, returnByValue:true},sessionId);
console.log(JSON.stringify(r.result?.value,null,2));
// specifically test reload without navigating away - use iframe
const r2 = await call("Runtime.evaluate",{expression:`
(() => {
  try {
    // Location.reload arity
    return { reloadLen: location.reload.length, type: typeof location.reload };
  } catch(e) { return {err:String(e)}; }
})()
`,returnByValue:true},sessionId);
console.log("reload meta", r2.result?.value);
proc.kill("SIGKILL");
