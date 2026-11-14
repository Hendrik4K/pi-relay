import { useState } from 'react';
import { ArrowClockwise, Hammer, Power } from '@phosphor-icons/react';

// The integrated viewer is updated only as a new, tested Pi Relay build: this panel shows the
// bundled noVNC version, offers that build and activates it; it never downloads viewer code.
export function IntegratedViewerPanel({info:i,call}) {
 const [confirming,setConfirming]=useState(false);
 if(!i)return null;
 const offer=i.updateAvailable&&!i.skipped&&!i.staged;
 const status=i.busy?'Suche nach Updates …':i.skipped?'noVNC '+i.latest+' übersprungen':i.latest&&!i.updateAvailable&&!i.error?'Auf dem neuesten Stand':i.lastChecked?'Zuletzt geprüft: '+new Date(i.lastChecked).toLocaleDateString('de-DE'):'Noch nicht auf Updates geprüft';
 function activate(){if(i.sshActive&&!confirming){setConfirming(true);return;}setConfirming(false);call('activateIntegratedViewer',{confirm:i.sshActive});}
 return <section className="viewer-card integrated-card" aria-label="Integrierter Viewer">
  <div className="viewer-current"><div><strong>Integrierter Viewer</strong><span>Teil von Pi Relay {i.appVersion}<span className="integrated-extra"> · ohne RealVNC und Konto</span></span></div><code>noVNC {i.installed||'–'}</code></div>
  {i.staged?<div className="integrated-staged">
   <p><strong>Pi Relay {i.staged.appVersion}</strong> mit noVNC {i.staged.noVnc} ist gebaut und vollständig geprüft.</p>
   {confirming?<div className="integrated-confirm" role="alert"><p>Pi Relay startet dafür neu. Dabei enden die SSH-Verbindung, Terminal, Bildschirm und Agentenfreigaben. Danach bestätigst du den Sicherheitsschlüssel neu.</p><div><button className="small-button update-install" onClick={activate}><Power size={15}/>Neu starten &amp; aktivieren</button><button className="skip-version" onClick={()=>setConfirming(false)}>Abbrechen</button></div></div>
   :<button className="small-button update-install" onClick={activate}><Power size={15}/>Jetzt aktivieren</button>}
  </div>
  :offer?<div className="viewer-update-offer"><div className="new-version"><span>Neue noVNC-Version</span><strong className="new-version-number">{i.latest}</strong><small>{i.canBuild?'Wird als neue Pi-Relay-Version gebaut und geprüft':'Kommt mit dem nächsten Pi-Relay-Installer'}</small></div>
   <div className="viewer-update-choices">{i.canBuild&&<button className="small-button update-install" disabled={i.building} onClick={()=>call('buildIntegratedViewer',{version:i.latest})}><Hammer size={16}/>{i.building?'Build läuft …':'Update bauen'}</button>}<button className="skip-version" disabled={i.building} onClick={()=>call('skipIntegratedViewer',{version:i.latest})}>Diese Version überspringen</button></div></div>
  :<div className="viewer-update-state"><span role="status">{status}</span><button className="small-button" disabled={i.busy||i.building} onClick={()=>call('checkIntegratedViewer')}><ArrowClockwise size={15}/>Auf Updates prüfen</button></div>}
  {i.building&&<p className="muted-note" role="status">Das PowerShell-Fenster baut Pi Relay mit der neuen noVNC-Version und führt alle Prüfungen aus. Die laufende App bleibt unverändert.</p>}
  {i.skipped&&!i.staged&&<button className="restore-update" onClick={()=>call('restoreIntegratedViewer')}>Übersprungenes Update wieder anzeigen</button>}
  {i.error&&<p className="viewer-error" role="status">{i.error}</p>}
 </section>;
}
