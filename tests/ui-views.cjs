// Local, isolated browser QA. This never opens an SSH or VNC connection.
const {createRequire}=require('node:module');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const load=process.env.PI_RELAY_NODE_MODULES?createRequire(path.join(process.env.PI_RELAY_NODE_MODULES,'package.json')):require;
const {chromium}=load('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PI_RELAY_CHROME?{executablePath:process.env.PI_RELAY_CHROME}:{})});
 try{
  const page=await browser.newPage({viewport:{width:900,height:760}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const output=path.resolve(__dirname,'../qa');fs.mkdirSync(output,{recursive:true});
  await page.goto(process.env.PI_RELAY_QA_URL||'http://127.0.0.1:4173/?design=1&viewer-update=1');
  await page.getByRole('heading',{name:'Pi Relay',exact:true}).waitFor();
  assert.equal(await page.locator('.agent-logo').count(),0);
  assert.equal(await page.locator('.agent .avatar').count(),2);
  const vncButton=await page.locator('.screen-button').boundingBox(),settingsButton=await page.getByRole('button',{name:'Einstellungen',exact:true}).boundingBox(),badge=await page.locator('.screen-button .vnc-badge').boundingBox();
  assert(vncButton.width>settingsButton.width&&badge.x+badge.width<=vncButton.x+vncButton.width,'Wider VNC control contains its badge');
  assert.equal(await page.locator('.connection-hint').count(),0);
  const ip=await page.locator('.device-copy .ip').boundingBox();
  const deviceStatus=await page.locator('.device-copy .device-state').boundingBox();
  assert(deviceStatus.y>=ip.y+ip.height&&deviceStatus.x===ip.x,'Device status sits directly below the IP');
  assert.equal(await page.getByRole('button',{name:'BackDoor ausklappen'}).getAttribute('aria-expanded'),'false');
  assert.equal((await page.locator('#backup-accesses').boundingBox()).height,0);
  assert.equal(await page.locator('.sessions>.session').first().evaluate(e=>getComputedStyle(e).borderBottomWidth),'0px','No duplicate divider below MasterControl');
  assert.equal(await page.locator('.agents-strip').evaluate(e=>getComputedStyle(e).borderTopWidth),'1px');
  await page.waitForTimeout(300);
  const compactBox=await page.locator('.panel-viewport').boundingBox();
  const primaryBox=await page.locator('.sessions').boundingBox(),companionsBox=await page.locator('.agents-strip').boundingBox();
  assert(companionsBox.y-primaryBox.y-primaryBox.height<20,'Companions immediately follow the access rows');
  // Info hover keeps the panel height (no wrap), so the hint stays while hovering; the IP line shows the router hint.
  const before=await page.locator('.panel-viewport').boundingBox();
  await page.getByRole('button',{name:'Verbindungshilfe anzeigen'}).hover();await page.waitForTimeout(300);
  assert.equal(await page.getByRole('button',{name:'Verbindungshilfe anzeigen'}).getAttribute('aria-expanded'),'true','Hover help stays on');
  assert.equal(await page.locator('.ip-hint').innerText(),'IP aus dem Router-Menü übernehmen');
  assert.equal((await page.locator('.panel-viewport').boundingBox()).height,before.height,'Help does not change the panel height');
  await page.mouse.move(5,5);await page.waitForTimeout(550);
  // Pencil fades in on hover of the address and edits it inline.
  assert.equal(await page.locator('.ip-edit').evaluate(e=>getComputedStyle(e).opacity),'0');
  await page.locator('.ip-row').hover();await page.waitForTimeout(450);
  assert.equal(await page.locator('.ip-edit').evaluate(e=>getComputedStyle(e).opacity),'1','Pencil fades in on hover');
  await page.getByRole('button',{name:'Pi-Adresse ändern'}).click();
  await page.getByLabel('Pi-Adresse').fill('1.2.3.4 -oProxyCommand=x');
  assert.equal(await page.getByRole('button',{name:'Adresse speichern'}).isEnabled(),false,'Invalid addresses cannot be saved');
  await page.getByLabel('Pi-Adresse').press('Escape');
  assert.equal(await page.locator('.ip-row .ip').innerText(),'192.168.1.50','Escape cancels');
  // Board facts from the Pi: model without "Model B Rev", RAM rounded to the board size, drive size and type.
  assert.equal(await page.locator('.device-title h2').innerText(),'Raspberry Pi 5');
  // Drive first; a pointer entry from the left turns it to RAM, an entry from the right turns it back.
  assert.equal(await page.locator('.spec-flip').getAttribute('data-face'),'front');
  assert.equal(await page.locator('.spec-front').innerText(),'128GB USB');assert.equal(await page.locator('.spec-back').innerText(),'16GB RAM');
  {const route=await page.locator('.session-line.first').evaluate(e=>[getComputedStyle(e).borderLeftStyle,getComputedStyle(e,'::after').animationName]);assert.deepEqual(route,['solid','route-ping'],'Connected first route is solid with a ping-and-answer shimmer');
   {const box=await page.locator('.check-label.check-after').evaluate(e=>[e.querySelector('.check-visual').getBoundingClientRect().left,e.getBoundingClientRect().left]);assert(box[0]>box[1]+40,'Minimiert-starten box sits right of its text');}
   assert.equal(await page.locator('.brand div>span').evaluate(e=>getComputedStyle(e).fontWeight),'700','Subtitle is bold');}
  {const [num,unit,title]=await page.evaluate(()=>[document.querySelector('.spec-back .spec-num'),document.querySelector('.spec-back .spec-unit'),document.querySelector('.device-copy h2')].map(e=>parseFloat(getComputedStyle(e).fontSize)));assert(Math.abs(num-title)<0.6&&Math.abs(unit-title*0.72)<0.6,'Spec number matches the heading, unit at lowercase height: '+[num,unit,title]);}
  const flip=await page.locator('.spec-flip').boundingBox();
  await page.mouse.move(flip.x-10,flip.y+flip.height/2);await page.mouse.move(flip.x+3,flip.y+flip.height/2);await page.waitForTimeout(600);
  assert.equal(await page.locator('.spec-flip').getAttribute('data-face'),'back','Left entry shows RAM');
  assert.equal(await page.locator('.spec-flip-rotor').evaluate(e=>e.style.transform),'rotateY(180deg)');
  await page.mouse.move(flip.x+flip.width+30,flip.y+flip.height/2);await page.mouse.move(flip.x+flip.width-3,flip.y+flip.height/2);await page.waitForTimeout(600);
  assert.equal(await page.locator('.spec-flip-rotor').evaluate(e=>e.style.transform),'rotateY(0deg)','Right entry turns back');
  await page.mouse.move(5,5);
  // Header order: collapse arrow, Pi screen, settings rightmost (where subviews place their X).
  const [collapseX,screenX,gearX]=await Promise.all(['In den Infobereich minimieren','Pi-Bildschirm öffnen','Einstellungen'].map(name=>page.getByRole('button',{name,exact:true}).boundingBox().then(b=>b.x)));
  assert(collapseX<screenX&&screenX<gearX,'Header order arrow, screen, gear');
  // The BackDoor toggle is a round node centred on the tree line, like the ball above it.
  const toggle=await page.getByRole('button',{name:'BackDoor ausklappen'}).boundingBox(),ball=await page.locator('.session-line.first').boundingBox();
  // The gutter of the first access is the BackDoor toggle: a + fades in on hover, the solid route stays visible.
  assert.equal(await page.locator('.backup-toggle svg').evaluate(e=>getComputedStyle(e).opacity),'0');
  await page.getByRole('button',{name:'BackDoor ausklappen'}).hover();await page.waitForTimeout(450);
  assert.equal(await page.locator('.backup-toggle svg').evaluate(e=>getComputedStyle(e).opacity),'1','Plus fades in over the route');
  assert.equal(await page.locator('.session-line.first').evaluate(e=>getComputedStyle(e).borderBottomStyle),'solid','Main route is a solid line');
  assert(await page.locator('.session-line.first').evaluate(e=>e.classList.contains('live')),'Connected access draws the red route');
  assert(Math.abs(toggle.x+toggle.width/2-ball.x)<=2,'Toggle sits on the tree line');
  assert.equal(await page.getByRole('button',{name:'MasterControl Pi-Bildschirm öffnen'}).count(),1,'Quick screen button beside the terminal');
  const quick=await page.getByRole('button',{name:'MasterControl Pi-Bildschirm öffnen'}).boundingBox(),term=await page.getByRole('button',{name:'MasterControl Terminal öffnen'}).boundingBox();
  assert(quick.x+quick.width<=term.x,'Quick screen button sits left of the terminal button');
  await page.getByRole('button',{name:'BackDoor ausklappen'}).click();
  assert.equal(await page.getByRole('button',{name:'BackDoor einklappen'}).getAttribute('aria-expanded'),'true','Arrow flips when expanded');
  await page.waitForTimeout(700);
  // The route bends into the access name (not the status line); expanding shows the BackDoor branch.
  const name=await page.locator('.sessions>.session').first().locator('.session-copy strong').boundingBox(),route=await page.locator('.session-line.first').boundingBox();
  // The horizontal stroke meets the name at half the height of its lowercase letters.
  const xMid=await page.locator('.sessions>.session').first().locator('.session-copy strong').evaluate(e=>{const probe=document.createElement('span');probe.style.cssText='display:inline-block;width:0;height:0;vertical-align:baseline';e.appendChild(probe);const base=probe.getBoundingClientRect().top;probe.remove();const cs=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.font=cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily;return base-c.measureText('a').actualBoundingBoxAscent/2;});
  const stroke=await page.locator('.session-line.first').evaluate(e=>e.getBoundingClientRect().bottom-parseFloat(getComputedStyle(e).borderBottomWidth)/2);
  assert(Math.abs(stroke-xMid)<=1.5,'Route ends at half the lowercase height of the access name: '+stroke+' vs '+xMid);
  assert.equal(await page.locator('.backup-session .backup-route').evaluate(e=>e.classList.contains('live')),false,'Unconnected BackDoor route is grey');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.backup-route-stub')).opacity==='1',null,{timeout:2000});
  await page.waitForTimeout(280);
  const expandedBox=await page.locator('.panel-viewport').boundingBox();
  assert(expandedBox.height>compactBox.height+45,'Backup increases the shared panel height');
  assert(Math.abs(expandedBox.y+expandedBox.height-compactBox.y-compactBox.height)<1,'Bottom stays anchored while expanding upward');
  for(const alias of ['MasterControl','BackDoor']){
   const button=page.getByRole('button',{name:alias+' Terminal öffnen'});
   assert.equal(await button.locator('.terminal-face-front svg').count(),1);
   assert.equal(await button.locator('.terminal-face-front svg').getAttribute('width'),'29');
   assert.equal(await button.locator('.terminal-face-back img').count(),1);
   const shell=button.locator('..');
   const box=await shell.boundingBox();
   await page.mouse.move(box.x-8,box.y+box.height/2);await page.mouse.move(box.x+1,box.y+box.height/2);
   assert.equal(await shell.getAttribute('data-symbol'),'key');
   assert.equal(await shell.locator('.terminal-morph-rotor').evaluate(e=>e.style.transform),'rotateY(180deg)');
   await page.mouse.move(box.x-8,box.y+box.height/2);
   assert.equal(await shell.getAttribute('data-symbol'),'key','Leaving keeps the alternate icon');
   await page.mouse.move(box.x+1,box.y+box.height/2);
   assert.equal(await shell.getAttribute('data-symbol'),'terminal');
   assert.equal(await shell.locator('.terminal-morph-rotor').evaluate(e=>e.style.transform),'rotateY(360deg)');
   await page.mouse.move(box.x+box.width+8,box.y+box.height/2);await page.mouse.move(box.x+box.width-1,box.y+box.height/2);
   assert.equal(await shell.locator('.terminal-morph-rotor').evaluate(e=>e.style.transform),'rotateY(180deg)','Right entry reverses the turn direction');
   assert.equal(await button.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
   assert.equal(await shell.locator('.terminal-glitter').count(),0,'No sparkle effect');
  }
  assert(await page.locator('.view-home').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'Expanded overview fits without agent scrolling');
  await page.getByRole('button',{name:'BackDoor einklappen'}).click();
  await page.getByRole('button',{name:'Verbindungshilfe anzeigen'}).hover();
  assert((await page.locator('#connection-help').innerText()).includes('Klick verbindet · Bildschirm · Terminal'));
  await page.locator('.brand h1').hover();
  // Pointer is over the header, outside both companion boxes.
  await page.waitForTimeout(260);
  const looks=await page.locator('.agents-strip [data-companion]').evaluateAll(nodes=>nodes.map(n=>n.style.getPropertyValue('--look')));
  assert(looks.every(angle=>angle&&angle!=='0deg'),'Both companions follow movement outside their own boxes');
  const agentButton=await page.locator('.agent-status').first().evaluate(e=>getComputedStyle(e).backgroundColor);
  assert.equal(agentButton,'rgba(0, 0, 0, 0)','Agent status has no separate background');
  for(const agent of await page.locator('.agent').all()){
   const name=await agent.locator('.agent-name').boundingBox();
   const status=await agent.locator('.agent-status').boundingBox();
   assert(status.y>=name.y+name.height,'Status button belongs below the name');
  }
  const panel=await page.locator('.relay').boundingBox();
  const homeHeader=await page.locator('.app-header').boundingBox();
  const homeTitle=await page.locator('.brand h1').boundingBox();
  const save=async name=>{await page.waitForTimeout(270);return page.locator('.panel-viewport').screenshot({path:path.join(output,'views-'+name+'-20261111.png')});};
  await save('overview');
  await page.getByRole('button',{name:'Schlüssel verwalten',exact:true}).click();
  await page.getByRole('heading',{name:'SSH-Schlüssel',exact:true}).waitFor();
  const keysHeader=await page.locator('.app-header').boundingBox();
  const keysTitle=await page.locator('.brand h1').boundingBox();
  assert.equal(keysHeader.y+keysHeader.height,homeHeader.y+homeHeader.height,'Divider stays aligned across views');
  assert.equal(keysTitle.x,homeTitle.x,'Larger key icon does not move the title');
  assert.equal(await page.getByRole('checkbox',{name:'Minimiert starten'}).count(),0);
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await page.locator('.agents-strip').count(),0);
  assert.equal(await page.locator('header').getByRole('button',{name:'SSH-Ordner öffnen'}).count(),1);
  assert.equal(await page.locator('header').getByRole('button',{name:'Schlüssel zuordnen'}).count(),1);
  assert.equal(await page.locator('header').getByRole('button',{name:'Einstellungen',exact:true}).count(),0);
  await save('keys');
  await page.getByRole('button',{name:'Schlüssel schließen',exact:true}).click();
  await page.getByRole('button',{name:'Einstellungen',exact:true}).click();
  await page.getByRole('heading',{name:'Einstellungen',exact:true}).waitFor();
  assert.equal(await page.locator('footer').getByRole('button',{name:'Verlauf anzeigen'}).count(),1);
  assert.equal(await page.locator('footer').getByRole('button',{name:'Pi Relay beenden'}).count(),1);
  await save('settings');
  await page.getByRole('button',{name:'Verlauf anzeigen'}).click();
  await page.getByRole('heading',{name:'Verlauf',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('heading',{name:'Einstellungen',exact:true}).waitFor();
  await page.getByRole('button',{name:'Einstellungen schließen'}).click();
  await page.getByRole('button',{name:'Pi-Bildschirm öffnen',exact:true}).click();
  await page.getByRole('heading',{name:'Pi-Bildschirm',exact:true}).waitFor();
  assert.equal(await page.locator('.screen-intro').count(),0);
  assert((await page.locator('.app-footer button').innerText()).startsWith('Externer Viewer (Rückfall)'),'Screen footer is the functional fallback link, not a close-only footer');
  assert.equal(await page.locator('.view-screen button').first().innerText(),'Bildschirm öffnen');
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await page.locator('header .vnc-badge').innerText(),'x11vnc','Badge names the Pi\'s VNC server once known');
  assert(await page.locator('.view-screen').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'Screen view has no scrolling content');
  assert.equal(await page.locator('.vnc-server-card code').innerText(),'x11vnc 0.9.17');
  assert.equal(await page.getByRole('button',{name:'Bildschirm öffnen',exact:true}).isEnabled(),true);
  await save('screen');
  const screen=await page.locator('.relay').boundingBox();assert.equal(screen.width,panel.width);assert.equal(screen.height,panel.height);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Codex-Zugang verwalten',exact:true}).click();
  await page.getByRole('heading',{name:'Codex-Zugang',exact:true}).waitFor();
  assert.equal(await page.locator('.app-footer').count(),0,'Agent uses its header X instead of a close-only footer');
  await save('agent');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'In den Infobereich minimieren'}).click();
  await page.waitForTimeout(150);
  const translate=await page.locator('.relay').evaluate(e=>new DOMMatrix(getComputedStyle(e).transform).m42);
  assert(translate>0,'Collapse moves content downward inside the fixed lower boundary');
  await page.waitForTimeout(900);
  await page.setViewportSize({width:360,height:760});
  await save('mobile');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal document overflow');
  await page.getByRole('button',{name:'Schlüssel verwalten',exact:true}).click();
  const controls=await page.locator('header').getByRole('button').all();
  for(const control of controls){const box=await control.boundingBox();assert(box.x>=0&&box.x+box.width<=360,'Header controls fit small widths');}
  await page.getByRole('button',{name:'Schlüssel schließen',exact:true}).click();
  await page.getByRole('button',{name:'Pi-Bildschirm öffnen',exact:true}).click();
  for(const control of await page.locator('.screen-access-row').locator('label,select,button').all()){const box=await control.boundingBox();assert(box.x>=0&&box.x+box.width<=360,'Compact SSH access row fits at 360px');}
  await save('screen-mobile');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.ambient-gradient').evaluate(e=>getComputedStyle(e).animationName),'none');
  assert.deepEqual(errors,[]);
  assert.equal(page.context().pages().length,1);
  // Unreachable Pi (ping only): grey case, model kept, specs replaced by a grey "nicht erreichbar".
  const offlinePage=await browser.newPage({viewport:{width:900,height:760}});
  await offlinePage.goto((process.env.PI_RELAY_QA_URL||'http://127.0.0.1:4173/').split('?')[0]+'?design=1&pi-offline=1');
  await offlinePage.getByRole('heading',{name:'Raspberry Pi 5'}).waitFor();
  assert.equal(await offlinePage.locator('.spec-chip').innerText(),'nicht erreichbar');
  assert.equal(await offlinePage.locator('.device-state .state-rest').innerText(),'Aus oder nicht im Netz');
  await offlinePage.waitForTimeout(600);
  assert((await offlinePage.locator('.case-image').evaluate(e=>getComputedStyle(e).filter)).includes('grayscale(1)'),'Case turns grey');
  await offlinePage.locator('.panel-viewport').screenshot({path:path.join(output,'views-offline.png')});
  await offlinePage.close();
  // Explicit connect while the Pi restarts: amber "Wartet auf den Pi …", hover offers cancelling.
  const waitPage=await browser.newPage({viewport:{width:900,height:760}});
  await waitPage.goto((process.env.PI_RELAY_QA_URL||'http://127.0.0.1:4173/').split('?')[0]+'?design=1&pi-waiting=1');
  await waitPage.getByRole('heading',{name:'Raspberry Pi 5'}).waitFor();
  assert.equal(await waitPage.locator('.device-state.waiting .state-rest').innerText(),'Wartet auf den Pi …');
  assert(await waitPage.locator('.session-connect').first().isDisabled(),'Access row is locked while waiting');
  await waitPage.locator('.device-state.waiting').click();
  await waitPage.locator('.device-state.waiting').waitFor({state:'detached'});
  await waitPage.close();
  // Disconnected companions sleep (grey, z's); the main route is dashed while the Pi is not connected.
  const sleepPage=await browser.newPage({viewport:{width:900,height:760}});
  await sleepPage.goto((process.env.PI_RELAY_QA_URL||'http://127.0.0.1:4173/').split('?')[0]+'?design=1&agents-off=1&pi-offline=1');
  await sleepPage.getByRole('heading',{name:'Raspberry Pi 5'}).waitFor();
  assert.equal(await sleepPage.locator('.sleep-z').count(),2,'Both companions sleep while disconnected');
  assert((await sleepPage.locator('.agent.codex .avatar').evaluate(e=>getComputedStyle(e).filter)).includes('grayscale(1)'),'Sleeping companion is grey');
  assert.equal(await sleepPage.locator('.session-line.first').evaluate(e=>getComputedStyle(e).borderBottomStyle),'dashed','Disconnected route is dashed');
  await sleepPage.close();
  console.log('PASS: compact overview, stacked device status, waiting for a restarting Pi (cancel), sleeping companions and dashed route while disconnected, backup drawer/key icon, transient help, agent buttons, views, keyboard return, collapse direction, 360px layout and reduced motion.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
