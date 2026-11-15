import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GearSix, Terminal, Key, CaretDown, CaretRight, Minus, Info, X, ArrowSquareOut, Plus, Copy, Check, Power, FolderOpen, Plug, ArrowClockwise, Pause, Monitor, PencilSimple } from '@phosphor-icons/react';
import './relay.css';
import { ViewerPanel } from './ViewerPanel.jsx';
import { IntegratedViewerPanel, VncServerCard } from './IntegratedViewerPanel.jsx';
import { setLanguage } from './i18n.js';

const native = Boolean(window.chrome?.webview);
const designMode = !native && new URLSearchParams(location.search).has('design');
const initial = { profiles:[{alias:'MeinPi',hostname:'192.168.1.50',user:'pi',state:designMode?'connected':'disconnected',keyType:'Hardware-Schlüssel'},{alias:'Ersatzzugang',hostname:'192.168.1.50',user:'pi',state:'disconnected',keyType:'Hardware-Schlüssel'}], keys:[], viewer:{provider:'',installed:'',latest:null,pending:null,previous:null,busy:false,error:'',ready:false,updateAvailable:false}, settings:{managedViewer:true,externalViewer:false,minimized:designMode,autostart:false,motion:true}, agents:{codex:{alias:'',root:'',allowCommands:false,allowWrite:false,state:designMode?'active':'disconnected'},claude:{alias:'',root:'',allowCommands:false,allowWrite:false,state:designMode?'active':'disconnected'}}, events:[] };
if(designMode&&new URLSearchParams(location.search).has('viewer-update'))initial.viewer={...initial.viewer,provider:'tigervnc',installed:'1.16.1',latest:'1.16.2',previous:'1.16.0',ready:true,updateAvailable:true,lastChecked:'2026-11-01T12:00:00Z'};
if(designMode)initial.integrated={appVersion:'0.4.0',installed:'1.7.0',latest:'1.7.0',updateAvailable:false,skipped:false,lastChecked:'2026-11-12T05:00:00Z',error:'',busy:false,canBuild:true,building:false,staged:null,sshActive:true};
if(designMode)initial.vncServers={'192.168.1.50':{server:'x11vnc',package:'x11vnc',installed:'0.9.17-1',candidate:new URLSearchParams(location.search).has('vnc-update')?'0.9.17-2':'0.9.17-1',update:new URLSearchParams(location.search).has('vnc-update'),addresses:['127.0.0.1','::1'],localOnly:true}};
if(designMode&&new URLSearchParams(location.search).has('vnc-tiger'))initial.vncServers['192.168.1.50']={...initial.vncServers['192.168.1.50'],server:'TigerVNC',package:'tigervnc-scraping-server',installed:'1.15.0+dfsg-1',candidate:'1.15.0+dfsg-1',update:false};
if(designMode&&new URLSearchParams(location.search).has('staged'))initial.integrated={...initial.integrated,staged:{appVersion:'0.4.1',noVnc:'1.7.0',testsPassed:true}};
if(designMode&&new URLSearchParams(location.search).has('novnc-update'))initial.integrated={...initial.integrated,latest:'1.8.0',updateAvailable:true};
if(designMode)initial.devices={'192.168.1.50':{model:'Raspberry Pi 5 Model B Rev 1.1',memoryBytes:16*2**30*0.985,storageBytes:125e9,storageKind:'USB'}};
if(designMode&&new URLSearchParams(location.search).has('pi-offline')){initial.profiles=initial.profiles.map(p=>({...p,state:'disconnected'}));initial.reachability={'192.168.1.50':'offline'};}
if(designMode&&new URLSearchParams(location.search).has('agents-off'))initial.agents=Object.fromEntries(Object.entries(initial.agents).map(([k,a])=>[k,{...a,state:'disconnected'}]));
if(designMode&&new URLSearchParams(location.search).has('pi-waiting')){initial.profiles=initial.profiles.map((p,i)=>({...p,state:i===0?'waiting':'disconnected'}));initial.reachability={'192.168.1.50':'offline'};}
const names = {codex:'Codex',claude:'Claude'};
const stateText = {disconnected:'Getrennt',connecting:'Verbinden …',waiting:'Wartet auf Pi …',key:'Schlüssel bestätigen',connected:'Verbunden',ready:'SSH bereit',active:'Verbunden',busy:'Arbeitet',error:'Verbindung prüfen'};

function request(action,data={}) { if(native) window.chrome.webview.postMessage({action,...data}); }
// Language switch in the settings header (left of the close button): the round knob shows the language you
// switch TO, so in German it reads "English" with the British flag. Click, drag or arrow keys switch; the
// choice is saved and the whole UI follows.
const FLAGS={de:<svg viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="10" fill="#000"/><rect y="10" width="30" height="10" fill="#D00"/><rect y="20" width="30" height="10" fill="#FFCE00"/></svg>,
 en:<svg viewBox="15 0 30 30" aria-hidden="true"><clipPath id="uk-t"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#uk-t)" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></svg>};
function LanguageSwitch({value,onChange}){
 const english=value==='en',target=english?'de':'en',drag=useRef(null);
 const go=()=>onChange(target);
 return <button type="button" className={'language-switch'+(english?' en':'')} aria-label={english?'Auf Deutsch umstellen':'Switch to English'} title={english?'Auf Deutsch umstellen':'Switch to English'}
  onPointerDown={e=>{drag.current={x:e.clientX};e.currentTarget.setPointerCapture?.(e.pointerId);}}
  onPointerMove={e=>{const d=drag.current;if(!d||d.moved||Math.abs(e.clientX-d.x)<8)return;d.moved=true;go();}}
  onClick={()=>{const moved=drag.current?.moved;drag.current=null;if(!moved)go();}}
  onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();go();}}}>
  <span className="language-knob">{FLAGS[target]}</span><span className="language-name">{english?'Deutsch':'English'}</span>
 </button>;
}
// Typing in the panel keeps it open even with the mouse elsewhere (it folds away after 20 s idle).
let lastActivity=0;
if(native&&!/[?&](terminal|screen)=/.test(location.search))addEventListener('keydown',()=>{const now=Date.now();if(now-lastActivity>1000){lastActivity=now;request('panelActivity');}},true);
// The native panel slides as one piece: the renderer moves the front frame by frame and reports each
// offset, so Windows clips the real window to it. Reversing starts from the current offset.
// Collapse starts fast and settles softly (quartic ease-out); reveal eases out a little less.
const settle=t=>1-Math.pow(1-t,4), easeOut=t=>1-Math.pow(1-t,3);
const slide={offset:0,frame:0};
function slideTo(target,duration,ease,token,done){
 const relay=document.querySelector('.relay');if(!relay)return done?.();
 cancelAnimationFrame(slide.frame);
 const from=slide.offset,start=performance.now(),still=matchMedia('(prefers-reduced-motion: reduce)').matches||duration<=0;
 const step=now=>{
  const t=still?1:Math.min(1,(now-start)/duration);
  slide.offset=from+(target-from)*ease(t);
  relay.style.transform=slide.offset?'translateY('+slide.offset+'px)':'';
  request('clipPanel',{token,offset:slide.offset});
  if(t<1)slide.frame=requestAnimationFrame(step);else done?.();
 };
 slide.frame=requestAnimationFrame(step);
}
function resetSlide(){cancelAnimationFrame(slide.frame);slide.offset=0;const relay=document.querySelector('.relay');if(relay)relay.style.transform='';}
function Asset({name,src,...props}) { return <img draggable="false" src={src||'/assets/'+name+'.png'} {...props}/>; }
// Own pictures replace the bundled ones; the token busts the image cache after a new import.
const userIcon=(icons,slot)=>icons?.[slot]?'https://pi-relay-icons.local/'+slot+'.png?v='+icons[slot]:null;
// Resting on a picture draws a grey ring around it: nothing in the first second, the first quarter fades in
// up to the second, the rest closes by the fifth. Then the ring fills grey and reads "PNG ändern"
// ("Standard" for an own picture).
const ICON_ARM_MS=5000;
function IconSlot({slot,custom,call,children}) {
 const [phase,setPhase]=useState('idle');const timer=useRef();
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 const enter=()=>{clearTimeout(timer.current);setPhase(p=>p==='shown'?p:'arming');timer.current=setTimeout(()=>setPhase('shown'),ICON_ARM_MS);};
 const leave=()=>{clearTimeout(timer.current);timer.current=setTimeout(()=>setPhase('idle'),450);};
 const act=action=>{clearTimeout(timer.current);setPhase('idle');call(action,{slot});};
 return <span className={'icon-slot '+phase+(phase==='shown'?' shown':'')} onPointerEnter={enter} onPointerLeave={leave}>
  {children}
  <svg className="icon-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="47" pathLength="100"/></svg>
  <span className="icon-edit" inert={phase!=='shown'}><button className="icon-edit-main" onClick={()=>act('pickIcon')}>PNG ändern</button>{custom&&<button className="icon-edit-reset" onClick={()=>act('resetIcon')}>Standard</button>}</span>
 </span>;
}


// The badge names the VNC server on the Pi once known (x11vnc, WayVNC, TigerVNC); noVNC remains the viewer.
function ScreenIcon({size=22,external=false,server=''}) {
 return <span className={'screen-symbol'+(external?'':' integrated')+(server&&!external?' with-server':'')+(server.length>6&&!external?' long-server':'')} aria-hidden="true"><Monitor size={size}/><span className="vnc-badge">{external?'VNC':server||'noVNC'}</span></span>;
}
// Pointer on the right: Claude (right) follows it clearly, Codex (left) barely - and the other way round.
function sideWeight(id,x){const all=[...document.querySelectorAll('.agents-strip [data-companion]')].map(e=>e.getBoundingClientRect());if(all.length<2)return 1;const mid=(all[0].left+all[0].width/2+all[1].left+all[1].width/2)/2,s=Math.max(-1,Math.min(1,(x-mid)/160));const toward=id==='claude'?s:-s;return toward>=0?0.55+0.45*toward:0.55+0.43*toward;}
function LookingAvatar({id,motion,className='',src}) {
 const portrait=useRef();
 useEffect(()=>{
  const node=portrait.current,reduce=matchMedia('(prefers-reduced-motion: reduce)');
  let latest=null,dirty=false,timer;
  const reset=()=>{node.style.setProperty('--look','0deg');node.style.setProperty('--look-y','0deg');};
  reset();if(!motion)return;
  const point=e=>{latest={x:e.clientX,y:e.clientY};dirty=true;};
  const react=()=>{
   if(dirty&&latest&&!reduce.matches){const box=node.getBoundingClientRect(),dx=latest.x-box.left-box.width/2,dy=(latest.y-box.top-box.height/2)*sideWeight(id,latest.x);node.style.setProperty('--look',(Math.max(-13,Math.min(13,dx/23))*sideWeight(id,latest.x)).toFixed(1)+'deg');node.style.setProperty('--look-y',Math.max(-5,Math.min(5,-dy/55)).toFixed(1)+'deg');dirty=false;}
   timer=setTimeout(react,id==='codex'?260:390);
  };
  window.addEventListener('pointermove',point,{passive:true});reduce.addEventListener('change',reset);
  timer=setTimeout(react,id==='codex'?90:210);
  return()=>{clearTimeout(timer);window.removeEventListener('pointermove',point);reduce.removeEventListener('change',reset);reset();};
 },[id,motion]);
 return <span ref={portrait} className={'avatar-wrap '+className} data-companion={id}><Asset name={id+'-avatar'} src={src} alt="" className="avatar"/></span>;
}
function Companion({id,agent,motion,onConfigure,onToggle,icon,call}) {
 const enabled=['ready','active','busy'].includes(agent.state);
 return <div className={'agent '+id+(enabled?' live':'')}>
  <IconSlot slot={id} custom={icon} call={call}><button className="avatar-button" onClick={onConfigure} aria-label={names[id]+'-Zugang verwalten'}><LookingAvatar id={id} motion={motion&&enabled} src={icon}/>{!enabled&&<span className="sleep-z" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>}</button></IconSlot>
  <div className="agent-copy"><button className="agent-name" onClick={onConfigure}>{names[id]}</button>
   <button className="agent-status" disabled={['key','connecting'].includes(agent.state)} title={enabled?'Zugriff beenden':'Zugriff freigeben'} aria-label={names[id]+(enabled?' trennen':' verbinden')} onClick={onToggle}><i className={'agent-dot '+id+(enabled?' on':'')}/>{stateText[agent.state]||'Getrennt'}{enabled?<Pause size={12}/>:<Plug size={12}/>}</button>
  </div>
 </div>;
}

// The Pi address can change after a new router lease; editing it moves all aliases of that Pi.
const HOST_PATTERN=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;
function HostAddress({host,help,onSave}) {
 const [editing,setEditing]=useState(false),[value,setValue]=useState(host||'');
 if(!host)return <span className="ip">Noch kein Pi eingerichtet</span>;
 const valid=HOST_PATTERN.test(value.trim());
 function save(){if(!valid)return;setEditing(false);if(value.trim()!==host)onSave(value.trim());}
 if(editing)return <span className="ip-row editing"><input className="ip-input" aria-label="Pi-Adresse" autoFocus value={value} spellCheck={false} onChange={e=>setValue(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')save();if(e.key==='Escape'){e.stopPropagation();setEditing(false);}}} aria-invalid={!valid}/><button className="ip-edit visible" aria-label="Adresse speichern" disabled={!valid} onClick={save}><Check size={15} weight="bold"/></button><button className="ip-edit visible" aria-label="Bearbeiten abbrechen" onClick={()=>setEditing(false)}><X size={15}/></button></span>;
 return <span className="ip-row">{help?<span className="ip ip-hint">IP aus dem Router-Menü übernehmen</span>:<span className="ip">{host}</span>}<button className={'ip-edit'+(help?' visible':'')} aria-label="Pi-Adresse ändern" title="Pi-Adresse ändern (z. B. neue IP aus dem Router)" onClick={()=>{setValue(host);setEditing(true);}}><PencilSimple size={15}/></button></span>;
}

// Board facts come from the Pi itself (read once over SSH, remembered per address).
function boardName(model){return (model||'').replace(/\s+Model\s.*$/i,'').replace(/\s+Rev\s.*$/i,'').trim()||'Raspberry Pi';}
function ramLabel(bytes){if(!bytes)return '';const gib=bytes/2**30;const size=[1,2,4,8,16,32].reduce((best,s)=>Math.abs(Math.log(s/gib))<Math.abs(Math.log(best/gib))?s:best);return size+' GB RAM';}
function storageLabel(bytes,kind){
 if(!bytes)return '';const gb=bytes/1e9;
 const marketed=[16,32,64,128,256,500,512,1000,2000,4000].find(s=>gb<=s&&gb>=s*0.85);const size=marketed||Math.round(gb);
 return (size>=1000?(size/1000)+' TB':size+' GB')+(kind==='NVMe'?' NVMe':kind==='SD'?' SD':kind==='USB'?' USB':'');
}

// Drive on the front, RAM on the back: each pointer entry turns the label half a turn around its
// vertical axis, in the direction the pointer came from. Both faces share the wider face's width.
// "16 GB RAM": the number as tall as the heading's "5", the unit glued to it at lowercase height, then the kind.
function SpecText({text}) {
 const m=/^([\d.,]+)\s?(GB|TB)(?:\s(.+))?$/.exec(text||'');
 if(!m)return text;
 return <><span className="spec-num">{m[1]}</span><span className="spec-unit">{m[2]}</span>{m[3]&&<> <span className="spec-unit">{m[3]}</span></>}</>;
}
function SpecFlip({front,back}) {
 const [angle,setAngle]=useState(0);
 function turn(event){const box=event.currentTarget.getBoundingClientRect();setAngle(a=>a+(event.clientX<=box.left+box.width/2?1:-1)*180);}
 return <span className="spec-flip" onPointerEnter={turn} data-face={Math.abs(Math.round(angle/180))%2?'back':'front'} aria-label={front+', '+back}>
  <span className="spec-flip-rotor" style={{transform:'rotateY('+angle+'deg)'}}><span className="spec-chip spec-face spec-front" aria-hidden="true"><SpecText text={front}/></span><span className="spec-chip spec-face spec-back" aria-hidden="true"><SpecText text={back}/></span></span>
 </span>;
}

function TerminalAction({alias,connected,onOpen}) {
 const [angle,setAngle]=useState(0);
 function turn(event){const box=event.currentTarget.getBoundingClientRect();const direction=event.clientX<=box.left+box.width/2?1:-1;setAngle(a=>a+direction*180);}
 return <span className="terminal-action-shell" onPointerEnter={turn} data-symbol={Math.abs(Math.round(angle/180))%2?'key':'terminal'}>
  <button className="terminal-icon terminal-morph" title={connected?'Terminal für '+alias+' öffnen':'Mit '+alias+' verbinden und Terminal öffnen'} aria-label={alias+' Terminal öffnen'} onClick={onOpen}>
   <span className="terminal-morph-icon" aria-hidden="true"><span className="terminal-morph-rotor" style={{transform:'rotateY('+angle+'deg)'}}><span className="terminal-face terminal-face-front"><Terminal size={29}/></span><span className="terminal-face terminal-face-back"><Asset name="key-profile" alt=""/></span></span></span>
  </button>
 </span>;
}

export function App() {
 const [data,setData]=useState(initial), [view,setView]=useState('home'), [notice,setNotice]=useState(''), [selected,setSelected]=useState('MeinPi');
 const [agentDraft,setAgentDraft]=useState(null), [copied,setCopied]=useState(''), [collapsing,setCollapsing]=useState(false), [visible,setVisible]=useState(true);
 const [backupOpen,setBackupOpen]=useState(false),[help,setHelp]=useState(false);
 const [panelHeight,setPanelHeight]=useState(440);
 const noteTimer=useRef(),collapseTimer=useRef(),collapseToken=useRef(0),helpTimer=useRef(),heading=useRef(),body=useRef();
 const notify=(text)=>{setNotice(text);clearTimeout(noteTimer.current);noteTimer.current=setTimeout(()=>setNotice(''),6500);};
 function navigate(next){setView(next);setNotice('');setHelp(false);clearTimeout(helpTimer.current);}
 function showHelp(){clearTimeout(helpTimer.current);setHelp(h=>!h);}
 function collapse(){if(native)request('hide');else{setCollapsing(true);clearTimeout(collapseTimer.current);collapseTimer.current=setTimeout(()=>setCollapsing(false),950);}}
 useEffect(()=>{
  if(!native)return;
  const receive=(e)=>{
   if(e.data.type==='state'){setData(e.data.data);if(e.data.data.panel?.visible&&!e.data.data.panel.collapsing&&!e.data.data.panel.revealing){clearTimeout(collapseTimer.current);setCollapsing(false);setVisible(true);resetSlide();}}
   else if(e.data.type==='notice')notify(e.data.message);
   else if(e.data.type==='collapse'){const token=e.data.token||0;collapseToken.current=token;setCollapsing(true);const height=document.querySelector('.relay')?.getBoundingClientRect().height||0;slideTo(height*1.02,520,settle,token,()=>request('hideComplete',{token}));}
   // Without a token (startup, reload) the panel simply shows; with one it slides in from where it is.
   else if(e.data.type==='reveal'){setCollapsing(false);setVisible(true);const token=e.data.token;if(!token){resetSlide();return;}
    const height=document.querySelector('.relay')?.getBoundingClientRect().height||0;if(e.data.from==='hidden')slide.offset=height*1.02;
    slideTo(0,Math.max(200,460*Math.min(1,slide.offset/(height||1))),easeOut,token,()=>request('revealComplete',{token}));}
   else if(e.data.type==='hidden')setVisible(false);
  };
  window.chrome.webview.addEventListener('message',receive);request('getState');
  return()=>{window.chrome.webview.removeEventListener('message',receive);clearTimeout(collapseTimer.current);clearTimeout(noteTimer.current);};
 },[]);
 useEffect(()=>{if(!native||!visible)return;let frame;const report=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const panel=document.querySelector('.panel-viewport');request('surfaceReady',{width:innerWidth,height:innerHeight,panelHeight:panel?.getBoundingClientRect().height||0,collapsed:collapsing});});};const observer=new ResizeObserver(report);observer.observe(document.querySelector('.panel-viewport'));report();return()=>{cancelAnimationFrame(frame);observer.disconnect();};},[visible,collapsing]);
 useLayoutEffect(()=>{
  if(view!=='home')return;
  const home=body.current,relay=home.closest('.relay'),content=home.closest('.panel-content');
  const measure=()=>{
   const header=content.querySelector('.app-header'),footer=content.querySelector('.app-footer'),drawer=home.querySelector('.backup-accesses'),drawerContent=drawer?.firstElementChild,css=getComputedStyle(relay);
   const inset=['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((sum,key)=>sum+(parseFloat(css[key])||0),0);
   const drawerTarget=backupOpen?(drawerContent?.scrollHeight||0):0;
   const height=Math.ceil(header.getBoundingClientRect().height+home.getBoundingClientRect().height+footer.getBoundingClientRect().height+inset-(drawer?.getBoundingClientRect().height||0)+drawerTarget);
   if(Number.isFinite(height))setPanelHeight(Math.max(300,Math.min(720,height)));
  };
  const observer=new ResizeObserver(measure);observer.observe(home);observer.observe(content.querySelector('.app-header'));observer.observe(content.querySelector('.app-footer'));measure();
  return()=>observer.disconnect();
 },[view,backupOpen]);
 useEffect(()=>{if(native)request('resizePanel',{height:panelHeight,motion:data.settings.motion});},[panelHeight,data.settings.motion]);
 useEffect(()=>{if(data.settings.language)setLanguage(data.settings.language);},[data.settings.language]);
 useEffect(()=>{body.current?.scrollTo(0,0);if(view!=='home')heading.current?.focus();const key=e=>{if(e.key==='Escape'){e.preventDefault();if(view==='home')collapse();else navigate(view==='events'?'settings':view==='external'?'screen':'home');}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[view]);
 const profile=data.profiles.find(p=>p.alias===selected)||data.profiles[0];
 const v=data.viewer||initial.viewer;
 // The Pi worker refuses "/" and, with write or command rights, the home folder itself; say so at the field.
 const agentUser=data.profiles.find(p=>p.alias===agentDraft?.alias)?.user||'pi',agentHome=agentUser==='root'?'/root':'/home/'+agentUser;
 // Mirrors the Pi's rules: no "/", no home or folder above it with write/command rights, and a hidden folder
 // under home (e.g. ~/.config, where autostart lives) with write rights only together with commands.
 const agentRoot=(agentDraft?.root||'').replace(/\/+$/,''),rights=Boolean(agentDraft?.allowWrite||agentDraft?.allowCommands);
 const rootAboveHome=agentRoot!==''&&(agentHome===agentRoot||agentHome.startsWith(agentRoot+'/'));
 const rootHidden=agentRoot.startsWith(agentHome+'/')&&agentRoot.slice(agentHome.length+1).split('/').some(part=>part.startsWith('.'));
 const rootReason=!agentDraft?.root.startsWith('/')?'':agentRoot===''?'„/“ geht nicht.':rootAboveHome&&rights?'Den Home-Ordner (oder einen Ordner darüber) nur ohne Schreib- und Befehlsrecht.':rootHidden&&agentDraft.allowWrite&&!agentDraft.allowCommands?'Versteckte Ordner wie ~/.config mit Schreibrecht nur zusammen mit Befehlen.':'';
 const rootBlocked=Boolean(rootReason);
 const viewerReady=data.settings.managedViewer!==false?v.ready:Boolean(data.settings.vncViewer);const externalUpdate=data.settings.managedViewer!==false&&v.installed&&v.updateAvailable&&!v.skipped&&!v.pending;const screenOpen=Boolean(profile&&data.screens?.includes(profile.alias));const useExternal=Boolean(data.settings.externalViewer);const externalName=data.settings.managedViewer===false?'Eigener Viewer':v.provider==='realvnc-classic'?'RealVNC Classic':v.provider==='tigervnc'?'TigerVNC':'Externer Viewer';
 const connected=data.profiles.some(p=>p.hostname===profile?.hostname&&p.state==='connected');
 const connecting=data.profiles.some(p=>p.hostname===profile?.hostname&&['key','connecting'].includes(p.state));
 const waitingProfile=data.profiles.find(p=>p.hostname===profile?.hostname&&p.state==='waiting');
 const keyPrompt=data.profiles.some(p=>p.hostname===profile?.hostname&&p.state==='key');
 // Network ping only (no SSH): the Pi is shut down or not on the network.
 const offline=!connected&&data.reachability?.[profile?.hostname]==='offline';
 const facts=data.devices?.[profile?.hostname];
 const piServer=data.vncServers?.[profile?.hostname]?.server||'';
 // The facts beside the heading follow its responsive size.
 const titleRow=useRef();
 useLayoutEffect(()=>{const row=titleRow.current,h2=row?.querySelector('h2');if(!h2)return;const sync=()=>row.style.setProperty('--title-size',getComputedStyle(h2).fontSize);sync();const watch=new ResizeObserver(sync);watch.observe(h2);return()=>watch.disconnect();},[view]);
 useEffect(()=>{if(native&&view==='screen'&&connected&&profile&&!data.vncServers?.[profile.hostname])call('checkVncServer',{alias:profile.alias});},[view,connected,profile?.hostname]);
 const localProfiles=data.profiles.filter(p=>p.hostname===profile?.hostname);
 const backupProfiles=localProfiles.filter(p=>p.alias.toLowerCase()==='ersatzzugang');
 const primaryProfiles=localProfiles.filter(p=>p.alias.toLowerCase()!=='ersatzzugang');
 function call(action,payload={}) {
  if(native){request(action,payload);return;}
  if(action==='connectProfile'){setData(d=>({...d,profiles:d.profiles.map(p=>p.alias===payload.alias?{...p,state:'key'}:p)}));notify('Designvorschau: Eine echte SSH-Anmeldung startet nur in der Windows-App.');setTimeout(()=>setData(d=>({...d,profiles:d.profiles.map(p=>p.alias===payload.alias?{...p,state:'disconnected'}:p)})),1800);}
  else if(action==='skipViewerUpdate')setData(d=>({...d,viewer:{...d.viewer,skipped:true}}));
  else if(action==='restoreViewerUpdate')setData(d=>({...d,viewer:{...d.viewer,skipped:false}}));
  else if(action==='saveSettings')setData(d=>({...d,settings:{...d.settings,...payload.settings}}));
  else if(action==='checkVncServer')setTimeout(()=>setData(d=>({...d,vncServers:Object.fromEntries(Object.entries(d.vncServers||{}).map(([h,v])=>[h,{...v,checkedAt:Date.now()}]))})),700);
  else if(action==='cancelWait')setData(d=>({...d,profiles:d.profiles.map(p=>p.state==='waiting'?{...p,state:'disconnected'}:p)}));
  else if(action==='pickIcon')notify('Designvorschau: In der Windows-App öffnet sich hier die Bildauswahl.');
  else if(action==='setHost'){setData(d=>({...d,profiles:d.profiles.map(p=>p.hostname===payload.from?{...p,hostname:payload.to}:p)}));notify('Designvorschau: In der Windows-App wird die SSH-Konfiguration angepasst.');}
  else if(['checkIntegratedViewer','skipIntegratedViewer','restoreIntegratedViewer'].includes(action))notify('Designvorschau: Die Updateprüfung läuft in der Windows-App.');
  else if(action==='saveAgent'){setData(d=>({...d,agents:{...d.agents,[payload.agent]:{...d.agents[payload.agent],...payload.config}}}));notify('Profil für die Vorschau gespeichert.');}
  else if(action==='connectAgent')notify('Designvorschau: Der Agent nutzt in der Windows-App den bereits verbundenen SSH-Zugang.');
  else if(action==='disconnectAgent')setData(d=>({...d,agents:{...d.agents,[payload.agent]:{...d.agents[payload.agent],state:'disconnected'}}}));
  else if(action==='copyMcp'){navigator.clipboard?.writeText('PiRelay.exe --mcp '+payload.agent);setCopied(payload.agent);setTimeout(()=>setCopied(''),1600);}
  else notify('Diese Aktion steht in der Windows-App zur Verfügung.');
 }
 function configure(id){setAgentDraft({id,...data.agents[id]});navigate('agent');}
 function toggle(id){const a=data.agents[id];if(['ready','active','busy'].includes(a.state))call('disconnectAgent',{agent:id});else if(a.alias&&a.root.startsWith('/'))call('connectAgent',{agent:id});else configure(id);}
 const titles={home:'Pi Relay',keys:'SSH-Schlüssel',settings:'Einstellungen',screen:'Pi-Bildschirm',external:'Externer Viewer',events:'Verlauf',agent:names[agentDraft?.id]+'-Zugang'};
 const parentView=view==='events'?'settings':view==='external'?'screen':'home';const closeView=()=>navigate(parentView);
 function sessionRow(p,index,backup=false){const hasSwitch=!backup&&index===0&&backupProfiles.length>0;return <div className={'session '+(p.alias===profile?.alias?'current':'')+(backup?' backup-session':'')+(hasSwitch?' has-backup':'')} key={p.alias}>
  <span className={'session-line '+(index===0&&!backup?'first':'')+(backup?' backup-route':'')+(p.state==='connected'?' live':'')}/>
  {hasSwitch&&<span className={'backup-route-stub'+(backupProfiles.some(b=>b.state==='connected')?' live':'')} aria-hidden="true"/>}
  {!backup&&index===0&&backupProfiles.length>0&&<button className="backup-toggle" aria-label={backupOpen?'Ersatzzugang einklappen':'Ersatzzugang ausklappen'} aria-expanded={backupOpen} aria-controls="backup-accesses" title={backupOpen?'Ersatzzugang Ersatzzugang einklappen':'Ersatzzugang Ersatzzugang ausklappen'} onClick={()=>setBackupOpen(open=>!open)}>{backupOpen?<Minus size={11} weight="bold"/>:<Plus size={11} weight="bold"/>}</button>}
  <button className="session-connect" disabled={p.state==='waiting'} onClick={()=>{setSelected(p.alias);call('connectProfile',{alias:p.alias});}} aria-label={p.alias+(p.state==='connected'?' verbunden':' verbinden')}>
   <span className="session-copy"><strong>{p.alias}</strong>{!backup&&index===0&&<span id="connection-help" className={'session-help'+(help?' visible':'')}>Klick verbindet · Bildschirm · Terminal</span>}</span>
  </button>
  {['key','connecting','waiting'].includes(p.state)&&<span className="waiting-dot"/>}
  <button className={'screen-quick'+(data.screens?.includes(p.alias)?' open':'')} title={(data.screens?.includes(p.alias)?'Pi-Bildschirm von ':'Pi-Bildschirm über ')+p.alias+(data.screens?.includes(p.alias)?' anzeigen':' öffnen'+(p.state==='connected'?'':' (verbindet zuerst)'))} aria-label={p.alias+' Pi-Bildschirm öffnen'} onClick={()=>{setSelected(p.alias);call('connectScreen',{alias:p.alias});}}><Monitor size={25}/></button>
  <TerminalAction alias={p.alias} connected={p.state==='connected'} onOpen={()=>call('connectTerminal',{alias:p.alias})}/>
  {p.state==='connected'&&<button className="session-disconnect" title={p.alias+' trennen (auch Agenten und Bildschirm)'} aria-label={p.alias+' trennen'} onClick={()=>call('disconnectProfile',{alias:p.alias})}><X size={16}/></button>}
 </div>;}
 return <main className={native?'native-stage':'desktop-stage'} data-motion={data.settings.motion} data-visible={visible}>
  {!native&&<div className="preview-label">{designMode?'B2 · Designzustand':'B2 · Interaktive Vorschau'}<span>Verbindungen werden hier nicht gestartet</span></div>}
  <div className="panel-viewport" data-collapsing={collapsing} style={{height:panelHeight+'px'}}>
   <section className="relay" aria-label="Pi Relay" data-testid="relay-panel">
    <div className="ambient-gradient" aria-hidden="true"/>
    {/* While a login runs (Windows asks for the security key), the panel steps back in the tone of that Windows
        dialog. "Ask again" ends a hanging attempt and starts a fresh one; "Cancel" just ends it. */}
    {(()=>{const login=data.profiles.find(p=>['key','connecting'].includes(p.state));return <div className={'key-veil '+(data.windowsTheme==='light'?'light':'dark')+(login?' show':'')} role="status" aria-hidden={!login}><span className="key-veil-icon"><Key size={30}/></span><strong>Bestätige deinen Sicherheitsschlüssel</strong><span>im Windows-Fenster</span>{login&&<span className="key-veil-actions"><button onClick={()=>call('connectProfile',{alias:login.alias})}>Neu anfragen</button><button onClick={()=>call('cancelLogin')}>Abbrechen</button></span>}</div>;})()}
    <div className="panel-content">
     <header className="app-header" onMouseDown={e=>{if(e.button===0&&native&&e.target.closest('button')===null)request('drag');}}>
      <div className="brand">
       {view==='home'?<Asset name="raspberry" alt="Raspberry Pi"/>:view==='keys'?<Asset name="key-profile" className="key-profile-icon" alt=""/>:view==='screen'||view==='external'?<ScreenIcon size={32} external={view==='external'||useExternal} server={piServer}/>:view==='agent'?<LookingAvatar id={agentDraft.id} src={userIcon(data.icons,agentDraft.id)} className="header-avatar" motion={data.settings.motion&&visible}/>:view==='settings'?<GearSix size={36}/>:<ArrowClockwise size={34}/>}
       <div><h1 ref={heading} tabIndex={-1}>{titles[view]}</h1><span>{view==='home'?(native?'MANAGEMENTZENTRALE':'ENTWURF · BEISPIELSTATUS'):view==='keys'?'DEINE ZUGÄNGE. DEINE SCHLÜSSEL.':view==='screen'?'DEIN DESKTOP. GEMEINSAM VERBUNDEN.':view==='external'?'DEIN RÜCKFALL. DEINE WAHL.':view==='settings'?'SO WIE ES ZU DIR PASST.':view==='agent'?'DEIN PI. DEINE FREIGABE.':'WAS ZULETZT PASSIERT IST.'}</span></div>
      </div>
      <div className="window-actions">
       {view==='home'?<><button className="icon-button quiet" aria-label="In den Infobereich minimieren" onClick={collapse}><CaretDown size={18}/></button><button className="icon-button screen-button" aria-label="Pi-Bildschirm öffnen" title={useExternal?'Pi-Bildschirm · externer VNC Viewer':'Pi-Bildschirm · '+(piServer?piServer+' auf dem Pi, angezeigt mit noVNC':'integrierter Viewer (noVNC)')} onClick={()=>navigate('screen')}><ScreenIcon external={useExternal} server={piServer}/></button><button className="icon-button" aria-label="Einstellungen" onClick={()=>navigate('settings')}><GearSix size={22}/></button></>:<>{view==='keys'&&<><button className="icon-button" title="SSH-Ordner öffnen" aria-label="SSH-Ordner öffnen" onClick={()=>call('openKeyFolder')}><FolderOpen size={21}/></button><button className="icon-button" title="Schlüssel zuordnen" aria-label="Schlüssel zuordnen" onClick={()=>call('addKey')}><Plus size={21}/></button></>}{view==='settings'&&<LanguageSwitch value={data.settings.language==='en'?'en':'de'} onChange={language=>{setLanguage(language);call('saveSettings',{settings:{language}});}}/>}{view!=='keys'&&<button className="icon-button close-view" aria-label={titles[view]+' schließen'} onClick={closeView}><X size={21}/></button>}</>}
      </div>
     </header>
     <div ref={body} className={'view-body view-'+view} key={view}>
      {view==='home'&&<>
    {new Set(data.profiles.map(p=>p.hostname)).size>1&&<select className="device-picker" aria-label="Pi auswählen" value={profile?.hostname} onChange={e=>setSelected(data.profiles.find(p=>p.hostname===e.target.value)?.alias)}>{Array.from(new Set(data.profiles.map(p=>p.hostname))).map(host=><option key={host}>{host}</option>)}</select>}
    <div className={'device'+(offline?' offline':'')}><IconSlot slot="device" custom={userIcon(data.icons,'device')} call={call}><Asset name="argon-case" src={userIcon(data.icons,'device')} className="case-image" alt="Raspberry Pi"/></IconSlot><div className="device-copy"><div className="device-title" ref={titleRow}><h2 className={!connected&&profile?'connect-title':undefined} title={!connected&&profile?'Mit '+profile.alias+' verbinden':undefined} onClick={!connected&&profile?()=>{setSelected(profile.alias);call('connectProfile',{alias:profile.alias});}:undefined}>{boardName(facts?.model)}{new Set(data.profiles.map(p=>p.hostname)).size>1&&profile?' · '+profile.alias:''}</h2>{offline?<span className="spec-chip muted">nicht erreichbar</span>:(()=>{const ram=ramLabel(facts?.memoryBytes),drive=storageLabel(facts?.storageBytes,facts?.storageKind);return ram&&drive?<SpecFlip front={drive} back={ram}/>:(ram||drive)?<span className="spec-chip"><SpecText text={ram||drive}/></span>:null;})()}</div><HostAddress host={profile?.hostname} help={help} onSave={to=>call('setHost',{from:profile.hostname,to})}/>{connected?<span className="device-state connected"><i/>Verbunden</span>
     :waitingProfile?<button className="device-state connectable waiting" title="Warten abbrechen" onClick={()=>call('cancelWait',{alias:waitingProfile.alias})}><i/><span className="state-swap"><span className="state-rest">Wartet auf den Pi …</span><span className="state-hover" aria-hidden="true">Abbrechen</span></span></button>
     :connecting?<button className="device-state connecting connectable" title="Anmeldung neu anfragen" onClick={()=>{setSelected(profile.alias);call('connectProfile',{alias:profile.alias});}}><i/><span className="state-swap"><span className="state-rest">{keyPrompt?'Schlüssel bestätigen …':'Verbinden …'}</span><span className="state-hover" aria-hidden="true">Neu anfragen</span></span></button>
     :<button className={'device-state connectable'+(offline?' offline':'')} disabled={!profile} title={'Mit '+(profile?.alias||'dem Pi')+' verbinden'} onClick={()=>{setSelected(profile.alias);call('connectProfile',{alias:profile.alias});}}><i/><span className="state-swap"><span className="state-rest">{offline?'Aus oder nicht im Netz':'Getrennt'}</span><span className="state-hover" aria-hidden="true">Verbinden</span></span></button>}</div><button className="device-info" aria-label="Verbindungshilfe anzeigen" aria-describedby="connection-help" aria-expanded={help} onPointerEnter={()=>setHelp(true)} onPointerLeave={()=>setHelp(false)} onFocus={()=>setHelp(true)} onBlur={()=>setHelp(false)} onClick={()=>setHelp(true)}><Info size={20}/></button></div>
    <div className={'sessions'+(backupOpen?' backup-open':'')} aria-label="SSH-Zugänge">{primaryProfiles.map((p,index)=>sessionRow(p,index))}<div id="backup-accesses" className={'backup-accesses '+(backupOpen?'expanded':'')} inert={!backupOpen} aria-hidden={!backupOpen}><div>{backupProfiles.map((p,index)=>sessionRow(p,index,true))}</div></div></div>
    
       <div className="agents-strip">{['codex','claude'].map(id=><Companion key={id} id={id} agent={data.agents[id]} motion={data.settings.motion&&visible} onConfigure={()=>configure(id)} onToggle={()=>toggle(id)} icon={userIcon(data.icons,id)} call={call}/>)}</div>
      </>}
   {view==='settings'&&<><div className="setting"><div><strong>Mit Windows starten</strong><p>Pi Relay beim Anmelden im Infobereich öffnen.</p></div><input aria-label="Mit Windows starten" type="checkbox" checked={data.settings.autostart} onChange={e=>call('saveSettings',{settings:{autostart:e.target.checked}})}/></div><div className="setting clipboard-setting"><div><strong>Animationen</strong><p>Farbverläufe, Figuren, Ein- und Ausklappen.</p></div><span className="clipboard-switches"><label><span>Bewegung</span><input aria-label="Bewegung der Figuren" type="checkbox" checked={data.settings.motion} onChange={e=>call('saveSettings',{settings:{motion:e.target.checked}})}/></label><label title="Zeigt im Pi-Bildschirm, wie viele Bilder pro Sekunde ankommen"><span>FPS im Bild</span><input aria-label="FPS-Anzeige im Pi-Bildschirm" type="checkbox" checked={Boolean(data.settings.showFps)} onChange={e=>call('saveSettings',{settings:{showFps:e.target.checked}})}/></label></span></div><div className="setting clipboard-setting" title="Pi → Windows: nur Text, nur solange das Bildschirmfenster vorne ist. Windows → Pi: beim Wechsel ins Fenster, nie Inhalte, die ein Passwortmanager als vertraulich markiert. „An Pi“ geht immer."><div><strong>Zwischenablage</strong><p>Vom Pi nur, solange das Bildschirmfenster vorne ist.</p></div><span className="clipboard-switches"><label><span>Pi → Windows</span><input aria-label="Text vom Pi übernehmen" type="checkbox" checked={data.settings.clipboardFromPi!==false} onChange={e=>call('saveSettings',{settings:{clipboardFromPi:e.target.checked}})}/></label><label><span>Windows → Pi</span><input aria-label="Windows-Text an den Pi geben" type="checkbox" checked={data.settings.clipboardToPi!==false} onChange={e=>call('saveSettings',{settings:{clipboardToPi:e.target.checked}})}/></label></span></div><div className="setting"><div><strong>SSH-Profile</strong><p>Vorhandene Host-Aliase aus deiner SSH-Konfiguration.</p></div><button className="small-button" onClick={()=>call('openConfig')}><ArrowSquareOut size={17}/>Öffnen</button></div></>}
   {view==='keys'&&<><p className="dialog-description">Private Schlüssel bleiben an ihrem Speicherort. Hier siehst du nur Zuordnung und öffentliche Fingerabdrücke.</p><div className="key-list">{data.keys.length?data.keys.map(k=><div className="key-row" key={k.path}><Key size={22}/><div><strong>{k.name}</strong><span>{k.type}</span><code>{k.fingerprint}</code></div><button className="icon-button" aria-label={'Öffentlichen Schlüssel '+k.name+' kopieren'} onClick={()=>call('copyKey',{path:k.path})}><Copy size={18}/></button></div>):<div className="empty-state"><Key size={28}/><strong>{native?'Keine öffentlichen Schlüssel gefunden':'Schlüssel werden in der Windows-App eingelesen'}</strong><p>Vorhandene .pub-Dateien werden angezeigt, ohne private Schlüssel zu lesen.</p></div>}</div></>}

   {view==='agent'&&agentDraft&&<><p className="dialog-description">Wähle einen SSH-Zugang und einen Unterordner als Projektordner. Ein bereits verbundener Zugang wird mitgenutzt.</p><label className="field">SSH-Zugang<select value={agentDraft.alias} onChange={e=>setAgentDraft(a=>({...a,alias:e.target.value}))}><option value="">Zugang wählen</option>{data.profiles.map(p=><option key={p.alias} value={p.alias}>{p.alias} · {p.user}@{p.hostname}</option>)}</select></label><label className="field">Projektordner auf dem Pi<input value={agentDraft.root} placeholder={agentHome+'/Projekte'} aria-invalid={rootBlocked} onChange={e=>setAgentDraft(a=>({...a,root:e.target.value}))}/>{rootBlocked&&<small className="field-hint">{rootReason} Bitte einen Unterordner wählen, z. B. {agentHome}/Projekte.</small>}</label><label className="permission"><input type="checkbox" checked={agentDraft.allowWrite} onChange={e=>setAgentDraft(a=>({...a,allowWrite:e.target.checked}))}/><span><strong>Dateien ändern erlauben</strong><small>Nur im Projektordner. Versteckte und ausführbare Dateien nur zusammen mit Befehlen.</small></span></label><label className="permission"><input type="checkbox" checked={agentDraft.allowCommands} onChange={e=>setAgentDraft(a=>({...a,allowCommands:e.target.checked}))}/><span><strong>Befehle ausführen erlauben</strong><small>Befehle haben die Rechte des gewählten Pi-Benutzers. Der Projektordner ist dafür keine Sandbox.</small></span></label><div className="dialog-actions"><button className="primary-action compact" disabled={!agentDraft.alias||!agentDraft.root.startsWith('/')||rootBlocked} onClick={()=>{const {id,state,...config}=agentDraft;call('saveAgent',{agent:id,config});call('connectAgent',{agent:id});navigate('home');}}><Plug size={18}/>{data.profiles.find(p=>p.alias===agentDraft.alias)?.state==='connected'?'Zugriff freigeben':'Verbinden & freigeben'}</button><button className="small-button" onClick={()=>call('disconnectAgent',{agent:agentDraft.id})}><Pause size={17}/>Zugriff beenden</button></div><div className="mcp-line"><span>MCP-Anbindung</span><button className="small-button" onClick={()=>call('copyMcp',{agent:agentDraft.id})}><Copy size={16}/>{copied===agentDraft.id?'Kopiert':'MCP-Konfiguration kopieren'}</button></div><p className="muted-note">Die MCP-Brücke nutzt diesen Zugang. Den separaten SSH-Zugang im Agent-Client deaktiviert lassen.</p></>}

   {view==='screen'&&<><button className="primary-action screen-connect" disabled={!profile||(useExternal&&!viewerReady)} onClick={()=>call('connectScreen',{alias:profile.alias})}><Monitor size={20}/>{!useExternal&&screenOpen?'Bildschirm anzeigen':'Bildschirm öffnen'}</button>
    <div className="screen-access-row"><label htmlFor="screen-ssh-access">SSH-Zugang</label><select id="screen-ssh-access" value={profile?.alias||''} onChange={e=>setSelected(e.target.value)}>{data.profiles.map(p=><option key={p.alias} value={p.alias}>{p.alias}</option>)}</select><button className="icon-button screen-access-info" aria-label="SSH-Zugang erklären" aria-expanded={help} aria-controls="screen-access-help" onClick={showHelp}><Info size={19}/></button></div>
    {help&&<p id="screen-access-help" className="dialog-description screen-access-help" role="status">Nutzt die bestehende Verbindung von {profile?.alias||'MeinPi'}. Ist der Zugang getrennt, bestätigst du zuerst deinen Sicherheitsschlüssel.{useExternal?'':' Der integrierte Viewer braucht weder RealVNC noch ein Konto; verlangt der Pi eine VNC-Anmeldung, fragt das Fenster danach.'}</p>}
    <div className={'screen-chain'+(connected?' live':'')}>
    {useExternal?<section className="viewer-card external-summary" aria-label="Externer Viewer">
     <div className="viewer-current"><div><strong>{externalName}</strong><span className={viewerReady?'viewer-installed':''}>{viewerReady?'aktiv · externe Anwendung':'noch nicht eingerichtet'}</span></div>{v.installed&&data.settings.managedViewer!==false&&<code>{v.installed}</code>}</div>
     <p className="muted-note">{!viewerReady?'Unter „Externer Viewer“ einrichten oder wieder auf den integrierten Viewer umschalten.':externalUpdate?<><span className="external-update">Neue Version {v.latest}</span> Unter „Externer Viewer“ aktualisieren.</>:'Bildschirm öffnen startet diesen Viewer über den bestehenden SSH-Zugang.'}</p>
    </section>:<IntegratedViewerPanel info={data.integrated} call={call}/>}
    <VncServerCard info={data.vncServers?.[profile?.hostname]} connected={connected} alias={profile?.alias} call={call}/>
    </div>
   </>}

   {view==='external'&&<>
    <div className="setting viewer-switch"><div><strong id="external-switch-label">Externen Viewer verwenden</strong><p>{useExternal?'„Bildschirm öffnen“ startet '+externalName+'.':'Aus: „Bildschirm öffnen“ nutzt den integrierten Viewer (noVNC).'}</p></div><button className="switch" role="switch" aria-checked={useExternal} aria-labelledby="external-switch-label" onClick={()=>call('saveSettings',{settings:{externalViewer:!useExternal}})}><span/></button></div>
    <p className="muted-note external-scope">RealVNC oder TigerVNC nur auf ausdrücklichen Wunsch. Updates hier betreffen nur diese externe Anwendung, nicht den integrierten Viewer und nicht den VNC-Server auf dem Pi.</p>
    <ViewerPanel viewer={v} settings={data.settings} call={call}/>
   </>}

   {view==='events'&&<div className="event-list">{data.events.length?data.events.slice().reverse().map((e,i)=><div className="event" key={i}><span>{e.time}</span><p>{e.message}</p></div>):<p className="dialog-description">Noch keine Ereignisse. Anmeldungen werden nur nach deinem Klick gestartet.</p>}</div>}
     </div>
     {['home','keys','settings','screen'].includes(view)&&<footer className="app-footer">
      {view==='home'||view==='keys'?<><button className={'key-button '+(view==='keys'?'danger':'')} onClick={()=>{navigate(view==='keys'?'home':'keys');if(view!=='keys')call('refresh');}}>{view==='keys'?<X size={21}/>:<Key size={23}/>}{view==='keys'?'Schlüssel schließen':'Schlüssel verwalten'}</button>{view==='home'&&<label className="check-label check-after">Minimiert starten<input type="checkbox" checked={data.settings.minimized} onChange={e=>call('saveSettings',{settings:{minimized:e.target.checked}})}/><span className="check-visual"><Check size={15} weight="bold"/></span></label>}</>:view==='screen'?<button className="key-button subdued external-link" onClick={()=>navigate('external')}>Externer Viewer (Rückfall){externalUpdate&&<span className="external-update">{v.latest}</span>}</button>:view==='settings'?<><button className="key-button subdued" onClick={()=>navigate('events')}><ArrowClockwise size={18}/>Verlauf anzeigen</button><button className="key-button danger" onClick={()=>call('quit')}><Power size={18}/>Pi Relay beenden</button></>:<button className="key-button subdued" onClick={closeView}><X size={18}/>{view==='events'?'Zurück zu Einstellungen':titles[view]+' schließen'}</button>}
     </footer>}
    </div>
   </section>
   <div className="collapse-slot" aria-hidden="true"/>
  </div>
  {!native&&<div className="preview-tray"><Asset name="raspberry" alt="Pi Relay im Infobereich"/><span className="tray-dots"><i className="codex"/><i className="claude"/></span></div>}
  {notice&&<div className="notice" role="status"><span>{notice}</span><button aria-label="Meldung schließen" onClick={()=>setNotice('')}><X size={16}/></button></div>}
 </main>;
}
