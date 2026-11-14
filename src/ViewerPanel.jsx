import { useState } from 'react';
import { ArrowClockwise, ArrowSquareOut } from '@phosphor-icons/react';

export function ViewerPanel({viewer:v,settings,call}) {
 const [classicUpdate,setClassicUpdate]=useState(false);
 const managed=settings.managedViewer!==false;
 const name=v.provider==='realvnc-classic'?'RealVNC Classic':'TigerVNC';
 const offer=managed&&v.installed&&v.updateAvailable&&!v.skipped&&!v.pending;
 const current=Boolean(v.installed&&v.latest===v.installed&&!v.error);
 const status=v.busy?(v.phase==='checking'?'Suche nach Updates …':'Viewer wird vorbereitet …'):v.pending?'Version '+v.pending+' bereit · Viewer zum Aktivieren schließen':v.error?'Prüfung nicht abgeschlossen':v.skipped?'Version '+v.latest+' übersprungen':current?'Auf dem neuesten Stand':v.lastChecked?'Zuletzt geprüft: '+new Date(v.lastChecked).toLocaleDateString('de-DE'):'Noch nicht auf Updates geprüft';
 function update(){if(v.provider==='realvnc-classic'){setClassicUpdate(true);call('openViewerDownload');}else call('installViewer');}
 return <>
  <section className="viewer-card update-panel" aria-label="Viewer-Verwaltung">
   <div className="viewer-current"><div><strong>{managed?(v.installed?name:'Viewer einrichten'):'Eigener Viewer'}</strong><span className={managed&&v.installed?'viewer-installed':''}>{managed?(v.installed?'installiert':'Einmal einrichten, danach direkt verbinden'):'Manuell ausgewählte Anwendung'}</span></div>{managed&&v.installed&&<code>{v.installed}</code>}</div>
   {managed&&!v.installed&&<><button className="primary-action compact viewer-setup" disabled={v.busy} onClick={()=>call('installViewer')}><ArrowClockwise size={17}/>Viewer automatisch einrichten</button><p className="muted-note">Pi Relay lädt den portablen TigerVNC Viewer herunter und verwaltet ihn für dich.</p></>}
   {offer&&<div className="viewer-update-offer"><div className="new-version"><span>Neue Version</span><strong className="new-version-number">{v.latest}</strong>{v.provider==='realvnc-classic'&&<small>Hersteller-Download erforderlich</small>}</div><div className="viewer-update-choices"><button className="small-button update-install" disabled={v.busy} onClick={update}><ArrowClockwise size={16}/>Aktualisieren</button><button className="skip-version" disabled={v.busy} onClick={()=>{setClassicUpdate(false);call('skipViewerUpdate',{provider:v.provider,version:v.latest});}}>Diese Version überspringen</button></div></div>}
   {managed&&v.installed&&!offer&&<div className="viewer-update-state"><span role="status">{status}</span>{!v.pending&&<button className="small-button" disabled={v.busy} onClick={()=>call('checkViewerUpdate')}><ArrowClockwise size={15}/>Auf Updates prüfen</button>}</div>}
   {v.skipped&&managed&&<button className="restore-update" disabled={v.busy} onClick={()=>call('restoreViewerUpdate')}>Übersprungenes Update wieder anzeigen</button>}
   {managed&&v.busy&&(offer||!v.installed)&&<p className="muted-note" role="status">{status}</p>}
   {v.error&&<p className="viewer-error" role="status">{v.error}</p>}
   {offer&&classicUpdate&&v.provider==='realvnc-classic'&&<div className="classic-update-flow"><strong>RealVNC Classic aktualisieren</strong><p>RealVNC stellt aktuelle Classic-Downloads im Premium-/Enterprise-Konto bereit. Lade dort die portable EXE herunter und übernimm sie anschließend hier. Deine bisherige Version bleibt erhalten.</p><div><button className="small-button" onClick={()=>call('openViewerDownload')}><ArrowSquareOut size={15}/>Hersteller-Download öffnen</button><button className="small-button" onClick={()=>call('importRealVnc')}>Heruntergeladene Datei übernehmen</button><button className="skip-version" onClick={()=>setClassicUpdate(false)}>Abbrechen</button></div></div>}
  </section>
  <details className="viewer-advanced"><summary>Weitere Viewer-Optionen</summary><p className="muted-note">Nur für einen eigenen installierten Viewer oder einen bewussten Wechsel. Die Dateiauswahl erwartet eine EXE, keinen Ordner.</p><div className="viewer-advanced-actions"><button className="small-button" disabled={v.busy} onClick={()=>call('pickVncViewer')}>Eigene Viewer-Datei auswählen</button>{v.provider!=='realvnc-classic'&&<button className="small-button" disabled={v.busy} onClick={()=>call('importRealVnc')}>Vorhandenen RealVNC Classic übernehmen</button>}{v.provider!=='tigervnc'&&v.installed&&<button className="small-button" disabled={v.busy} onClick={()=>call('installViewer')}>Zu TigerVNC wechseln</button>}{!managed&&v.ready&&<button className="small-button" onClick={()=>call('useManagedViewer')}>Verwalteten Viewer verwenden</button>}{v.previous&&<button className="small-button" disabled={v.busy} onClick={()=>call('rollbackViewer')}>Vorige Version ({v.previous})</button>}</div></details>
 </>;
}
