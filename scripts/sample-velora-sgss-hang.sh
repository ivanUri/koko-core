#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=$(node -e "const n=require('net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()});")
VELORA_PID=$(VELORA_ROOT="$PWD" zig-out/bin/velora serve --host 127.0.0.1 --port "$PORT" --browser-profile chrome-local-huys-macbook-pro --log-level warn & echo $!)
sleep 0.5
node -e "
const WebSocket=require('ws');
(async()=>{
  const ep='http://127.0.0.1:$PORT';
  for(let i=0;i<50;i++){try{if((await fetch(ep+'/json/version')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  const v=await (await fetch(ep+'/json/version')).json();
  const ws=new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
  let id=1,pending=new Map;
  ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.id&&pending.has(m.id)){pending.get(m.id).resolve(m.result);pending.delete(m.id);}});
  const send=(m,p={},s=null)=>new Promise(res=>{const i=id++;pending.set(i,{resolve:res});const pl={id:i,method:m,params:p};if(s)pl.sessionId=s;ws.send(JSON.stringify(pl));});
  let sid,seen=false;
  ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.method==='Network.requestWillBeSent'&&m.params?.request?.url?.includes('sg_ss='))seen=true;});
  await send('Target.setDiscoverTargets',{discover:true});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  ({sessionId:sid}=await send('Target.attachToTarget',{targetId,flatten:true}));
  await send('Page.enable',{},sid);await send('Network.enable',{},sid);
  await send('Page.navigate',{url:'https://www.google.com/search?q=coingloo.com&hl=vi'},sid);
  for(let i=0;i<40&&!seen;i++)await new Promise(r=>setTimeout(r,200));
  console.log('sg_ss_seen',seen);
  ws.close();
})().catch(e=>{console.error(e);process.exit(2);});
" 
sleep 1
echo "=== sample velora $VELORA_PID ==="
sample "$VELORA_PID" 1 -file /tmp/velora-sgss-sample.txt 2>/dev/null || true
rg -n "curl_multi|perform|ready_queue|HttpClient|libcurl|trackConn" /tmp/velora-sgss-sample.txt | head -30 || echo "no sample matches"
kill "$VELORA_PID" 2>/dev/null || true