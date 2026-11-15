// Exercise native resize/reveal messages with a browser standing in for the host.
const {createRequire}=require('node:module');
const path=require('node:path');
const assert=require('node:assert/strict');
const load=process.env.PI_RELAY_NODE_MODULES?createRequire(path.join(process.env.PI_RELAY_NODE_MODULES,'package.json')):require;
const {chromium}=load('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PI_RELAY_CHROME?{executablePath:process.env.PI_RELAY_CHROME}:{})});
 try{
  const page=await browser.newPage({viewport:{width:520,height:540}});
  await page.exposeFunction('__relayApplySize',async height=>page.setViewportSize({width:520,height}));
  await page.addInitScript(()=>{
   const events=new EventTarget();
   window.__relayMessages=[];
   window.__relaySend=data=>events.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
   window.__relayState={profiles:[{alias:'MeinPi',hostname:'pi.local',state:'disconnected'},{alias:'Ersatzzugang',hostname:'pi.local',state:'disconnected'}],keys:[],settings:{motion:true,minimized:true,autostart:false,managedViewer:true},panel:{visible:true,collapsing:false},agents:{codex:{alias:'',root:'',state:'disconnected'},claude:{alias:'',root:'',state:'disconnected'}},events:[]};
   window.chrome=window.chrome||{};
   window.chrome.webview={
    addEventListener:(...args)=>events.addEventListener(...args),
    removeEventListener:(...args)=>events.removeEventListener(...args),
    postMessage:message=>{window.__relayMessages.push(message);if(message.action==='getState')setTimeout(()=>window.__relaySend({type:'state',data:window.__relayState}),0);if(message.action==='resizePanel'){window.__relayTargetHeight=message.height;window.__relayApplySize(message.height);}}
   };
  });
  await page.goto(process.env.PI_RELAY_QA_URL||'http://127.0.0.1:4173/');
  await page.getByRole('heading',{name:'Pi Relay',exact:true}).waitFor();
  assert.equal(await page.locator('.native-stage').count(),1);
  assert.equal(await page.locator('.brand div>span').first().innerText(),'MANAGEMENTZENTRALE','Home subtitle');
  // Resting on a picture draws the ring for 5 s, then "PNG ändern"; own pictures come from the user icon host and can be reset.
  await page.locator('.device .icon-slot').hover();await page.waitForTimeout(2500);
  assert.equal(await page.locator('.device .icon-slot.arming').count(),1,'Ring draws while hovering');
  assert.equal(await page.locator('.device .icon-slot.shown').count(),0,'Button not shown before 5 s');
  await page.waitForTimeout(2900);
  assert.equal(await page.locator('.device .icon-edit-main').innerText(),'PNG ändern');
  await page.locator('.device .icon-edit-main').click();
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='pickIcon'&&m.slot==='device')),'PNG ändern asks the host for a picture');
  await page.evaluate(()=>{window.__relayState.icons={codex:42};window.__relaySend({type:'state',data:window.__relayState});});
  await page.waitForFunction(()=>document.querySelector('[data-companion=codex] img')?.src.startsWith('https://pi-relay-icons.local/codex.png?v=42'));
  assert.equal(await page.locator('.agent.codex .icon-edit-reset').count(),1,'Own picture offers Standard');
  await page.evaluate(()=>{delete window.__relayState.icons;window.__relaySend({type:'state',data:window.__relayState});});
  await page.mouse.move(5,5);
  // "Getrennt" cross-fades to "Verbinden" on hover and connects the selected access on click.
  const status=page.locator('.device-state.connectable');
  assert.equal(await status.locator('.state-rest').innerText(),'Getrennt');
  assert.equal(await status.locator('.state-hover').evaluate(e=>getComputedStyle(e).opacity),'0');
  await status.hover();await page.waitForTimeout(450);
  assert.equal(await status.locator('.state-hover').evaluate(e=>getComputedStyle(e).opacity),'1','Verbinden fades in');
  assert.equal(await status.locator('.state-rest').evaluate(e=>getComputedStyle(e).opacity),'0');
  await status.click();
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='connectProfile'&&m.alias==='MeinPi')),'Status click connects the selected access');
  await page.mouse.move(5,5);await page.waitForTimeout(450);
  assert.equal(await status.locator('.state-rest').evaluate(e=>getComputedStyle(e).opacity),'1','Getrennt fades back');
  await page.waitForFunction(()=>{const surface=window.__relayMessages.filter(m=>m.action==='surfaceReady').at(-1);return innerHeight===window.__relayTargetHeight&&surface?.height===innerHeight;});
  const box=await page.locator('.panel-viewport').boundingBox();assert(box.height>=300&&box.height<500);assert.equal(box.width,520);
  const surface=await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='surfaceReady').at(-1));
  assert(surface.width===520&&surface.height===box.height&&surface.panelHeight===box.height&&!surface.collapsed,JSON.stringify({box,surface,messages:await page.evaluate(()=>window.__relayMessages.slice(-8))}));
  await page.evaluate(()=>window.__relaySend({type:'collapse',token:11}));
  // Wait for the real end of the slide instead of a fixed delay; a loaded machine renders fewer frames.
  await page.waitForFunction(()=>window.__relayMessages.some(m=>m.action==='hideComplete'),null,{timeout:3000});
  // The mock host does not hide the page, so the slide keeps reporting until it is well underway.
  await page.waitForFunction(()=>window.__relayMessages.some(m=>m.action==='clipPanel'&&m.offset>100),null,{timeout:3000}).catch(()=>{});
  const clipping=await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='clipPanel'));
  assert(clipping.length>=2&&clipping.every(m=>m.token===11)&&clipping.some(m=>m.offset>100),'Renderer sends tokenized native clip frames: '+JSON.stringify(clipping.map(m=>Math.round(m.offset))));
  assert.equal(await page.locator('.relay').evaluate(e=>getComputedStyle(e).opacity),'1','Moving front stays opaque');
  // Fast start, soft end: the first frames cover more ground than the last ones.
  const steps=clipping.map(m=>m.offset).filter((v,i,a)=>i===0||v!==a[i-1]);
  if(steps.length>=8){const q=Math.floor(steps.length/4);assert(steps[q]-steps[0]>steps.at(-1)-steps.at(-1-q),'Collapse decelerates towards the end: '+JSON.stringify(steps.map(Math.round)));}
  await page.evaluate(()=>window.__relaySend({type:'hidden'}));
  await page.evaluate(()=>window.__relaySend({type:'reveal'}));
  await page.waitForTimeout(450);
  assert.equal(await page.locator('.panel-viewport').getAttribute('data-collapsing'),'false');
  assert.equal(await page.locator('.relay').evaluate(e=>new DOMMatrix(getComputedStyle(e).transform).m42),0);
  // A host state snapshot must also recover a missed reveal event.
  await page.evaluate(()=>window.__relaySend({type:'collapse'}));
  await page.waitForTimeout(40);
  const before=await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='hideComplete').length);
  await page.evaluate(()=>window.__relaySend({type:'state',data:window.__relayState}));
  await page.waitForTimeout(450);
  assert.equal(await page.locator('.panel-viewport').getAttribute('data-collapsing'),'false');
  assert.equal(await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='hideComplete').length),before);
  assert.equal(await page.getByRole('button',{name:'Schlüssel verwalten',exact:true}).isVisible(),true);
  // A click during the slide-out reverses it from the current position, eased out, then reports completion.
  const clips=token=>page.evaluate(t=>window.__relayMessages.filter(m=>m.action==='clipPanel'&&m.token===t).map(m=>m.offset),token);
  await page.evaluate(()=>window.__relaySend({type:'collapse',token:21}));
  await page.waitForFunction(()=>window.__relayMessages.some(m=>m.action==='clipPanel'&&m.token===21&&m.offset>40));
  await page.evaluate(()=>window.__relaySend({type:'reveal',token:22,from:'current'}));
  const stoppedAt=(await clips(21)).at(-1);
  await page.waitForFunction(()=>window.__relayMessages.some(m=>m.action==='revealComplete'&&m.token===22),null,{timeout:3000});
  const back=await clips(22);
  assert(back[0]<=stoppedAt+1&&back[0]>stoppedAt*0.6&&back.at(-1)===0,'Reverse continues from the current offset: '+JSON.stringify({stoppedAt,back:back.map(Math.round)}));
  assert(back.every((v,i)=>i===0||v<=back[i-1]+0.01),'Reverse moves monotonically back up');
  assert(!(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='hideComplete'&&m.token===21))),'An interrupted slide-out never reports hidden');
  // Revealing from fully hidden slides up from below instead of appearing at once.
  await page.evaluate(()=>window.__relaySend({type:'collapse',token:23}));
  await page.waitForFunction(()=>window.__relayMessages.some(m=>m.action==='hideComplete'&&m.token===23),null,{timeout:3000});
  await page.evaluate(()=>window.__relaySend({type:'hidden'}));
  await page.evaluate(()=>window.__relaySend({type:'reveal',token:24,from:'hidden'}));
  await page.waitForFunction(()=>window.__relayMessages.some(m=>m.action==='revealComplete'&&m.token===24),null,{timeout:3000});
  const up=await clips(24),height=(await page.locator('.relay').boundingBox()).height;
  assert(up[0]>height*0.85&&up.at(-1)===0&&up.length>4,'Slides in from below: '+JSON.stringify(up.map(Math.round)));
  assert.equal(await page.locator('.relay').evaluate(e=>e.style.transform),'');
  await page.getByRole('button',{name:'Ersatzzugang ausklappen'}).click();
  await page.waitForTimeout(320);
  const expandedHeight=await page.evaluate(()=>innerHeight);assert(expandedHeight>=box.height+45,"Ersatzzugang row adds its height");
  await page.evaluate(()=>{window.__relayState.keys=Array.from({length:30},(_,i)=>({name:'Beispiel '+i,type:'ed25519',fingerprint:'SHA256:example'+i,path:'fixture-'+i+'.pub'}));window.__relaySend({type:'state',data:window.__relayState});});
  await page.getByRole('button',{name:'Schlüssel verwalten',exact:true}).click();
  assert.equal(await page.evaluate(()=>innerHeight),expandedHeight,'Keys preserve the expanded main-menu height');
  const scroll=page.locator('.view-keys');
  assert(await scroll.evaluate(e=>e.scrollHeight>e.clientHeight),'Long key lists scroll inside the panel');
  assert.equal(await page.getByRole('checkbox',{name:'Minimiert starten'}).count(),0);
  await page.locator('.app-header').hover();
  assert(await scroll.evaluate(e=>{const c=getComputedStyle(e).scrollbarColor;return c==='transparent transparent'||c==='rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)';}),'Scrollbar is hidden outside the scrolling area');
  await scroll.hover({position:{x:5,y:5}});
  assert(await scroll.evaluate(e=>getComputedStyle(e).scrollbarColor.includes('118, 68, 95')),'Scrollbar appears on hover');
  await page.evaluate(()=>{window.__relayState.viewer={provider:'realvnc-classic',installed:'7.15.0',latest:'7.18.2',ready:true,updateAvailable:true};window.__relaySend({type:'state',data:window.__relayState});});
  await page.getByRole('button',{name:'Schlüssel schließen',exact:true}).click();
  await page.getByRole('button',{name:'Pi-Bildschirm öffnen',exact:true}).click();
  assert.equal(await page.locator('#screen-access-help').count(),0,'SSH guidance stays hidden until requested');
  const accessParts=await page.locator('.screen-access-row').locator('label,select,button').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y,center:b.y+b.height/2,right:b.right};}));
  assert(accessParts[0].right<accessParts[1].x&&accessParts[1].right<accessParts[2].x&&Math.max(...accessParts.map(p=>p.center))-Math.min(...accessParts.map(p=>p.center))<2,'Access label, dropdown and Info share one row');
  // Screen view: no scrollbar; the external fallback is a footer link to its own subview.
  assert(await page.locator('.view-screen').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'Screen view fits without scrolling');
  assert.equal(await page.locator('.app-footer').getByRole('button').count(),1,'Screen footer holds only the fallback link');
  assert.equal(await page.locator('.external-link .external-update').innerText(),'7.18.2','External update stays discoverable on the footer link');
  assert.equal(await page.locator('.external-link').evaluate(e=>getComputedStyle(e).textDecorationLine),'underline');
  assert.equal(await page.locator('.brand .vnc-badge').innerText(),'noVNC','Header badge shows the integrated viewer');
  await page.getByRole('button',{name:'SSH-Zugang erklären',exact:true}).click();
  await page.locator('#screen-access-help').waitFor();
  assert((await page.locator('#screen-access-help').innerText()).includes('Sicherheitsschlüssel'));
  // A second click on the i closes it right away; it no longer closes by itself.
  await page.waitForTimeout(5600);assert.equal(await page.locator('#screen-access-help').count(),1,'Help stays open until clicked again');
  await page.getByRole('button',{name:'SSH-Zugang erklären',exact:true}).click();
  await page.locator('#screen-access-help').waitFor({state:'detached',timeout:1000});
  assert.equal(await page.getByRole('button',{name:'SSH-Zugang erklären',exact:true}).getAttribute('aria-expanded'),'false');
  await page.getByRole('button',{name:/Externer Viewer \(Rückfall\)/}).click();
  await page.getByRole('heading',{name:'Externer Viewer',exact:true}).waitFor();
  assert.equal(await page.getByRole('switch',{name:'Externen Viewer verwenden'}).getAttribute('aria-checked'),'false');
  assert((await page.locator('.external-scope').innerText()).includes('nicht den integrierten Viewer'),'External updates are clearly scoped');
  const installed=await page.locator('.viewer-installed').boundingBox(),provider=await page.locator('.viewer-current strong').boundingBox(),version=await page.locator('.viewer-current code').boundingBox();
  assert(installed.x>=provider.x+provider.width&&version.x>=installed.x+installed.width&&Math.abs(installed.y-provider.y)<6,'Provider, installed badge and version share one row');
  assert.equal(await page.locator('.viewer-installed').evaluate(e=>getComputedStyle(e).color),'rgb(131, 224, 170)');
  assert.equal(await page.getByRole('button',{name:'Auf Updates prüfen',exact:true}).count(),0);
  assert.equal(await page.locator('.new-version-number').innerText(),'7.18.2');
  assert.equal(await page.locator('.new-version-number').evaluate(e=>getComputedStyle(e).color),'rgb(131, 224, 170)');
  assert.equal(await page.getByRole('button',{name:'Eigene Viewer-Datei auswählen',exact:true}).isVisible(),false);
  await page.getByRole('button',{name:'Aktualisieren',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='openViewerDownload').length),1,'Classic Update immediately requests the manufacturer portal');
  assert.equal(await page.getByRole('button',{name:'Hersteller-Download öffnen',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('button',{name:'Heruntergeladene Datei übernehmen',exact:true}).isVisible(),true);
  await page.getByRole('button',{name:'Diese Version überspringen',exact:true}).click();
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='skipViewerUpdate'&&m.provider==='realvnc-classic'&&m.version==='7.18.2')));
  await page.evaluate(()=>{window.__relayState.viewer.skipped=true;window.__relaySend({type:'state',data:window.__relayState});});
  await page.getByRole('button',{name:'Übersprungenes Update wieder anzeigen',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Aktualisieren',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Auf Updates prüfen',exact:true}).isVisible(),true);
  await page.getByRole('button',{name:'Übersprungenes Update wieder anzeigen',exact:true}).click();
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='restoreViewerUpdate')));
  await page.evaluate(()=>{Object.assign(window.__relayState.viewer,{installed:'7.18.2',latest:'7.18.2',updateAvailable:false,skipped:false});window.__relaySend({type:'state',data:window.__relayState});});
  await page.getByRole('status').filter({hasText:'Auf dem neuesten Stand'}).waitFor();
  assert.equal(await page.getByRole('status').filter({hasText:'Auf dem neuesten Stand'}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Auf Updates prüfen',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('button',{name:'Diese Version überspringen',exact:true}).count(),0);
  await page.evaluate(()=>{window.__relayState.viewer={provider:'',installed:'',latest:null,ready:false};window.__relaySend({type:'state',data:window.__relayState});});
  await page.getByRole('button',{name:'Viewer automatisch einrichten',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Viewer automatisch einrichten',exact:true}).isVisible(),true);
  await page.locator('.viewer-advanced summary').click();
  assert.equal(await page.getByRole('button',{name:'Eigene Viewer-Datei auswählen',exact:true}).isVisible(),true);
  // The switch decides what "Bildschirm öffnen" starts and which badge is shown.
  await page.getByRole('switch',{name:'Externen Viewer verwenden'}).click();
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='saveSettings'&&m.settings.externalViewer===true)));
  await page.evaluate(()=>{window.__relayState.settings={...window.__relayState.settings,externalViewer:true};window.__relaySend({type:'state',data:window.__relayState});});
  await page.locator('[role=switch][aria-checked=true]').waitFor();
  assert.equal(await page.locator('.brand .vnc-badge').innerText(),'VNC');
  await page.keyboard.press('Escape');
  await page.getByRole('heading',{name:'Pi-Bildschirm',exact:true}).waitFor();
  assert.equal(await page.locator('.brand .vnc-badge').innerText(),'VNC','External mode shows the VNC badge');
  assert.equal(await page.getByRole('button',{name:'Bildschirm öffnen',exact:true}).isEnabled(),false,'External mode requires a configured viewer');
  assert((await page.locator('.external-summary').innerText()).includes('noch nicht eingerichtet'));
  await page.evaluate(()=>{window.__relayState.settings={...window.__relayState.settings,externalViewer:false};window.__relaySend({type:'state',data:window.__relayState});});
  await page.locator('.external-summary').waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'Bildschirm öffnen',exact:true}).isEnabled(),true,'Integrated viewer needs no external viewer');
  // Integrated viewer: bundled noVNC version, update only as a tested Pi Relay build.
  const integrated={appVersion:'0.4.0',installed:'1.7.0',latest:'1.7.0',updateAvailable:false,skipped:false,lastChecked:'2026-11-12T05:00:00Z',error:'',busy:false,canBuild:true,building:false,staged:null,sshActive:true};
  const sendIntegrated=patch=>page.evaluate(v=>{window.__relayState.integrated=v;window.__relaySend({type:'state',data:window.__relayState});},{...integrated,...patch});
  await sendIntegrated({});
  await page.locator('.integrated-card').filter({hasText:'noVNC 1.7.0'}).waitFor();
  assert((await page.locator('.integrated-card').innerText()).includes('Teil von Pi Relay 0.4.0'));
  // The refresh icon beside the version checks; when current, the subtitle says so briefly and the version flashes green.
  await page.locator('.integrated-card').getByRole('button',{name:'Auf Updates prüfen'}).click();
  await sendIntegrated({busy:true});await sendIntegrated({lastChecked:'2026-11-14T11:00:00Z'});
  await page.locator('.integrated-card [role=status]').filter({hasText:'Auf dem neuesten Stand'}).waitFor({timeout:3000});
  assert.equal(await page.locator('.integrated-card code.version-flash').count(),1,'Version flashes green when current');
  await sendIntegrated({latest:'1.8.0',updateAvailable:true});
  await page.locator('.integrated-card .new-version-number').filter({hasText:'1.8.0'}).waitFor();
  await page.getByRole('button',{name:'Update bauen'}).click();
  await page.locator('.integrated-card').getByRole('button',{name:'Diese Version überspringen'}).click();
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='checkIntegratedViewer')&&window.__relayMessages.some(m=>m.action==='buildIntegratedViewer'&&m.version==='1.8.0')&&window.__relayMessages.some(m=>m.action==='skipIntegratedViewer'&&m.version==='1.8.0')));
  await sendIntegrated({latest:'1.8.0',updateAvailable:true,building:true});
  await page.getByRole('button',{name:'Build läuft …'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Build läuft …'}).isEnabled(),false,'No second build while one runs');
  await sendIntegrated({latest:'1.8.0',updateAvailable:true,staged:{appVersion:'0.4.1',noVnc:'1.8.0',testsPassed:true}});
  await page.getByRole('button',{name:'Jetzt aktivieren'}).click();
  assert.equal(await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='activateIntegratedViewer').length),0,'Active SSH needs an explicit restart confirmation');
  assert((await page.locator('.integrated-confirm').innerText()).includes('SSH-Verbindung'));
  await page.getByRole('button',{name:'Neu starten & aktivieren'}).click();
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='activateIntegratedViewer'&&m.confirm===true)));
  await sendIntegrated({latest:'1.8.0',updateAvailable:true,staged:{appVersion:'0.4.1',noVnc:'1.8.0',testsPassed:true},sshActive:false});
  await page.getByRole('button',{name:'Jetzt aktivieren'}).click();
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='activateIntegratedViewer'&&m.confirm===false)),'Without SSH the restart needs no extra step');
  await sendIntegrated({latest:'1.8.0',updateAvailable:true,canBuild:false});
  await page.locator('.integrated-card').getByText('Kommt mit dem nächsten Pi-Relay-Installer').waitFor();
  assert.equal(await page.getByRole('button',{name:'Update bauen'}).count(),0,'Installed copies offer no local build');
  assert.equal(await page.evaluate(()=>window.__relayMessages.filter(m=>['connect','connectScreen','installViewer','importRealVnc'].includes(m.action)).length),0,'Tests never start connections or downloads; the portal request is mocked');
  // Quick screen button in an access row opens that alias's screen (and only on click).
  await page.getByRole('button',{name:'Pi-Bildschirm schließen'}).click();
  await page.getByRole('button',{name:'MeinPi Pi-Bildschirm öffnen'}).click();
  assert.deepEqual(await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='connectScreen').map(m=>m.alias)),['MeinPi']);
  console.log('PASS: integrated viewer version/update/build/activation with SSH confirmation, dynamic tray layout/reveal, key scrolling, green update offer, manual Classic download guidance, skip/restore bridge, current status, one-click setup and advanced EXE picker. No connections or downloads started.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
