import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import RFB from '@novnc/novnc';
import {ArrowClockwise,ArrowsIn,ArrowsOut,CaretDown,Check,ClipboardText,Microphone,Monitor,Plug,PlugsConnected} from '@phosphor-icons/react';
import './relay.css';
import {setLanguage} from './i18n.js';

const bridge=window.chrome?.webview;
const send=(action,data={})=>bridge?.postMessage({action,...data});

// Windows microphone for the Pi: 48 kHz mono s16le in 20 ms chunks, captured here (WASAPI shared
// mode underneath) and fed by the host to the Pi's receiver over the existing SSH connection.
const MIC_DEVICE_KEY='pi-relay-mic-device';
// Level meter in decibels like common audio tools: -60 dBFS (empty) to 0 dBFS (full).
const meterScale=peak=>Math.max(0,Math.min(1,(20*Math.log10(Math.max(peak,1e-6))+60)/60));
const bytesToBase64=buffer=>{const bytes=new Uint8Array(buffer);let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));return btoa(text);};
const TOOL_ORDER_KEY='pi-relay-toolbar-order';
const DEFAULT_TOOLS=['mic','quality','connection','share','paste','scale'];
function savedTools(){try{const v=JSON.parse(localStorage.getItem(TOOL_ORDER_KEY)||'null');if(Array.isArray(v)&&v.length===DEFAULT_TOOLS.length&&DEFAULT_TOOLS.every(t=>v.includes(t)))return v;}catch{}return DEFAULT_TOOLS;}
// Like a phone home screen: holding a tool for 3 s makes all tools wiggle; dragging one onto another
// swaps them; Esc or a click beside the tools ends it. Clicks do nothing while arranging.
function useToolOrder(){
 const [order,setOrder]=useState(savedTools),[editing,setEditing]=useState(false),[drag,setDrag]=useState(null),[over,setOver]=useState(null);
 const hold=useRef(),start=useRef([0,0]),editingRef=useRef(false);editingRef.current=editing;
 function swap(a,b){setOrder(o=>{const n=[...o],i=n.indexOf(a),j=n.indexOf(b);if(i<0||j<0||i===j)return o;[n[i],n[j]]=[n[j],n[i]];try{localStorage.setItem(TOOL_ORDER_KEY,JSON.stringify(n));}catch{}return n;});}
 function slotAt(x,y,except){return document.elementsFromPoint(x,y).map(e=>e.closest?.('.tool-slot')).find(e=>e&&e.dataset.tool!==except)?.dataset.tool||null;}
 function bind(id){return {
  'data-tool':id,
  onPointerDown:e=>{
   if(editingRef.current){e.preventDefault();e.currentTarget.setPointerCapture?.(e.pointerId);setDrag(id);return;}
   clearTimeout(hold.current);start.current=[e.clientX,e.clientY];hold.current=setTimeout(()=>setEditing(true),3000);},
  // Moving (e.g. dragging the quality slider) is not a long press.
  onPointerMove:e=>{if(editingRef.current){if(drag===id)setOver(slotAt(e.clientX,e.clientY,id));return;}if(Math.hypot(e.clientX-start.current[0],e.clientY-start.current[1])>6)clearTimeout(hold.current);},
  onPointerUp:e=>{clearTimeout(hold.current);if(editingRef.current&&drag===id){const target=slotAt(e.clientX,e.clientY,id);if(target)swap(id,target);setDrag(null);setOver(null);}},
  onPointerLeave:()=>clearTimeout(hold.current),onPointerCancel:()=>{clearTimeout(hold.current);setDrag(null);setOver(null);},
  onClickCapture:e=>{if(editingRef.current){e.preventDefault();e.stopPropagation();}},
  className:'tool-slot'+(drag===id?' dragging':'')+(over===id?' drop-target':'')};}
 useEffect(()=>{if(!editing)return;
  const key=e=>{if(e.key==='Escape'){e.preventDefault();setEditing(false);}};
  const outside=e=>{if(!e.target.closest?.('.tool-slot'))setEditing(false);};
  window.addEventListener('keydown',key,true);window.addEventListener('pointerdown',outside,true);
  return()=>{window.removeEventListener('keydown',key,true);window.removeEventListener('pointerdown',outside,true);};},[editing]);
 useEffect(()=>()=>clearTimeout(hold.current),[]);
 return {order,editing,bind,setEditing};
}

function useMic(flash){
 const [on,setOn]=useState(false),[state,setState]=useState('off'),[level,setLevel]=useState(0),[devices,setDevices]=useState([]);
 const [device,setDevice]=useState(()=>{try{return localStorage.getItem(MIC_DEVICE_KEY)||'';}catch{return '';}});
 const wanted=useRef(false),capture=useRef(null),generation=useRef(0),deviceRef=useRef(device);deviceRef.current=device;
 async function list(){try{const all=await navigator.mediaDevices.enumerateDevices();const mics=all.filter(d=>d.kind==='audioinput'&&d.deviceId&&d.deviceId!=='default'&&d.deviceId!=='communications');setDevices(mics);return mics;}catch{return [];}}
 function remember(id){setDevice(id);try{localStorage.setItem(MIC_DEVICE_KEY,id);}catch{}}
 function stopCapture(){generation.current++;const c=capture.current;capture.current=null;setLevel(0);if(!c)return;c.node.port.onmessage=null;c.stream.getTracks().forEach(t=>t.stop());c.ctx.close().catch(()=>{});}
 // Returns false when a stop (or a newer start) arrived while the device was still opening.
 async function startCapture(id){
  stopCapture();
  const mine=generation.current;
  const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:id?{exact:id}:undefined,channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  if(generation.current!==mine){stream.getTracks().forEach(t=>t.stop());return false;}
  const ctx=new AudioContext({sampleRate:48000});
  await ctx.audioWorklet.addModule('mic-worklet.js');
  if(generation.current!==mine){stream.getTracks().forEach(t=>t.stop());ctx.close().catch(()=>{});return false;}
  const node=new AudioWorkletNode(ctx,'pi-relay-mic',{numberOfInputs:1,numberOfOutputs:0,channelCount:1,channelCountMode:'explicit',channelInterpretation:'speakers'});
  let frames=0;
  node.port.onmessage=e=>{send('micChunk',{data:bytesToBase64(e.data.pcm)});if(++frames%3===0)setLevel(e.data.level);};
  ctx.createMediaStreamSource(stream).connect(node);
  capture.current={stream,ctx,node};
  const track=stream.getAudioTracks()[0];
  track.onended=()=>{if(capture.current?.stream===stream)disable('Das Mikrofon wurde getrennt.');};
  list();
  return true;
 }
 function enable(){wanted.current=true;setOn(true);setState('starting');send('micStart');}
 function disable(notice){wanted.current=false;setOn(false);setState('off');stopCapture();send('micStop');if(notice)flash(notice);}
 async function choose(id){remember(id);if(capture.current){try{await startCapture(id);}catch(e){disable('Mikrofon lässt sich nicht öffnen: '+(e.message||e.name));}}}
 // Host replies: on = receiver ready (start capturing), lost = SSH gone (switch stays on), error = off.
 async function onState(m){
  if(m.state==='on'){if(!wanted.current){send('micStop');return;}
   try{if(await startCapture(deviceRef.current))setState('on');}
   catch(e){disable(e.name==='OverconstrainedError'||e.name==='NotFoundError'?'Das gemerkte Mikrofon ist nicht angeschlossen. Mikro ausgeschaltet.':e.name==='NotAllowedError'?'Windows erlaubt Pi Relay das Mikrofon nicht (Einstellungen › Datenschutz › Mikrofon).':'Mikrofon lässt sich nicht öffnen: '+(e.message||e.name));}}
  else if(m.state==='lost'){stopCapture();if(wanted.current)setState('waiting');if(m.message)flash(m.message);}
  else if(m.state==='error'){disable(m.message);}
 }
 // After the viewer (re)connects, a switched-on microphone starts again by itself.
 function resume(){if(wanted.current&&!capture.current){setState('starting');send('micStart');}}
 function pause(){if(wanted.current){stopCapture();setState('waiting');send('micStop',{quiet:true});}}
 useEffect(()=>{const changed=()=>list();navigator.mediaDevices?.addEventListener?.('devicechange',changed);list();return()=>{navigator.mediaDevices?.removeEventListener?.('devicechange',changed);stopCapture();};},[]);
 return {on,state,level,devices,device,list,enable,disable,choose,onState,resume,pause};
}

export function toBase64(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));return btoa(text);}
export function fromBase64(data){const text=atob(data),bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);return bytes;}

// noVNC accepts any WebSocket-like channel. This one carries the RFB bytes through the
// native host into the alias's existing SSH transport; no local port or WebSocket exists.
export class RelayChannel {
 constructor(){this.binaryType='arraybuffer';this.protocol='';this.readyState='connecting';this.onopen=null;this.onmessage=null;this.onerror=null;this.onclose=null;this.early=[];}
 send(data){if(this.readyState!=='open')return;const bytes=data instanceof Uint8Array?data:new Uint8Array(data);for(let i=0;i<bytes.length;i+=32768)send('screenSend',{data:toBase64(bytes.subarray(i,i+32768))});}
 close(){if(this.readyState==='closed')return;this.readyState='closed';send('screenDisconnect');setTimeout(()=>this.onclose?.({code:1000,reason:'',wasClean:true}),0);}
 opened(){if(this.readyState!=='connecting')return;this.readyState='open';this.onopen?.({});for(const bytes of this.early.splice(0))this.receive(bytes);}
 // Screen bytes (shared memory) and the "opened" message travel separately; early bytes wait for it.
 receive(bytes){if(this.readyState==='open')this.onmessage?.({data:bytes.buffer});else if(this.readyState==='connecting')this.early.push(bytes);}
 ended(){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.({code:1006,reason:'',wasClean:false});}
}

const labels={waiting:'Bereit',connecting:'Verbinden …',credentials:'Anmeldung nötig',connected:'Verbunden',disconnected:'Getrennt',error:'Fehler',unavailable:'Nur in der App'};
const latin1=text=>[...text].every(c=>c.charCodeAt(0)<=255);
// noVNC quality 0-9 (JPEG/Tight); remembered per viewer window, never required for the page to work.
// 7 is the measured optimum (Pi 5, TigerVNC: about 45 frames/s); 9 sends several times the data.
const QUALITY_KEY='piRelay.screenQuality',QUALITY_OPTIMUM=7;
// Waits before each automatic reopen; a connection that holds for 10 s starts the count again.
const RETRY_DELAYS=[1000,2000,5000,10000,10000];
// FPS colour: yellow up to 20, green from 30, blended in between; grey while the Pi sends nothing.
// FPS shown: while the picture moves (≥10 painted frames per second) the live value. When the Pi goes
// quiet, the mean of the last 30 active seconds stays up with a calm swing of about ±3 instead of a drop.
const FPS_WINDOW=30,FPS_ACTIVE=10;
export function shownFps(samples,n,tick){
 if(n>=FPS_ACTIVE){samples.push(n);if(samples.length>FPS_WINDOW)samples.shift();return n;}
 if(!samples.length)return n;
 const mean=samples.reduce((a,b)=>a+b,0)/samples.length,swing=1.7*Math.sin(tick*.9)+1.1*Math.sin(tick*2.3+1);
 return Math.max(1,Math.round(mean+swing));
}
const fpsColor=fps=>{if(!fps)return '#9a8f9c';const t=Math.max(0,Math.min(1,(fps-20)/10)),mix=(a,b)=>Math.round(a+(b-a)*t);return 'rgb('+mix(245,78)+','+mix(200,224)+','+mix(75,138)+')';};
const UPLOAD_CHUNK=768*1024,UPLOAD_LIMIT=512*1024*1024;
function storedQuality(){try{const v=Number(localStorage.getItem(QUALITY_KEY));return Number.isInteger(v)&&v>=0&&v<=9&&localStorage.getItem(QUALITY_KEY)!==null?v:QUALITY_OPTIMUM;}catch{return QUALITY_OPTIMUM;}}

export function ScreenView(){
 const alias=new URLSearchParams(location.search).get('screen')||'MeinPi';
 const host=useRef(null),rfb=useRef(null),channel=useRef(null),credentials=useRef(null),lastClipboard=useRef(''),share=useRef(true),noticeTimer=useRef(0);
 const [status,setStatus]=useState(bridge?'waiting':'unavailable');
 const [waitSeconds,setWaitSeconds]=useState(0);
 const tools=useToolOrder(),[micMenu,setMicMenu]=useState(false);
 const mic=useMic(text=>flashRef.current?.(text)),micRef=useRef(mic);micRef.current=mic;const flashRef=useRef();flashRef.current=flash;
 const [message,setMessage]=useState(bridge?'':'Der integrierte Viewer arbeitet in der Pi-Relay-App über deine bestehende SSH-Verbindung.');
 const [needs,setNeeds]=useState([]),[form,setForm]=useState({username:'',password:''});
 const [scale,setScale]=useState('fit'),[fullscreen,setFullscreen]=useState(false),[toolbar,setToolbar]=useState(true);
 const [shareClipboard,setShareClipboard]=useState(true),[clipboardSeen,setClipboardSeen]=useState(false),[notice,setNotice]=useState(''),[meta,setMeta]=useState({version:'',desktop:'',os:'',host:'',server:''});
 const [quality,setQuality]=useState(storedQuality);
 const [dragging,setDragging]=useState(false),[transfer,setTransfer]=useState(null);
 const uploads=useRef(new Map()),transferring=useRef(false);
 const retry=useRef({attempt:0,timer:0,steady:0}),[retrying,setRetrying]=useState(0);
 // While the Pi desktop stands still TigerVNC sends next to nothing; the display then keeps the last
 // rate measured during real activity (10+ updates/s) and goes live again as soon as things move.
 const [showFps,setShowFps]=useState(false),[fps,setFps]=useState(null),frames=useRef(0),fpsSamples=useRef([]),changed=useRef(false);
 // Connection bar under the Pi name: from 1 px below the baseline down to the depth of a descender.
 const hostRef=useRef(null),[hostBar,setHostBar]=useState(null);
 const scaleRef=useRef(scale),statusRef=useRef(status),qualityRef=useRef(quality),fullscreenRef=useRef(fullscreen);scaleRef.current=scale;statusRef.current=status;qualityRef.current=quality;fullscreenRef.current=fullscreen;share.current=shareClipboard;
 // Black bars appear when the window's shape differs from the Pi desktop. Report how much the
 // host window can shrink so the scaled desktop fills it exactly (fit mode, normal window only).
 function requestFit(){
  const canvas=host.current?.querySelector('canvas');if(!canvas||!rfb.current||statusRef.current!=='connected'||scaleRef.current!=='fit'||fullscreenRef.current)return;
  const area=host.current.getBoundingClientRect(),ratio=canvas.width/canvas.height;if(!canvas.width||!canvas.height||!area.width||!area.height)return;
  const width=Math.min(area.width,area.height*ratio),height=Math.min(area.height,area.width/ratio);
  const dw=Math.round(width-area.width),dh=Math.round(height-area.height);
  if(dw<=-4||dh<=-4)send('screenFit',{dw,dh});
 }

 function flash(text){setNotice(text);clearTimeout(noticeTimer.current);noticeTimer.current=setTimeout(()=>setNotice(''),3200);}
 function teardown(){const current=rfb.current;rfb.current=null;channel.current=null;if(current){try{current.disconnect();}catch{}}}
 function stopRetry(){clearTimeout(retry.current.timer);clearTimeout(retry.current.steady);retry.current.attempt=0;setRetrying(0);}
 function connect(){stopRetry();start(false);}
 // `auto`: reopen after the Pi ended the picture; the host only reuses a live SSH connection then.
 function start(auto){
  if(!bridge||rfb.current)return;
  setStatus('connecting');setMessage('');setWaitSeconds(0);
  const pipe=new RelayChannel();channel.current=pipe;
  const client=new RFB(host.current,pipe,credentials.current?{credentials:credentials.current}:{});
  rfb.current=client;
  // A flip marks the picture as changed; the FPS display (only while switched on) counts screen refreshes
  // that show a change. (Counting flips alone gave ~200/s, since every small cursor update ends in a flip.)
  try{const display=client._display,flip=display.flip.bind(display);display.flip=(...a)=>{changed.current=true;return flip(...a);};}catch{}
  client.scaleViewport=scaleRef.current==='fit';client.resizeSession=false;client.clipViewport=false;client.focusOnClick=true;client.showDotCursor=true;client.background='#17151a';client.qualityLevel=qualityRef.current;client.compressionLevel=2;
  client.addEventListener('connect',()=>{if(rfb.current!==client)return;setWaitSeconds(0);setRetrying(0);setStatus('connected');statusRef.current='connected';setMessage('');client.focus();setTimeout(requestFit,120);send('screenInfo');micRef.current.resume();if(share.current)send('screenClipboardRead',{reason:'sync'});
   clearTimeout(retry.current.steady);retry.current.steady=setTimeout(()=>{retry.current.attempt=0;},10000);});
  client.addEventListener('disconnect',e=>{if(rfb.current!==client&&rfb.current!==null)return;rfb.current=null;channel.current=null;clearTimeout(retry.current.steady);setStatus(current=>current==='error'?'error':e.detail.clean?'disconnected':'error');setMessage(current=>current||(e.detail.clean?'Bildschirmverbindung getrennt. Die SSH-Verbindung bleibt bestehen.':'Die Bildschirmverbindung wurde unterbrochen.'));});
  client.addEventListener('credentialsrequired',e=>{setNeeds(e.detail.types||['password']);setStatus('credentials');});
  client.addEventListener('securityfailure',e=>{credentials.current=null;retry.current.attempt=RETRY_DELAYS.length;setStatus('error');setMessage('VNC-Anmeldung abgelehnt'+(e.detail.reason?': '+e.detail.reason:'.'));});
  // The host takes Pi text only while this window is in front (and when enabled) and confirms with a notice.
  client.addEventListener('clipboard',e=>{setClipboardSeen(true);if(!share.current)return;lastClipboard.current=e.detail.text;send('screenClipboardWrite',{text:e.detail.text});});
  client.addEventListener('desktopname',e=>setMeta(m=>({...m,desktop:e.detail.name})));
  send('screenOpen',auto?{auto:true}:{});
 }
 function disconnect(){stopRetry();teardown();setWaitSeconds(0);if(micRef.current.on)micRef.current.disable();setStatus('disconnected');setMessage('Bildschirmverbindung getrennt. Die SSH-Verbindung bleibt bestehen.');}
 function submitCredentials(e){
  e.preventDefault();const values={};for(const type of needs)if(type==='username'||type==='password')values[type]=form[type];
  credentials.current=values;setForm({username:'',password:''});setStatus('connecting');rfb.current?.sendCredentials(values);
 }
 // Dropped Windows files are copied over SSH onto the Pi desktop; VNC itself has no file transfer.
 function hostUpload(message){return new Promise(resolve=>{const id=crypto.randomUUID();uploads.current.set(id,resolve);send('screenUpload',{...message,id});});}
 async function uploadFiles(files){
  if(transferring.current){flash('Es läuft bereits eine Übertragung.');return;}
  if(statusRef.current!=='connected'){flash('Zuerst mit dem Pi-Bildschirm verbinden, dann Dateien ablegen.');return;}
  transferring.current=true;const saved=[],skipped=[];
  try{
   for(const [index,file] of files.entries()){
    if(file.size>UPLOAD_LIMIT){skipped.push(file.name+' (größer als 512 MiB)');continue;}
    const token=[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
    let offset=0,failed='';
    setTransfer({name:file.name,done:0,total:file.size,index:index+1,count:files.length});
    try{
     do{
      const part=new Uint8Array(await file.slice(offset,offset+UPLOAD_CHUNK).arrayBuffer());const final=offset+part.length>=file.size;
      const reply=await hostUpload({token,offset,data:toBase64(part),final,name:file.name});
      if(!reply.ok){failed=reply.error||'Übertragung fehlgeschlagen';break;}
      offset+=part.length;setTransfer(t=>({...t,done:offset}));
      if(final)saved.push(reply.result.path);
     }while(offset<file.size);
    }catch{failed='Datei konnte nicht gelesen werden (Ordner werden nicht unterstützt)';}
    if(failed){send('screenUploadCancel',{token});skipped.push(file.name+': '+failed);}
   }
  }finally{transferring.current=false;setTransfer(null);}
  // Paths with shell characters are single-quoted: pasted into a Pi terminal, a name like "$(…).pdf" stays a
  // name and never runs. Plain names (spaces included) stay as they are for file dialogs.
  if(saved.length&&rfb.current){const paths=saved.map(p=>/[$`;|&<>()\\"'!*?{}[\]#]/.test(p)?"'"+p.replace(/'/g,"'\\''")+"'":p).join(String.fromCharCode(10));lastClipboard.current=paths;rfb.current.clipboardPasteFrom(paths);}
  if(saved.length)flash((saved.length===1?'Datei liegt auf dem Pi-Desktop. Der Pfad ist':saved.length+' Dateien liegen auf dem Pi-Desktop. Die Pfade sind')+' in der Pi-Zwischenablage.'+(skipped.length?' Nicht übertragen: '+skipped.join(', '):''));
  else if(skipped.length)flash('Nicht übertragen: '+skipped.join(', '));
 }
 function toggleFullscreen(){send('screenFullscreen',{on:!fullscreen});}
 function pasteToPi(){send('screenClipboardRead',{reason:'manual'});}

 useEffect(()=>{
  if(!bridge)return;
  const receive=e=>{const m=e.data;switch(m.type){
   case 'screenInit':setLanguage(m.language);setMeta(v=>({...v,version:m.version||''}));setShowFps(Boolean(m.showFps));setFullscreen(Boolean(m.fullscreen));if(m.autoConnect)connect();else{setStatus('disconnected');setMessage('Ansicht neu geladen. Mit „Verbinden“ den Bildschirm erneut öffnen.');}break;
   case 'screenState':setStatus(s=>s==='credentials'?s:'connecting');setWaitSeconds(m.state==='waiting'?m.seconds||1:0);break;
   case 'screenOpened':channel.current?.opened();break;
   case 'screenData':channel.current?.receive(fromBase64(m.data));break;
   case 'screenInfo':setMeta(v=>({...v,os:m.info?.os||'',host:m.info?.host||'',server:m.info?.server||''}));break;
   case 'micState':micRef.current.onState(m);break;
   case 'screenClosed':setWaitSeconds(0);micRef.current.pause();if(m.error){setStatus('error');}setMessage(m.message||'');channel.current?.ended();if(!rfb.current&&!m.error)setStatus('disconnected');
    // The Pi ended the picture while SSH still stands (e.g. VNC server restarted): reopen with backoff.
    if(m.retry&&retry.current.attempt<RETRY_DELAYS.length){const n=++retry.current.attempt;clearTimeout(retry.current.timer);retry.current.timer=setTimeout(()=>start(true),RETRY_DELAYS[n-1]);setRetrying(n);setStatus('connecting');}
    else setRetrying(0);
    break;
   case 'screenNotice':flash(m.message);break;
   case 'screenSettings':setLanguage(m.language);setShowFps(Boolean(m.showFps));break;
   case 'screenFullscreen':setFullscreen(m.on);setToolbar(!m.on);break;
   case 'screenResizeEnd':requestFit();break;
   case 'screenUploadResult':uploads.current.get(m.id)?.(m);uploads.current.delete(m.id);break;
   case 'screenActivated':if(rfb.current&&statusRef.current==='connected'){rfb.current.focus();if(share.current)send('screenClipboardRead',{reason:'sync'});}break;
   // noVNC releases held keys on window blur; a deactivated host window may not always deliver one.
   case 'screenDeactivated':window.dispatchEvent(new Event('blur'));rfb.current?.blur();break;
   case 'screenClipboardText':{
    const text=m.text||'';if(!rfb.current||!text){if(m.reason==='manual')flash(text?'Nicht verbunden.':'Die Windows-Zwischenablage enthält keinen Text.');break;}
    if(m.reason!=='manual'&&text===lastClipboard.current)break;
    lastClipboard.current=text;rfb.current.clipboardPasteFrom(text);
    if(m.reason==='manual')flash(latin1(text)?'Text an den Pi übergeben. Dort mit Strg+V einfügen.':'Text übergeben. Zeichen außerhalb von Latin-1 kann der Pi ersetzen.');
    break;}
  }};
  // Screen bytes arrive as shared memory (no base64): copied once for noVNC, then released.
  const shared=e=>{const buffer=e.getBuffer();try{if(e.additionalData?.type==='screenData')channel.current?.receive(new Uint8Array(buffer.slice(0)));}finally{bridge.releaseBuffer(buffer);}};
  bridge.addEventListener('message',receive);bridge.addEventListener('sharedbufferreceived',shared);send('screenReady');
  return()=>{bridge.removeEventListener('message',receive);bridge.removeEventListener('sharedbufferreceived',shared);teardown();clearTimeout(noticeTimer.current);clearTimeout(retry.current.timer);clearTimeout(retry.current.steady);};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 const hostName=meta.host||(meta.desktop||'').replace(/:\d+$/,'')||'Pi-Bildschirm';
 useLayoutEffect(()=>{const el=hostRef.current,probe=el?.querySelector('.screen-host-probe');if(!probe)return;const size=parseFloat(getComputedStyle(el).fontSize)||16;setHostBar({top:probe.offsetTop+1,height:Math.max(2,Math.round(size*0.25)-1)});},[hostName,fullscreen]);
 useEffect(()=>{if(rfb.current)rfb.current.scaleViewport=scale==='fit';},[scale]);
 useEffect(()=>{if(!showFps||status!=='connected'){setFps(null);return;}frames.current=0;fpsSamples.current=[];changed.current=false;let tick=0,raf=0;
  const paint=()=>{if(changed.current){changed.current=false;frames.current++;}raf=requestAnimationFrame(paint);};raf=requestAnimationFrame(paint);
  const t=setInterval(()=>{const n=frames.current;frames.current=0;setFps(shownFps(fpsSamples.current,n,tick++));},1000);return()=>{clearInterval(t);cancelAnimationFrame(raf);};},[showFps,status]);
 useEffect(()=>{if(rfb.current)rfb.current.qualityLevel=quality;try{localStorage.setItem(QUALITY_KEY,String(quality));}catch{}},[quality]);
 useEffect(()=>{
  // F11 is the viewer's own shortcut; everything else goes to the Pi desktop.
  const key=e=>{if(e.key==='F11'){e.preventDefault();e.stopPropagation();if(!e.repeat&&e.type==='keydown')toggleFullscreen();}};
  window.addEventListener('keydown',key,true);window.addEventListener('keyup',key,true);
  return()=>{window.removeEventListener('keydown',key,true);window.removeEventListener('keyup',key,true);};
 });

 const connected=status==='connected',busy=status==='connecting';
 return <main className={'screen-stage'+(fullscreen?' fullscreen':'')+(toolbar?'':' toolbar-hidden')} data-status={status} onMouseMove={e=>{if(fullscreen)setToolbar(e.clientY<56);}}
  onDragOver={e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';setDragging(true);}}}
  onDragLeave={e=>{if(!e.relatedTarget)setDragging(false);}}
  onDrop={e=>{e.preventDefault();setDragging(false);const files=[...(e.dataTransfer?.files||[])];if(files.length)uploadFiles(files);}}>
  <header className="screen-toolbar">
   <span className="screen-title" title={'Integrierter Viewer (noVNC'+(meta.server?' · Pi sendet mit '+meta.server:'')+')'+(meta.version?' · Pi Relay '+meta.version:'')+' · Vollbild mit F11'}><span className="screen-mark" aria-hidden="true"><Monitor size={30}/>{showFps&&connected&&<span className="screen-fps-in" style={{color:fpsColor(fps)}} title="Bilder pro Sekunde">{fps??'–'}</span>}<b>{meta.server||'noVNC'}</b></span>{meta.os&&<small className="screen-os" title={meta.os}>{meta.os.replace(/^Raspberry Pi\s+/,'')}</small>}<span className={'screen-hostline '+status}><strong className="screen-host" ref={hostRef}>{hostName}<i className="screen-host-probe" aria-hidden="true"/><i className="screen-host-bar" style={hostBar||undefined} aria-hidden="true"/></strong><span className={'screen-status '+status} role="status"><i/><span className="screen-status-text">{labels[status]}</span></span></span></span>
   <span className={'screen-tools'+(tools.editing?' editing':'')} title={tools.editing?'Knopf auf einen anderen ziehen zum Tauschen · Esc oder Klick daneben beendet':undefined}>
    {tools.order.map(id=><span key={id} {...tools.bind(id)}>{{
     mic:<span className={'mic-button'+(mic.on?' on':'')+(mic.state==='waiting'?' waiting':'')}>
      {mic.on&&<span className="mic-level" aria-hidden="true"><b style={{transform:'scaleX('+meterScale(mic.level)+')'}}/></span>}
      <button className="mic-toggle" aria-label="Mikrofon" aria-pressed={mic.on} disabled={!connected&&!mic.on} onClick={()=>mic.on?mic.disable():mic.enable()} title={mic.on?(mic.state==='waiting'?'Mikro wartet auf die Verbindung · ausschalten':'Windows-Mikrofon geht an den Pi · ausschalten'):'Windows-Mikrofon an den Pi senden'}><Microphone size={17} weight={mic.on?'fill':'regular'}/>{mic.on&&<i className="mic-dot"/>}</button>
      <button className="mic-menu-toggle" aria-label="Mikrofon wählen" aria-haspopup="menu" aria-expanded={micMenu} onClick={()=>{if(!micMenu)mic.list();setMicMenu(o=>!o);}}><CaretDown size={11} weight="bold"/></button>
      {micMenu&&<span className="mic-menu" role="menu">
       {[{deviceId:'',label:'Standard (Windows-Standardgerät)'},...mic.devices].map(d=><button key={d.deviceId||'default'} role="menuitemradio" aria-checked={mic.device===d.deviceId} onClick={()=>{setMicMenu(false);mic.choose(d.deviceId);}}><span className="mic-menu-check">{mic.device===d.deviceId&&<Check size={13} weight="bold"/>}</span>{d.label||'Mikrofon'}</button>)}
      </span>}
     </span>,
     quality:<label className="screen-quality" title={'Bildqualität: höher ist schärfer, braucht aber mehr Daten. Grüner Punkt: gemessenes Optimum ('+QUALITY_OPTIMUM+'); 9 bremst die Bildrate stark. Die Auflösung legt der Pi fest.'}><span>Qualität</span><input type="range" min="0" max="9" step="1" value={quality} className={quality===QUALITY_OPTIMUM?'optimal':undefined} style={{'--q':quality,'--optimum':QUALITY_OPTIMUM}} aria-label="Bildqualität" onChange={e=>setQuality(Number(e.target.value))}/><output>{quality}</output></label>,
     connection:connected||busy||status==='credentials'?<button className="screen-tool" onClick={disconnect} title="Nur die Bildschirmverbindung trennen; SSH bleibt verbunden"><Plug size={17}/><span>Trennen</span></button>:<button className="screen-tool accent" disabled={!bridge} onClick={connect}><PlugsConnected size={17}/><span>Verbinden</span></button>,
     share:<label className="screen-share" aria-label="Zwischenablage teilen" title={clipboardSeen?'Der Pi hat bereits Text gesendet.':'Der Pi sendet erst Text, wenn dort etwas kopiert wird. Nur Text, keine Dateien.'}><input type="checkbox" checked={shareClipboard} onChange={e=>setShareClipboard(e.target.checked)}/><span>Zwischenablage teilen</span></label>,
     paste:<button className="screen-tool" disabled={!connected} onClick={pasteToPi} title="Text aus der Windows-Zwischenablage an den Pi übergeben"><ClipboardText size={17}/><span>An Pi</span></button>,
     scale:<button className="screen-tool" aria-pressed={scale==='fit'} onClick={()=>setScale(s=>s==='fit'?'native':'fit')} title={scale==='fit'?'An Fenster angepasst · auf Originalgröße wechseln':'Originalgröße 1:1 · an Fenster anpassen'}>{scale==='fit'?<ArrowsIn size={17}/>:<ArrowsOut size={17}/>}<span>{scale==='fit'?'Angepasst':'1:1'}</span></button>,
    }[id]}</span>)}
   </span>
  </header>
  <section className="screen-canvas" ref={host} aria-label={'Pi-Desktop '+alias}/>
  {!connected&&<div className="screen-overlay">
   {status==='credentials'?<form className="screen-card" onSubmit={submitCredentials}>
    <strong>VNC-Anmeldung</strong><p>Der VNC-Server auf dem Pi verlangt eine Anmeldung. Die Angaben bleiben nur bis zum Schließen dieses Fensters im Arbeitsspeicher.</p>
    {needs.includes('username')&&<label className="field">Benutzername<input autoFocus autoComplete="off" value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value}))}/></label>}
    {needs.includes('password')&&<label className="field">Passwort<input autoFocus={!needs.includes('username')} type="password" autoComplete="off" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))}/></label>}
    <div className="screen-card-actions"><button className="primary-action compact" type="submit">Anmelden</button><button className="small-button" type="button" onClick={disconnect}>Abbrechen</button></div>
   </form>:<div className="screen-card">
    {busy&&waitSeconds>0?<><span className="screen-spinner" aria-hidden="true"/><strong>Warte auf den VNC-Server des Pi …</strong><p>Der Pi startet seinen Desktop vermutlich noch. Pi Relay versucht es über die bestehende SSH-Verbindung weiter (noch bis zu {waitSeconds} s).</p><button className="small-button" type="button" onClick={disconnect}>Abbrechen</button></>
    :busy&&retrying>0?<><span className="screen-spinner" aria-hidden="true"/><strong>Bild unterbrochen · verbinde neu …</strong><p>Versuch {retrying} von {RETRY_DELAYS.length} über die bestehende SSH-Verbindung, ohne neue Anmeldung.</p><button className="small-button" type="button" onClick={disconnect}>Abbrechen</button></>
    :busy?<><span className="screen-spinner" aria-hidden="true"/><strong>Verbinde mit dem Pi-Bildschirm …</strong><p>Über die SSH-Verbindung {alias}. Ist sie getrennt, bestätige bei Aufforderung deinen Sicherheitsschlüssel.</p></>
    :status==='unavailable'?<><strong>Integrierter Viewer</strong><p>{message}</p></>
    :status==='waiting'?<><strong>Pi-Bildschirm</strong><p>Wird vorbereitet …</p></>
    :<><strong>{status==='error'?'Verbindung nicht möglich':'Getrennt'}</strong><p>{message}</p><button className="primary-action compact" onClick={connect}><ArrowClockwise size={17}/>Neu verbinden</button></>}
   </div>}
  </div>}
  {dragging&&<div className="screen-drop" aria-hidden="true"><strong>Dateien loslassen</strong><span>Sie landen über SSH direkt auf dem Pi-Desktop.</span></div>}
  {transfer&&<div className="screen-transfer" role="status"><span>{transfer.count>1?transfer.index+'/'+transfer.count+' · ':''}{transfer.name}</span><i style={{width:(transfer.total?Math.round(transfer.done/transfer.total*100):100)+'%'}}/></div>}
  {notice&&<div className="screen-notice" role="status">{notice}</div>}
 </main>;
}
