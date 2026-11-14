import {useEffect,useRef,useState} from 'react';
import RFB from '@novnc/novnc';
import {ArrowClockwise,ArrowsIn,ArrowsOut,ClipboardText,Microphone,Monitor,Plug,PlugsConnected} from '@phosphor-icons/react';
import './relay.css';

const bridge=window.chrome?.webview;
const send=(action,data={})=>bridge?.postMessage({action,...data});

// Windows microphone for the Pi: 48 kHz mono s16le in 20 ms chunks, captured here (WASAPI shared
// mode underneath) and fed by the host to the Pi's receiver over the existing SSH connection.
const MIC_DEVICE_KEY='pi-relay-mic-device';
const MIC_WORKLET=`class PiRelayMic extends AudioWorkletProcessor{constructor(){super();this.buf=new Int16Array(960);this.n=0;this.peak=0;}
process(inputs){const ch=inputs[0]&&inputs[0][0];if(!ch)return true;for(let i=0;i<ch.length;i++){const v=Math.max(-1,Math.min(1,ch[i]));this.buf[this.n++]=v<0?v*32768:v*32767;const a=v<0?-v:v;if(a>this.peak)this.peak=a;
if(this.n===960){this.port.postMessage({pcm:this.buf.buffer,level:this.peak},[this.buf.buffer]);this.buf=new Int16Array(960);this.n=0;this.peak=0;}}return true;}}
registerProcessor('pi-relay-mic',PiRelayMic);`;
// Level meter in decibels like Wave Link / Windows: -60 dBFS (empty) to 0 dBFS (full).
const meterScale=peak=>Math.max(0,Math.min(1,(20*Math.log10(Math.max(peak,1e-6))+60)/60));
const bytesToBase64=buffer=>{const bytes=new Uint8Array(buffer);let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));return btoa(text);};
function useMic(flash){
 const [on,setOn]=useState(false),[state,setState]=useState('off'),[level,setLevel]=useState(0),[devices,setDevices]=useState([]);
 const [device,setDevice]=useState(()=>{try{return localStorage.getItem(MIC_DEVICE_KEY)||'';}catch{return '';}});
 const wanted=useRef(false),capture=useRef(null),deviceRef=useRef(device);deviceRef.current=device;
 async function list(){try{const all=await navigator.mediaDevices.enumerateDevices();const mics=all.filter(d=>d.kind==='audioinput'&&d.deviceId&&d.deviceId!=='default'&&d.deviceId!=='communications');setDevices(mics);return mics;}catch{return [];}}
 function remember(id){setDevice(id);try{localStorage.setItem(MIC_DEVICE_KEY,id);}catch{}}
 function stopCapture(){const c=capture.current;capture.current=null;setLevel(0);if(!c)return;c.node.port.onmessage=null;c.stream.getTracks().forEach(t=>t.stop());c.ctx.close().catch(()=>{});}
 async function startCapture(id){
  stopCapture();
  const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:id?{exact:id}:undefined,channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  const ctx=new AudioContext({sampleRate:48000});
  const url=URL.createObjectURL(new Blob([MIC_WORKLET],{type:'text/javascript'}));
  try{await ctx.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}
  const node=new AudioWorkletNode(ctx,'pi-relay-mic',{numberOfInputs:1,numberOfOutputs:0,channelCount:1,channelCountMode:'explicit',channelInterpretation:'speakers'});
  let frames=0;
  node.port.onmessage=e=>{send('micChunk',{data:bytesToBase64(e.data.pcm)});if(++frames%3===0)setLevel(e.data.level);};
  ctx.createMediaStreamSource(stream).connect(node);
  capture.current={stream,ctx,node};
  const track=stream.getAudioTracks()[0];
  track.onended=()=>{if(capture.current?.stream===stream)disable('Das Mikrofon wurde getrennt.');};
  const actual=track.getSettings().deviceId;if(actual&&actual!==deviceRef.current)remember(actual);
  list();
 }
 function enable(){wanted.current=true;setOn(true);setState('starting');send('micStart');}
 function disable(notice){wanted.current=false;setOn(false);setState('off');stopCapture();send('micStop');if(notice)flash(notice);}
 async function choose(id){remember(id);if(capture.current){try{await startCapture(id);}catch(e){disable('Mikrofon lässt sich nicht öffnen: '+(e.message||e.name));}}}
 // Host replies: on = receiver ready (start capturing), lost = SSH gone (switch stays on), error = off.
 async function onState(m){
  if(m.state==='on'){if(!wanted.current){send('micStop');return;}
   try{await startCapture(deviceRef.current);setState('on');}
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
 constructor(){this.binaryType='arraybuffer';this.protocol='';this.readyState='connecting';this.onopen=null;this.onmessage=null;this.onerror=null;this.onclose=null;}
 send(data){if(this.readyState!=='open')return;const bytes=data instanceof Uint8Array?data:new Uint8Array(data);for(let i=0;i<bytes.length;i+=32768)send('screenSend',{data:toBase64(bytes.subarray(i,i+32768))});}
 close(){if(this.readyState==='closed')return;this.readyState='closed';send('screenDisconnect');setTimeout(()=>this.onclose?.({code:1000,reason:'',wasClean:true}),0);}
 opened(){if(this.readyState!=='connecting')return;this.readyState='open';this.onopen?.({});}
 receive(bytes){if(this.readyState==='open')this.onmessage?.({data:bytes.buffer});}
 ended(){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.({code:1006,reason:'',wasClean:false});}
}

const labels={waiting:'Bereit',connecting:'Verbinden …',credentials:'Anmeldung nötig',connected:'Verbunden',disconnected:'Getrennt',error:'Fehler',unavailable:'Nur in der App'};
const latin1=text=>[...text].every(c=>c.charCodeAt(0)<=255);
// noVNC quality 0-9 (JPEG/Tight); remembered per viewer window, never required for the page to work.
const QUALITY_KEY='piRelay.screenQuality';
const UPLOAD_CHUNK=768*1024,UPLOAD_LIMIT=512*1024*1024;
function storedQuality(){try{const v=Number(localStorage.getItem(QUALITY_KEY));return Number.isInteger(v)&&v>=0&&v<=9&&localStorage.getItem(QUALITY_KEY)!==null?v:6;}catch{return 6;}}

export function ScreenView(){
 const alias=new URLSearchParams(location.search).get('screen')||'MasterControl';
 const host=useRef(null),rfb=useRef(null),channel=useRef(null),credentials=useRef(null),lastClipboard=useRef(''),share=useRef(true),noticeTimer=useRef(0);
 const [status,setStatus]=useState(bridge?'waiting':'unavailable');
 const [waitSeconds,setWaitSeconds]=useState(0);
 const mic=useMic(text=>flashRef.current?.(text)),micRef=useRef(mic);micRef.current=mic;const flashRef=useRef();flashRef.current=flash;
 const [message,setMessage]=useState(bridge?'':'Der integrierte Viewer arbeitet in der Pi-Relay-App über deine bestehende SSH-Verbindung.');
 const [needs,setNeeds]=useState([]),[form,setForm]=useState({username:'',password:''});
 const [scale,setScale]=useState('fit'),[fullscreen,setFullscreen]=useState(false),[toolbar,setToolbar]=useState(true);
 const [shareClipboard,setShareClipboard]=useState(true),[clipboardSeen,setClipboardSeen]=useState(false),[notice,setNotice]=useState(''),[meta,setMeta]=useState({version:'',desktop:'',os:'',host:'',server:''});
 const [quality,setQuality]=useState(storedQuality);
 const [dragging,setDragging]=useState(false),[transfer,setTransfer]=useState(null);
 const uploads=useRef(new Map()),transferring=useRef(false);
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
 function connect(){
  if(!bridge||rfb.current)return;
  setStatus('connecting');setMessage('');setWaitSeconds(0);
  const pipe=new RelayChannel();channel.current=pipe;
  const client=new RFB(host.current,pipe,credentials.current?{credentials:credentials.current}:{});
  rfb.current=client;
  client.scaleViewport=scaleRef.current==='fit';client.resizeSession=false;client.clipViewport=false;client.focusOnClick=true;client.showDotCursor=true;client.background='#17151a';client.qualityLevel=qualityRef.current;client.compressionLevel=2;
  client.addEventListener('connect',()=>{if(rfb.current!==client)return;setWaitSeconds(0);setStatus('connected');statusRef.current='connected';setMessage('');client.focus();setTimeout(requestFit,120);send('screenInfo');micRef.current.resume();if(share.current)send('screenClipboardRead',{reason:'sync'});});
  client.addEventListener('disconnect',e=>{if(rfb.current!==client&&rfb.current!==null)return;rfb.current=null;channel.current=null;setStatus(current=>current==='error'?'error':e.detail.clean?'disconnected':'error');setMessage(current=>current||(e.detail.clean?'Bildschirmverbindung getrennt. Die SSH-Verbindung bleibt bestehen.':'Die Bildschirmverbindung wurde unterbrochen.'));});
  client.addEventListener('credentialsrequired',e=>{setNeeds(e.detail.types||['password']);setStatus('credentials');});
  client.addEventListener('securityfailure',e=>{credentials.current=null;setStatus('error');setMessage('VNC-Anmeldung abgelehnt'+(e.detail.reason?': '+e.detail.reason:'.'));});
  client.addEventListener('clipboard',e=>{setClipboardSeen(true);if(!share.current)return;lastClipboard.current=e.detail.text;send('screenClipboardWrite',{text:e.detail.text});flash('Text vom Pi in die Windows-Zwischenablage übernommen.');});
  client.addEventListener('desktopname',e=>setMeta(m=>({...m,desktop:e.detail.name})));
  send('screenOpen');
 }
 function disconnect(){teardown();setWaitSeconds(0);if(micRef.current.on)micRef.current.disable();setStatus('disconnected');setMessage('Bildschirmverbindung getrennt. Die SSH-Verbindung bleibt bestehen.');}
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
  if(saved.length&&rfb.current){const paths=saved.join(String.fromCharCode(10));lastClipboard.current=paths;rfb.current.clipboardPasteFrom(paths);}
  if(saved.length)flash((saved.length===1?'Datei liegt':saved.length+' Dateien liegen')+' auf dem Pi-Desktop. Der Pfad ist in der Pi-Zwischenablage.'+(skipped.length?' Nicht übertragen: '+skipped.join(', '):''));
  else if(skipped.length)flash('Nicht übertragen: '+skipped.join(', '));
 }
 function toggleFullscreen(){send('screenFullscreen',{on:!fullscreen});}
 function pasteToPi(){send('screenClipboardRead',{reason:'manual'});}

 useEffect(()=>{
  if(!bridge)return;
  const receive=e=>{const m=e.data;switch(m.type){
   case 'screenInit':setMeta(v=>({...v,version:m.version||''}));setFullscreen(Boolean(m.fullscreen));if(m.autoConnect)connect();else{setStatus('disconnected');setMessage('Ansicht neu geladen. Mit „Verbinden“ den Bildschirm erneut öffnen.');}break;
   case 'screenState':setStatus(s=>s==='credentials'?s:'connecting');setWaitSeconds(m.state==='waiting'?m.seconds||1:0);break;
   case 'screenOpened':channel.current?.opened();break;
   case 'screenData':channel.current?.receive(fromBase64(m.data));break;
   case 'screenInfo':setMeta(v=>({...v,os:m.info?.os||'',host:m.info?.host||'',server:m.info?.server||''}));break;
   case 'micState':micRef.current.onState(m);break;
   case 'screenClosed':setWaitSeconds(0);micRef.current.pause();if(m.error){setStatus('error');}setMessage(m.message||'');channel.current?.ended();if(!rfb.current&&!m.error)setStatus('disconnected');break;
   case 'screenNotice':flash(m.message);break;
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
  bridge.addEventListener('message',receive);send('screenReady');
  return()=>{bridge.removeEventListener('message',receive);teardown();clearTimeout(noticeTimer.current);};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 useEffect(()=>{if(rfb.current)rfb.current.scaleViewport=scale==='fit';},[scale]);
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
   <span className="screen-title" title={'Integrierter Viewer (noVNC'+(meta.server?' · Pi sendet mit '+meta.server:'')+')'+(meta.version?' · Pi Relay '+meta.version:'')+' · Vollbild mit F11'}><span className="screen-mark" aria-hidden="true"><Monitor size={21}/><b>noVNC</b></span>{meta.os&&<small className="screen-os" title={meta.os}>{meta.os.replace(/^Raspberry Pi\s+/,'')}</small>}<strong className="screen-host">{meta.host||(meta.desktop||'').replace(/:\d+$/,'')||'Pi-Bildschirm'}</strong></span>
   <span className={'screen-status '+status} role="status"><i/><span className="screen-status-text">{labels[status]}{connected&&meta.server&&<small className="screen-server">{meta.server}</small>}</span></span>
   <span className="screen-tools">
    <span className={'screen-mic'+(mic.on?' on':'')}>
      <button className="screen-tool mic-toggle" aria-pressed={mic.on} disabled={!connected&&!mic.on} onClick={()=>mic.on?mic.disable():mic.enable()} title={mic.on?(mic.state==='waiting'?'Mikro wartet auf die Verbindung · ausschalten':'Windows-Mikrofon geht an den Pi · ausschalten'):'Windows-Mikrofon an den Pi senden'}><Microphone size={17} weight={mic.on?'fill':'regular'}/>{mic.on&&<i className="mic-dot"/>}<span>Mikro</span></button>
      {mic.on&&<span className="mic-level" aria-hidden="true"><b style={{transform:'scaleX('+meterScale(mic.level)+')'}}/></span>}
      <select className="mic-device" aria-label="Mikrofon wählen" value={mic.device} onFocus={mic.list} onChange={e=>mic.choose(e.target.value)}>{!mic.devices.some(d=>d.deviceId===mic.device)&&<option value={mic.device}>{mic.device?'Gemerktes Mikrofon':'Standard-Mikrofon'}</option>}{mic.devices.map(d=><option key={d.deviceId} value={d.deviceId}>{d.label||'Mikrofon'}</option>)}</select>
     </span>
    {connected||busy||status==='credentials'?<button className="screen-tool" onClick={disconnect} title="Nur die Bildschirmverbindung trennen; SSH bleibt verbunden"><Plug size={17}/><span>Trennen</span></button>:<button className="screen-tool accent" disabled={!bridge} onClick={connect}><PlugsConnected size={17}/><span>Verbinden</span></button>}
    <label className="screen-quality" title="Bildqualität: höher ist schärfer, braucht aber mehr Bandbreite. Die Auflösung selbst legt der Pi fest."><span>Qualität</span><input type="range" min="0" max="9" step="1" value={quality} aria-label="Bildqualität" onChange={e=>setQuality(Number(e.target.value))}/><output>{quality}</output></label>
    <button className="screen-tool" aria-pressed={scale==='fit'} onClick={()=>setScale(s=>s==='fit'?'native':'fit')} title={scale==='fit'?'An Fenster angepasst · auf Originalgröße wechseln':'Originalgröße 1:1 · an Fenster anpassen'}>{scale==='fit'?<ArrowsIn size={17}/>:<ArrowsOut size={17}/>}<span>{scale==='fit'?'Angepasst':'1:1'}</span></button>
    <span className="screen-clipboard">
     <button className="screen-tool" disabled={!connected} onClick={pasteToPi} title="Text aus der Windows-Zwischenablage an den Pi übergeben"><ClipboardText size={17}/><span>An Pi</span></button>
     <label className="screen-share" aria-label="Zwischenablage teilen" title={clipboardSeen?'Der Pi hat bereits Text gesendet.':'Der Pi sendet erst Text, wenn dort etwas kopiert wird. Nur Text, keine Dateien.'}><input type="checkbox" checked={shareClipboard} onChange={e=>setShareClipboard(e.target.checked)}/><span>Zwischenablage teilen</span></label>

    </span>
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
