import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Hammer, Power } from '@phosphor-icons/react';

// The integrated viewer is updated only as a new, tested Pi Relay build: this panel shows the
// bundled noVNC version, offers that build and activates it; it never downloads viewer code.
export function IntegratedViewerPanel({info:i,call}) {
 const [confirming,setConfirming]=useState(false),[result,setResult]=useState(''),pending=useRef(false),seen=useRef(i?.lastChecked);
 // After a manual check: "Auf dem neuesten Stand" replaces the subtitle for a moment and the version flashes green.
 useEffect(()=>{if(!i||i.busy||!pending.current||i.lastChecked===seen.current)return;pending.current=false;seen.current=i.lastChecked;
  const ok=!i.error&&!i.updateAvailable;setResult(ok?'current':'');if(!ok)return;const t=setTimeout(()=>setResult(''),3200);return()=>clearTimeout(t);},[i?.busy,i?.lastChecked,i?.error,i?.updateAvailable]);
 if(!i)return null;
 function check(){pending.current=true;seen.current=i.lastChecked;setResult('');call('checkIntegratedViewer');}
 const offer=i.updateAvailable&&!i.skipped&&!i.staged;
 const status=i.busy?'Suche nach Updates …':i.skipped?'noVNC '+i.latest+' übersprungen':i.latest&&!i.updateAvailable&&!i.error?'Auf dem neuesten Stand':i.lastChecked?'Zuletzt geprüft: '+new Date(i.lastChecked).toLocaleDateString('de-DE'):'Noch nicht auf Updates geprüft';
 function activate(){if(i.sshActive&&!confirming){setConfirming(true);return;}setConfirming(false);call('activateIntegratedViewer',{confirm:i.sshActive});}
 return <section className="viewer-card integrated-card" aria-label="Integrierter Viewer">
  <div className="viewer-current"><div><strong>Integrierter Viewer</strong><span role="status" className={result==='current'?'viewer-current-ok':''}>{i.busy?'Suche nach Updates …':result==='current'?'Auf dem neuesten Stand':<>Teil von Pi Relay {i.appVersion}<span className="integrated-extra"> · ohne RealVNC und Konto</span></>}</span></div><div className="vnc-version"><code className={result==='current'?'version-flash':''}>noVNC {i.installed||'–'}</code><button className={'icon-button viewer-recheck'+(i.busy?' spinning':'')} disabled={i.busy||i.building} aria-label="Auf Updates prüfen" title={status} onClick={check}><ArrowClockwise size={15}/></button></div></div>
  {i.staged?<div className="integrated-staged">
   <p><strong>Pi Relay {i.staged.appVersion}</strong> mit noVNC {i.staged.noVnc} ist gebaut und vollständig geprüft.</p>
   {confirming?<div className="integrated-confirm" role="alert"><p>Pi Relay startet dafür neu. Dabei enden die SSH-Verbindung, Terminal, Bildschirm und Agentenfreigaben. Danach bestätigst du den Sicherheitsschlüssel neu.</p><div><button className="small-button update-install" onClick={activate}><Power size={15}/>Neu starten &amp; aktivieren</button><button className="skip-version" onClick={()=>setConfirming(false)}>Abbrechen</button></div></div>
   :<button className="small-button update-install" onClick={activate}><Power size={15}/>Jetzt aktivieren</button>}
  </div>
  :offer?<div className="viewer-update-offer"><div className="new-version"><span>Neue noVNC-Version</span><strong className="new-version-number">{i.latest}</strong><small>{i.canBuild?'Wird als neue Pi-Relay-Version gebaut und geprüft':'Kommt mit dem nächsten Pi-Relay-Installer'}</small></div>
   <div className="viewer-update-choices">{i.canBuild&&<button className="small-button update-install" disabled={i.building} onClick={()=>call('buildIntegratedViewer',{version:i.latest})}><Hammer size={16}/>{i.building?'Build läuft …':'Update bauen'}</button>}<button className="skip-version" disabled={i.building} onClick={()=>call('skipIntegratedViewer',{version:i.latest})}>Diese Version überspringen</button></div></div>
  :null}
  {i.building&&<p className="muted-note" role="status">Das PowerShell-Fenster baut Pi Relay mit der neuen noVNC-Version und führt alle Prüfungen aus. Die laufende App bleibt unverändert.</p>}
  {i.skipped&&!i.staged&&<button className="restore-update" onClick={()=>call('restoreIntegratedViewer')}>Übersprungenes Update wieder anzeigen</button>}
  {i.error&&<p className="viewer-error" role="status">{i.error}</p>}
 </section>;
}

// The sender on the Pi (x11vnc or WayVNC). Updates come from Raspberry Pi OS (apt), never from
// Pi Relay: the card only reads version, apt's offer and the listen scope, and offers the command.
const debianVersion=v=>(v||'').replace(/^\d+:/,'').replace(/-[^-]*$/,'');
export function VncServerCard({info,connected,alias,call}) {
 const [copied,setCopied]=useState(false),[checking,setChecking]=useState(false),[result,setResult]=useState(''),seen=useRef(info?.checkedAt);
 // A manual check spins the icon; the fresh result shows in place of the subtitle and the version flashes.
 useEffect(()=>{if(!checking||!info?.checkedAt||info.checkedAt===seen.current)return;seen.current=info.checkedAt;setChecking(false);setResult(info.update?'update':'current');
  const t=setTimeout(()=>setResult(''),3200);return()=>clearTimeout(t);},[info?.checkedAt,checking]);
 useEffect(()=>{if(!checking)return;const t=setTimeout(()=>setChecking(false),12000);return()=>clearTimeout(t);},[checking]);
 function check(){seen.current=info?.checkedAt;setResult('');setChecking(true);call('checkVncServer',{alias});}
 const command=info?.package?'sudo apt update && sudo apt install --only-upgrade '+info.package:'';
 const scope=!info?(connected?'Wird geprüft …':'Verbinden, um den Sender zu sehen'):!info.server?'Kein VNC-Server aktiv':info.localOnly?'Nur lokal · über SSH geschützt':'Achtung: lauscht im Netzwerk';
 const state=!info?.server?'':info.update?'':info.installed?' · aktuell':'';
 function copy(){try{navigator.clipboard?.writeText(command);setCopied(true);setTimeout(()=>setCopied(false),2000);}catch{}}
 return <section className="viewer-card vnc-server-card" aria-label="VNC-Server auf dem Pi">
  <div className="viewer-current"><div><strong>VNC-Server auf dem Pi</strong><span role="status" className={result==='current'?'viewer-current-ok':info?.server&&!info.localOnly?'vnc-scope-warning':''} title={(info?.addresses?.length?'Lauscht auf '+info.addresses.join(', ')+' Port 5900. ':'')+'Updates kommen über Raspberry Pi OS (apt); Stand der Paketlisten auf dem Pi.'}>{checking?'Suche nach Updates …':result==='current'?'Auf dem neuesten Stand':result==='update'?<>Update verfügbar: <strong className="vnc-candidate">{debianVersion(info.candidate)}</strong></>:<>{scope}{state}{info?.update&&<> · Update: <strong className="vnc-candidate">{debianVersion(info.candidate)}</strong></>}</>}</span></div>
   <div className="vnc-version"><code className={result==='current'?'version-flash':''} title={info?.installed?'Paket '+info.package+' '+info.installed:''}>{info?.server?info.server+' '+debianVersion(info.installed):'–'}</code><button className={'icon-button vnc-recheck'+(checking?' spinning':'')} disabled={!connected||checking} aria-label="VNC-Server erneut prüfen" title="Auf Updates prüfen" onClick={check}><ArrowClockwise size={15}/></button></div></div>
  {info?.update&&<div className="vnc-update-command"><code>{command}</code><button className="small-button" onClick={copy}>{copied?'Kopiert':'Kopieren'}</button></div>}
 </section>;
}
