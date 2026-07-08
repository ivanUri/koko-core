//! Google Accounts sign-in **debug instrumentation** and boq eval shims.
//!
//! Production paths must not mutate page behavior unless the matching env flag is set.
//! Probe scripts mirror these hooks in `scripts/lib/google-signin-boq-closure-hook.mjs`.

const std = @import("std");

const Allocator = std.mem.Allocator;

pub const closure_bus_log_env = "VELORA_SIGNIN_CLOSURE_BUS_LOG";
pub const rib_log_env = "VELORA_SIGNIN_RIB_LOG";
pub const bio_shim_env = "VELORA_SIGNIN_BIO_SHIM";
pub const httprm_trace_env = "VELORA_SIGNIN_HTTPPRM_TRACE";

fn envEnabled(name: []const u8) bool {
    const value = std.posix.getenv(name) orelse return false;
    return value.len > 0 and !std.mem.eql(u8, value, "0") and !std.mem.eql(u8, value, "false");
}

pub fn closureBusLogEnabled() bool {
    return envEnabled(closure_bus_log_env);
}

pub fn ribLogEnabled() bool {
    return envEnabled(rib_log_env);
}

/// Experimental bio/debounce shim — default **off**; enable only for sign-in probes.
pub fn bioShimEnabled() bool {
    return envEnabled(bio_shim_env);
}

pub fn httprmTraceEnabled() bool {
    return envEnabled(httprm_trace_env);
}

pub fn mi613eTraceEnabled() bool {
    return httprmTraceEnabled();
}

pub fn isAccountsGoogleUrl(url: []const u8) bool {
    return std.mem.indexOf(u8, url, "accounts.google.") != null;
}

pub fn isBoqScript(url: []const u8) bool {
    return std.mem.indexOf(u8, url, "boq-identity") != null or
        std.mem.indexOf(u8, url, "/boq-") != null;
}

/// Evaluated at document navigation when `VELORA_SIGNIN_CLOSURE_BUS_LOG=1`.
pub const closure_bus_script =
    \\(function(){try{if(globalThis.__veloraClosureBusHooked)return;globalThis.__veloraClosureBusHooked=1;var log=globalThis.__veloraClosureBusLog||[];globalThis.__veloraClosureBusLog=log;var store=function(){try{sessionStorage.setItem("__veloraClosureBusLog",JSON.stringify(log.slice(-250)));localStorage.setItem("__veloraClosureBusLog",JSON.stringify(log.slice(-250)));}catch(e){}};var push=function(k,x){var r={t:performance.now(),kind:k};if(x)for(var p in x)if(Object.prototype.hasOwnProperty.call(x,p))r[p]=x[p];log.push(r);store();};var findUGa=function(){try{if(typeof _!=="undefined"&&_.UGa&&"aa" in _.UGa)return _.UGa;}catch(e){}var seen=typeof WeakSet==="function"?new WeakSet():null;var walk=function(o,d){if(!o||d>7||typeof o!=="object")return null;if(seen){if(seen.has(o))return null;seen.add(o);}if(typeof o.QY==="function"&&typeof o.RY==="function"&&"aa" in o&&"da" in o)return o;var ks=Object.keys(o),lim=ks.length>50?50:ks.length;for(var i=0;i<lim;i++){try{var hit=walk(o[ks[i]],d+1);if(hit)return hit;}catch(e){}}return null;};return walk(globalThis,0);};var snap=function(tag){var u=findUGa();if(!u)return;try{push("uga.snap",{tag:tag,aa:u.aa,da:u.da,qy:u.QY(),ry:u.RY()});}catch(e){}};var trapUGa=function(){var u=findUGa();if(!u||u.__veloraTrap)return false;try{var aau=u.aa,dav=u.da;Object.defineProperty(u,"aa",{get:function(){return aau;},set:function(v){push("uga.aa",{from:aau,to:v});aau=v;try{push("uga.aa.after",{to:v,qy:u.QY()});}catch(e){}},configurable:1,enumerable:1});Object.defineProperty(u,"da",{get:function(){return dav;},set:function(v){push("uga.da",{from:dav,to:v});dav=v;try{push("uga.da.after",{to:v,ry:u.RY()});}catch(e){}},configurable:1,enumerable:1});u.__veloraTrap=1;push("uga.trap",{aa:aau,da:dav});return true;}catch(e){return false;}};var hookedProtos=new WeakSet();var hookProto=function(proto,label){if(!proto||hookedProtos.has(proto)||typeof proto.dispatchEvent!=="function")return false;var origDE=proto.dispatchEvent;proto.dispatchEvent=function(evt){var type=String((evt&&evt.type)||(evt&&evt.datatype)||"");if(type==="j"||type.indexOf("httprm")>=0||type.indexOf("data:")===0){var detail=(evt&&evt.detail!=null)?evt.detail:(evt&&evt.aa!=null)?evt.aa:null;var httprmRtt=null;try{if(Array.isArray(detail)&&detail[0]==="af.httprm")httprmRtt=detail[3];}catch(e){}push("bus.dispatch",{type:type.slice(0,56),label:label,httprmRtt:httprmRtt});snap("after:"+type.slice(0,24));}return origDE.call(this,evt);};if(typeof proto.listen==="function"){var origListen=proto.listen;proto.listen=function(type,fn){var ts=String(type||"");if(ts==="j"||ts.indexOf("httprm")>=0||ts.indexOf("data:")===0)push("bus.listen",{type:ts.slice(0,56),label:label});return origListen.apply(this,arguments);};}hookedProtos.add(proto);push("bus.hooked",{label:label});return true;};var scanBus=function(){var seen=new Set();var visit=function(o,label,d){if(!o||d>5||typeof o!=="object")return;if(seen.has(o))return;seen.add(o);if(typeof o==="function"&&o.prototype){try{if(Object.getOwnPropertyNames(o.prototype).some(function(k){return k.indexOf("closure_listenable_")===0;}))hookProto(o.prototype,label||o.name||"?");}catch(e){}}try{var ks=Object.keys(o).slice(0,60);for(var i=0;i<ks.length;i++)visit(o[ks[i]],(label?label+".":"")+ks[i],d+1);}catch(e){}};visit(globalThis,"window",0);if(globalThis.default_AccountsSignInUi)visit(globalThis.default_AccountsSignInUi,"default_AccountsSignInUi",0);};var hookWm=function(){try{if(typeof _!=="undefined"&&_.Wm&&!_.Wm.__veloraWrap){var o=_.Wm;_.Wm=function(t,ty,fn,cap,self){var s=String(ty||"");if(s==="j"||s==="data:af.httprm"||s.indexOf("httprm")>=0)push("wm.listen",{type:s});return o.apply(this,arguments);};_.Wm.__veloraWrap=1;push("wm.hooked",{});}}catch(e){}};var chainWrap=function(obj,key,wrapper){var cur=obj[key];if(cur&&cur.__veloraBusWrap)return cur;var wrapped=wrapper(cur);wrapped.__veloraBusWrap=1;obj[key]=wrapped;return wrapped;};chainWrap(JSON,"parse",function(orig){return function(text){var out=orig.apply(this,arguments);try{var walk=function(o,d){if(!o||d>10)return;if(Array.isArray(o)){if(o[0]==="af.httprm"){push("json.httprm",{rtt:o[3]});snap("after:json.httprm");}for(var i=0;i<o.length;i++)walk(o[i],d+1);}else if(typeof o==="object"){var ks=Object.keys(o),lim=ks.length>30?30:ks.length;for(var j=0;j<lim;j++)walk(o[ks[j]],d+1);}};walk(out,0);}catch(e){}return out;};});var tick=function(){try{hookWm();scanBus();trapUGa();}catch(e){}};var poll=function(){tick();globalThis.setTimeout(poll,25);};globalThis.setTimeout(poll,0);push("hook.init",{href:location.href});}catch(e){}})();
    \\
;

/// Experimental — patches setTimeout / XHR for bio debounce experiments (`VELORA_SIGNIN_BIO_SHIM=1`).
pub const bio_shim_script =
    \\(function(){try{var g=globalThis.__veloraBioGate||(globalThis.__veloraBioGate={uekDone:false,bioSent:false,nextClicked:false});var st=globalThis.setTimeout;var pc=function(){try{var h=document.head||document.documentElement;if(!h||h.__veloraYtPc)return;h.__veloraYtPc=1;var urls=['https://www.youtube.com','https://youtube.com'];for(var i=0;i<urls.length;i++){var l=document.createElement('link');l.rel='preconnect';l.href=urls[i];l.crossOrigin='anonymous';h.appendChild(l);}}catch(e){}};if(document.head)pc();else document.addEventListener('DOMContentLoaded',pc);var findUGa=function(){if(g.ugaRef)return g.ugaRef;try{if(typeof _!=='undefined'&&_.UGa&&'aa' in _.UGa)return _.UGa;}catch(e){}var seen=typeof WeakSet==='function'?new WeakSet():null;var walk=function(o,d){if(!o||d>6||typeof o!=='object')return null;if(seen){if(seen.has(o))return null;seen.add(o);}if(typeof o.QY==='function'&&typeof o.RY==='function'&&'aa' in o&&'da' in o)return o;var ks=Object.keys(o),lim=ks.length>40?40:ks.length;for(var i=0;i<lim;i++){try{var hit=walk(o[ks[i]],d+1);if(hit)return hit;}catch(e){}}return null;};return walk(globalThis,0);};var captureUGaRef=function(){var u=findUGa();if(u)g.ugaRef=u;return u;};var onNextClick=function(){g.nextClicked=true;};document.addEventListener('click',function(e){try{var el=e.target;if(!el||!el.closest)return;var hit=el.closest('#identifierNext,[jsname="LgbsSe"],button[type="button"]');if(hit&&(hit.id==='identifierNext'||hit.getAttribute('jsname')==='LgbsSe'))onNextClick();}catch(err){}},true);if(!globalThis.__veloraBioXhr){globalThis.__veloraBioXhr=1;var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){var s=String(u||"");this.__veloraUek=/batchexecute/i.test(s)&&/UEkKwb/i.test(s);this.__veloraBio=/browserinfo/i.test(s);this.__veloraMi=/batchexecute/i.test(s)&&/MI613e/i.test(s);return xo.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){var s=this;if(s.__veloraBio){g.bioSent=true;captureUGaRef();}if(s.__veloraUek)s.addEventListener("readystatechange",function(){if(s.readyState===4)st(function(){g.uekDone=true;},100);});return xs.apply(this,arguments);};globalThis.setTimeout=function(fn,delay){var ms=Number(delay),rest=Array.prototype.slice.call(arguments,2);if(ms>=2990&&ms<=3010&&!g.uekDone){var t0=globalThis.performance?globalThis.performance.now():0;var poll=function(){if(g.uekDone||(globalThis.performance&&globalThis.performance.now()-t0>1e4))return st.apply(globalThis,[fn,ms].concat(rest));st(poll,25);};return st(poll,25);}return st.apply(globalThis,arguments);};}}catch(e){}})();
    \\
;

/// Inside boq IIFE — `_.Wm` / `_.UGa` live in closure; global prepend cannot see `_`.
pub const closure_hook_inline =
    \\try{if(!globalThis.__veloraBoqClosureInline){globalThis.__veloraBoqClosureInline=1;var log=globalThis.__veloraClosureBusLog||[];globalThis.__veloraClosureBusLog=log;var store=function(){try{localStorage.setItem("__veloraClosureBusLog",JSON.stringify(log.slice(-250)));sessionStorage.setItem("__veloraClosureBusLog",JSON.stringify(log.slice(-250)));}catch(e){}};var push=function(k,x){var r={t:performance.now(),kind:k};if(x)for(var p in x)if(Object.prototype.hasOwnProperty.call(x,p))r[p]=x[p];log.push(r);store();};var hookWm=function(){try{if(typeof _.Wm==="function"&&!_.Wm.__veloraWrap){var o=_.Wm;_.Wm=function(t,ty,fn,cap,self){var s=String(ty||"");if(s==="j"||s==="data:af.httprm"||s.indexOf("httprm")>=0)push("wm.listen",{type:s});return o.apply(this,arguments);};_.Wm.__veloraWrap=1;push("wm.hooked",{});return 1;}}catch(e){}return 0};var trapUGa=function(){try{if(_.UGa&&"aa" in _.UGa&&!_.UGa.__veloraTrap){var u=_.UGa,aau=u.aa,dav=u.da;Object.defineProperty(u,"aa",{get:function(){return aau;},set:function(v){push("uga.aa",{from:aau,to:v});aau=v;},configurable:1,enumerable:1});Object.defineProperty(u,"da",{get:function(){return dav;},set:function(v){push("uga.da",{from:dav,to:v});dav=v;},configurable:1,enumerable:1});u.__veloraTrap=1;push("uga.trap",{aa:aau,da:dav});return 1;}}catch(e){}return 0};var hookedProtos=new WeakSet();var hookProto=function(proto,label){if(!proto||hookedProtos.has(proto)||typeof proto.dispatchEvent!=="function")return 0;var origDE=proto.dispatchEvent;proto.dispatchEvent=function(evt){var type=String((evt&&evt.type)||(evt&&evt.datatype)||"");if(type==="j"||type.indexOf("httprm")>=0||type.indexOf("data:")===0){var detail=(evt&&evt.detail!=null)?evt.detail:(evt&&evt.aa!=null)?evt.aa:null;var httprmRtt=null;try{if(Array.isArray(detail)&&detail[0]==="af.httprm")httprmRtt=detail[3];}catch(e){}push("bus.dispatch",{type:type.slice(0,56),label:label,httprmRtt:httprmRtt});}return origDE.call(this,evt);};hookedProtos.add(proto);push("bus.hooked",{label:label});return 1};var scanBus=function(){var n=0;var seen=new Set();var visit=function(o,d){if(!o||d>5||typeof o!=="object")return;if(seen.has(o))return;seen.add(o);if(typeof o==="function"&&o.prototype){try{if(Object.getOwnPropertyNames(o.prototype).some(function(k){return k.indexOf("closure_listenable_")===0;}))n+=hookProto(o.prototype,o.name||"?");}catch(e){}}try{var ks=Object.keys(o).slice(0,60);for(var i=0;i<ks.length;i++)visit(o[ks[i]],d+1);}catch(e){}};visit(_,"_",0);if(n)push("bus.scan",{count:n});};var hookBfDispatch=function(){try{var Bf=_.Bf;if(!Bf||!Bf.prototype||Bf.prototype.__veloraBfDE)return 0;var orig=Bf.prototype.dispatchEvent;Bf.prototype.dispatchEvent=function(evt){var type=String((evt&&evt.type)||"");if(type==="j"||type.indexOf("httprm")>=0||type.indexOf("data:")===0)push("bf.dispatch",{type:type.slice(0,56)});return orig.apply(this,arguments)};Bf.prototype.__veloraBfDE=1;push("bf.hooked",{});return 1}catch(e){}return 0};var hookDataLayer=function(){var n=0;try{if(typeof _.sEa==="function"&&!_.sEa.__veloraW){var os=_.sEa;_.sEa=function(a,b){try{var et=String(b&&b.eventType||"");if(et.indexOf("httprm")>=0||et.indexOf("af.")>=0||et.indexOf("data")===0)push("sEa",{eventType:et.slice(0,48)});}catch(e){}return os.apply(this,arguments)};_.sEa.__veloraW=1;n++}if(typeof _.uEa==="function"&&!_.uEa.__veloraW){var ou=_.uEa;_.uEa=function(a){push("uEa.flush",{});return ou.apply(this,arguments)};_.uEa.__veloraW=1;n++}if(typeof _.$Ga==="function"&&!_.$Ga.__veloraW){var op=_.$Ga;_.$Ga=function(a,b){var o=op.apply(this,arguments);try{var rt=a&&a.Ue&&a.Ue.responseText?String(a.Ue.responseText):"";if(rt.indexOf("af.httprm")>=0)push("parse.$Ga",{len:rt.length});}catch(e){}return o};_.$Ga.__veloraW=1;n++}}catch(e){}if(n)push("dataLayer.hooked",{n:n});return n};var tick=function(){hookWm();trapUGa();hookBfDispatch();hookDataLayer();scanBus();};push("boq.closure.inject",{});tick();var cn=0;var poll=function(){tick();if(++cn>200)return;globalThis.setTimeout(poll,25);};globalThis.setTimeout(poll,0);}}catch(e){}
    \\
;

/// Inside boq `(function(_){...})` — hook `_.Nt` to wrap `rib.sya` / `rib.jya`.
pub const rib_hook_inline =
    \\try{if(!globalThis.__veloraRibHook){globalThis.__veloraRibHook=1;var L=globalThis.__veloraRibLog||[];globalThis.__veloraRibLog=L;var St=function(){try{localStorage.setItem("__veloraRibLog",JSON.stringify(L.slice(-250)))}catch(e){}};var P=function(k,x){var r={t:performance.now(),kind:k};if(x)for(var p in x)if(Object.prototype.hasOwnProperty.call(x,p))r[p]=x[p];L.push(r);St()};var W=function(C){if(!C||!C.prototype||C.__veloraRibW)return;var ps=C.prototype.sya,pj=C.prototype.jya;if(typeof ps!=="function"||typeof pj!=="function")return;C.prototype.sya=function(a){var b=this.aa;P("rib.sya",{aaBefore:b});var o=ps.apply(this,arguments);try{P("rib.sya.after",{aa:this.aa,qy:this.QY()})}catch(e){P("rib.sya.after",{aa:this.aa})}return o};C.prototype.sya.__veloraSyaWrap=1;C.prototype.jya=function(a){var b=this.da;P("rib.jya",{daBefore:b});var o=pj.apply(this,arguments);try{P("rib.jya.after",{da:this.da,ry:this.RY()})}catch(e){P("rib.jya.after",{da:this.da})}return o};C.__veloraRibW=1;P("rib.proto",{})};var hookNt=function(){try{var oN=_.Nt;if(typeof oN==="function"&&!oN.__veloraW){var orig=oN;_.Nt=function(i,C){W(C);return orig.apply(this,arguments)};_.Nt.__veloraW=1;P("nt.hook",{});return 1;}}catch(e){}return 0};P("rib.inject",{});if(!hookNt()){var n=0;var poll=function(){if(hookNt()||++n>500)return;globalThis.setTimeout(poll,0)};globalThis.setTimeout(poll,0);}}}catch(e){}
    \\
;

/// Boq sync-fetches dependency chunks during `_.l("_tp")` while `Db.da` is still `_tp`.
pub const boq_module_shim =
    \\(function(){try{var o=globalThis.default_AccountsSignInUi;if(!o||!o.Db)return;var d=o.Db.da;if(d&&d.getId&&d.getId()==="_tp")o.Db.da=null;}catch(e){}})();
    \\
;

/// Identity protobuf `_.Zc` rejects non-integers; round at the API boundary.
pub const boq_zc_shim =
    \\(function(){try{var o=globalThis.default_AccountsSignInUi;if(!o||!o.Zc||o.Zc.__veloraZc)return;var z=o.Zc;o.Zc=function(a){if(typeof a==="number"&&!Number.isInteger(a))a=a|0;return z.call(this,a);};o.Zc.__veloraZc=1;}catch(e){}})();
    \\
;

pub fn injectBoqIifeHooks(arena: Allocator, src: []const u8) ![]const u8 {
    if (!ribLogEnabled() and !closureBusLogEnabled()) return src;
    const anchor = "(function(_){var window=this;";
    const pos = std.mem.indexOf(u8, src, anchor) orelse return src;
    const insert_at = pos + anchor.len;
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, src[0..insert_at]);
    if (closureBusLogEnabled()) try out.appendSlice(arena, closure_hook_inline);
    if (ribLogEnabled()) try out.appendSlice(arena, rib_hook_inline);
    try out.appendSlice(arena, src[insert_at..]);
    return out.items;
}

/// Prepended before boq classic script eval while a sync parent is still running.
pub fn prependBoqEvalShim(arena: Allocator, src: []const u8) ![]const u8 {
    const with_hooks = try injectBoqIifeHooks(arena, src);
    var out: std.ArrayList(u8) = .empty;
    if (closureBusLogEnabled()) {
        try out.appendSlice(arena, closure_bus_script);
    }
    try out.appendSlice(arena, boq_module_shim);
    try out.appendSlice(arena, with_hooks);
    return out.items;
}
