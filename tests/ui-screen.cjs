// Integrated viewer QA in an isolated headless browser. A tiny in-page RFB server stands in
// for the native bridge, so the real bundled noVNC client is exercised without SSH or a Pi.
const {createRequire}=require('node:module');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const load=process.env.PI_RELAY_NODE_MODULES?createRequire(path.join(process.env.PI_RELAY_NODE_MODULES,'package.json')):require;
const {chromium}=load('playwright');
const base=process.env.PI_RELAY_QA_URL||'http://127.0.0.1:4173/';

function mockHost(){
 const events=new EventTarget();
 window.__relayMessages=[];
 const deliver=data=>events.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
 window.__relaySend=deliver;
 // Screen bytes come as shared memory like in WebView2: getBuffer() on the event, released by the page.
 const shared=window.__shared={posted:0,released:0};
 function share(part){const event=new Event('sharedbufferreceived'),buffer=part.slice().buffer;event.getBuffer=()=>buffer;event.additionalData={type:'screenData'};shared.posted++;events.dispatchEvent(event);}
 const vnc=window.__vnc={security:1,keys:[],pointers:[],cut:[],frames:0,opens:0,state:'off',buffer:new Uint8Array(0),width:800,height:600};
 const u16=v=>[v>>8&255,v&255],u32=v=>[v>>>24&255,v>>16&255,v>>8&255,v&255];
 function reply(bytes){bytes=bytes instanceof Uint8Array?bytes:Uint8Array.from(bytes);for(let i=0;i<bytes.length;i+=262144){const part=bytes.subarray(i,i+262144);setTimeout(()=>share(part),0);}}
 window.__vncCutText=text=>reply([3,0,0,0,...u32(text.length),...[...text].map(c=>c.charCodeAt(0))]);
 function frame(){
  const {width:w,height:h}=vnc,header=[0,0,...u16(1),...u16(0),...u16(0),...u16(w),...u16(h),...u32(0)];
  const pixels=new Uint8Array(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=(y*w+x)*4;if(x<w/2){pixels[o]=220;pixels[o+1]=30;pixels[o+2]=60;}else{pixels[o]=40;pixels[o+1]=90;pixels[o+2]=230;}}
  const all=new Uint8Array(header.length+pixels.length);all.set(header);all.set(pixels,header.length);vnc.frames++;reply(all);
 }
 function consume(n){if(vnc.buffer.length<n)return null;const out=vnc.buffer.slice(0,n);vnc.buffer=vnc.buffer.slice(n);return out;}
 function pump(){
  for(;;){
   const b=vnc.buffer;
   if(vnc.state==='version'){if(!consume(12))return;vnc.state='security';reply([1,vnc.security]);continue;}
   if(vnc.state==='security'){const t=consume(1);if(!t)return;if(t[0]===2){vnc.state='auth';reply(new Uint8Array(16).fill(7));}else{vnc.state='init';reply(u32(0));}continue;}
   if(vnc.state==='auth'){if(!consume(16))return;vnc.state='init';reply(u32(0));continue;}
   if(vnc.state==='init'){if(!consume(1))return;vnc.state='normal';const name=[...'Pi Desktop'].map(c=>c.charCodeAt(0));reply([...u16(vnc.width),...u16(vnc.height),32,24,0,1,...u16(255),...u16(255),...u16(255),16,8,0,0,0,0,...u32(name.length),...name]);continue;}
   if(vnc.state!=='normal'||!b.length)return;
   const type=b[0];
   if(type===0){if(!consume(20))return;continue;}
   if(type===2){if(b.length<4)return;const n=b[2]<<8|b[3];const m=consume(4+4*n);if(!m)return;vnc.encodings=[];for(let i=0;i<n;i++)vnc.encodings.push(m[4+4*i]<<24|m[5+4*i]<<16|m[6+4*i]<<8|m[7+4*i]);continue;}
   if(type===3){const m=consume(10);if(!m)return;if(m[1]===0)frame();continue;}
   if(type===4){const m=consume(8);if(!m)return;vnc.keys.push({down:m[1],keysym:(m[4]<<24|m[5]<<16|m[6]<<8|m[7])>>>0});continue;}
   if(type===5){const m=consume(6);if(!m)return;vnc.pointers.push({mask:m[1],x:m[2]<<8|m[3],y:m[4]<<8|m[5]});continue;}
   if(type===6){if(b.length<8)return;const n=(b[4]<<24|b[5]<<16|b[6]<<8|b[7])>>>0;const m=consume(8+n);if(!m)return;vnc.cut.push(String.fromCharCode(...m.slice(8)));continue;}
   throw new Error('Unexpected client message '+type);
  }
 }
 window.chrome=window.chrome||{};
 window.chrome.webview={
  addEventListener:(...a)=>events.addEventListener(...a),removeEventListener:(...a)=>events.removeEventListener(...a),releaseBuffer:()=>{shared.released++;},
  postMessage:m=>{
   if(m.action!=='screenSend')window.__relayMessages.push(m);
   if(m.action==='screenReady')setTimeout(()=>deliver({type:'screenInit',alias:'MeinPi',version:'0.4.0',autoConnect:true,fullscreen:false}),0);
   if(m.action==='screenOpen'){vnc.opens++;vnc.state='version';vnc.buffer=new Uint8Array(0);setTimeout(()=>{deliver({type:'screenOpened'});reply([...'RFB 003.008\n'].map(c=>c.charCodeAt(0)));},5);}
   if(m.action==='screenSend'){const chunk=Uint8Array.from(atob(m.data),c=>c.charCodeAt(0));const all=new Uint8Array(vnc.buffer.length+chunk.length);all.set(vnc.buffer);all.set(chunk,vnc.buffer.length);vnc.buffer=all;pump();}
   if(m.action==='screenUpload'){const chunk=Uint8Array.from(atob(m.data),c=>c.charCodeAt(0));const prev=(window.__uploads||={})[m.token]||new Uint8Array(0);const all=new Uint8Array(prev.length+chunk.length);all.set(prev);all.set(chunk,prev.length);window.__uploads[m.token]=all;(window.__uploadChunks||=[]).push(m.offset);setTimeout(()=>deliver({type:'screenUploadResult',id:m.id,ok:true,result:m.final?{path:'/home/pi/Desktop/'+m.name,size:all.length}:{size:all.length}}),5);}
   if(m.action==='screenInfo')setTimeout(()=>deliver({type:'screenInfo',info:{os:'Raspberry Pi OS Trixie',host:'raspberrypi',server:'x11vnc'}}),0);
   if(m.action==='micStart')setTimeout(()=>deliver(window.__micFails?{type:'micState',state:'error',message:'Mikrofon-Empfänger auf dem Pi ist nicht bereit.'}:{type:'micState',state:'on'}),0);
   if(m.action==='micStop'&&!m.quiet)setTimeout(()=>deliver({type:'micState',state:'off'}),0);
   if(m.action==='screenDisconnect')vnc.state='off';
   if(m.action==='screenFullscreen')setTimeout(()=>deliver({type:'screenFullscreen',on:m.on}),0);
   if(m.action==='screenClipboardRead')setTimeout(()=>deliver({type:'screenClipboardText',text:window.__windowsClipboard||'',reason:m.reason}),0);
  }
 };
}

(async()=>{
 const browser=await chromium.launch({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],...(process.env.PI_RELAY_CHROME?{executablePath:process.env.PI_RELAY_CHROME}:{})});
 const output=path.resolve(__dirname,'../qa');fs.mkdirSync(output,{recursive:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/Content Security Policy/i.test(m.text()))errors.push(m.text());});
  await page.addInitScript(mockHost);
  await page.goto(base+'?screen=MeinPi');
  const status=page.locator('.screen-status');
  await page.waitForFunction(()=>document.querySelector('.screen-status')?.textContent.includes('Verbunden')&&window.__vnc.frames>0);
  await page.waitForTimeout(150);
  assert(await page.evaluate(()=>window.__shared.posted>0&&window.__shared.posted===window.__shared.released),'Screen bytes arrive as shared buffers and every buffer is released');
  const canvas=page.locator('.screen-canvas canvas');
  // Left half red, right half blue: the received frame is actually drawn.
  const sample=await canvas.evaluate(c=>{const ctx=c.getContext('2d');return[[...ctx.getImageData(200,300,1,1).data],[...ctx.getImageData(600,300,1,1).data]];});
  assert(sample[0][0]>200&&sample[0][2]<90&&sample[1][2]>200,'Received framebuffer is drawn');
  assert.equal(await page.locator('.screen-overlay').count(),0);

  async function mapsPointer(fx,fy,label){
   const box=await canvas.boundingBox();const before=await page.evaluate(()=>window.__vnc.pointers.length);
   await page.mouse.click(box.x+fx*box.width/800,box.y+fy*box.height/600);
   await page.waitForFunction(n=>window.__vnc.pointers.length>n,before);
   const sent=await page.evaluate(n=>window.__vnc.pointers.slice(n),before);
   const press=sent.find(p=>p.mask&1)||sent.at(-1);
   assert(Math.abs(press.x-fx)<=2&&Math.abs(press.y-fy)<=2,label+': pointer '+JSON.stringify(press)+' maps to '+fx+','+fy);
   return box;
  }
  // After connecting, the 1000x700 window (654 px tall canvas area) shows bars; the window is asked to shrink to 4:3.
  assert.equal(await page.locator('.screen-footnote').count(),0,'No bottom info bar');
  assert((await page.locator('.screen-title').getAttribute('title')).includes('Pi Relay 0.4.0'),'Version info lives in the title tooltip');
  await page.locator('.screen-host',{hasText:'raspberrypi'}).waitFor();
  assert.equal(await page.locator('.screen-os').innerText(),'OS Trixie','The Pi context is implied: no "Raspberry Pi" prefix');
  assert(!(await page.locator('.screen-title').innerText()).includes('MeinPi'),'Access name only in the window title');
  assert.equal((await page.locator('.screen-status').innerText()).trim(),'Verbunden','Status shows only the state');
  {const mic=await page.locator('.mic-toggle').boundingBox(),trennen=await page.getByRole('button',{name:'Trennen'}).boundingBox();assert(mic.x<trennen.x,'Microphone sits left of Trennen');}
  assert.equal(await page.locator('.screen-host').evaluate(e=>getComputedStyle(e).color),'rgb(226, 87, 127)');
  const firstFit=await page.evaluate(()=>window.__relayMessages.find(m=>m.action==='screenFit'));
  assert(firstFit&&Math.abs(firstFit.dw-(Math.round(654*4/3)-1000))<=1&&firstFit.dh===0,'Initial fit request: '+JSON.stringify(firstFit));
  let box=await mapsPointer(400,300,'Fit 1000px');
  assert(Math.abs(box.width/box.height-4/3)<.01&&box.height<=700-46+1,'Fit keeps 4:3 inside the window');
  await mapsPointer(37,551,'Fit corner');
  await page.screenshot({path:path.join(output,'screen-viewer-1000.png')});

  // Microphone: off by default, red while on, 20 ms chunks of 48 kHz mono s16le, off again.
  const micToggle=page.locator('.mic-toggle');
  assert.equal(await micToggle.getAttribute('aria-pressed'),'false','Microphone starts switched off');
  await micToggle.click();
  await page.waitForFunction(()=>window.__relayMessages.filter(m=>m.action==='micChunk').length>=5,null,{timeout:8000});
  const chunk=await page.evaluate(()=>window.__relayMessages.find(m=>m.action==='micChunk').data);
  assert.equal(Buffer.from(chunk,'base64').length,1920,'20 ms at 48 kHz mono 16 bit');
  assert.equal(await micToggle.getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.mic-dot').count(),1,'Red marker while on');
  // Device menu behind the arrow: Windows default on top, then the devices; a choice is remembered by id.
  await page.locator('.mic-menu-toggle').click();
  const items=page.locator('.mic-menu [role=menuitemradio]');await items.first().waitFor();
  assert.equal(await items.first().innerText(),'Standard (Windows-Standardgerät)');assert(await items.count()>=2,'Recording devices listed');
  await items.nth(1).click();await page.locator('.mic-menu').waitFor({state:'detached'});
  const remembered=await page.evaluate(()=>localStorage.getItem('pi-relay-mic-device'));assert(remembered,'Chosen device remembered by id');
  assert.equal(await page.locator('.mic-button .mic-level').count(),1,'Meter sits inside the microphone button');
  await micToggle.click();
  await page.waitForFunction(()=>window.__relayMessages.some(m=>m.action==='micStop'));
  const sent=await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='micChunk').length);await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='micChunk').length),sent,'No audio after switching off');
  await page.evaluate(()=>{window.__micFails=true;});await micToggle.click();
  await page.waitForFunction(()=>document.querySelector('.mic-toggle').getAttribute('aria-pressed')==='false');
  assert((await page.locator('.screen-notice').innerText()).includes('nicht bereit'),'Receiver not ready: switch off with a reason');
  await page.evaluate(()=>{window.__micFails=false;});

  // Toolbar: default order, hold 3 s to arrange, drag one tool onto another to swap, Esc ends, order kept.
  const order=()=>page.evaluate(()=>[...document.querySelectorAll('.tool-slot')].map(e=>e.dataset.tool));
  assert.deepEqual(await order(),['mic','quality','connection','share','paste','scale'],'Default toolbar order');
  const scaleTool=page.locator('.tool-slot[data-tool=scale]'),sb=await scaleTool.boundingBox();
  await page.mouse.move(sb.x+sb.width/2,sb.y+sb.height/2);await page.mouse.down();await page.waitForTimeout(3200);await page.mouse.up();
  assert(await page.locator('.screen-tools.editing').count()===1,'Holding 3 s starts arranging');
  assert.equal(await page.locator('.screen-tool[aria-pressed]').first().getAttribute('aria-pressed'),'true','The long press did not toggle the tool');
  const mb=await page.locator('.tool-slot[data-tool=mic]').boundingBox(),sb2=await scaleTool.boundingBox();
  await page.mouse.move(sb2.x+sb2.width/2,sb2.y+sb2.height/2);await page.mouse.down();await page.mouse.move(mb.x+mb.width/2,mb.y+mb.height/2,{steps:6});await page.mouse.up();
  assert.deepEqual(await order(),['scale','quality','connection','share','paste','mic'],'Dragging swaps two tools');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.screen-tools.editing').count(),0,'Esc ends arranging');
  assert.deepEqual(JSON.parse(await page.evaluate(()=>localStorage.getItem('pi-relay-toolbar-order'))),['scale','quality','connection','share','paste','mic'],'Order is saved');
  await page.evaluate(()=>localStorage.removeItem('pi-relay-toolbar-order'));

  await page.setViewportSize({width:600,height:520});await page.waitForTimeout(250);
  box=await mapsPointer(700,120,'Fit 600px');
  assert(box.width<=600&&Math.abs(box.width/box.height-4/3)<.01,'Narrow window scales down with aspect ratio');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Toolbar causes no horizontal overflow at 600px');
  await page.screenshot({path:path.join(output,'screen-viewer-600.png')});
  await page.setViewportSize({width:480,height:520});await page.waitForTimeout(200);
  for(const control of await page.locator('.screen-toolbar button,.screen-toolbar input').all()){const b=await control.boundingBox();assert(b.x>=0&&b.x+b.width<=480,'Toolbar control fits at 480px');}
  await page.screenshot({path:path.join(output,'screen-viewer-480.png')});

  // Releasing a resize drag (native screenResizeEnd) asks to remove the remaining bars.
  await page.setViewportSize({width:1000,height:500});await page.waitForTimeout(200);
  const fits=await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='screenFit').length);
  await page.evaluate(()=>window.__relaySend({type:'screenResizeEnd'}));
  await page.waitForFunction(n=>window.__relayMessages.filter(m=>m.action==='screenFit').length>n,fits);
  const fit=await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='screenFit').at(-1));
  assert(Math.abs(fit.dw-(Math.round(454*4/3)-1000))<=1&&fit.dh===0,'Resize-end fit: '+JSON.stringify(fit));
  // Quality slider: starts at the measured optimum (green rim on the knob), sent to the server as
  // noVNC quality pseudo-encoding and remembered.
  const optimal=()=>page.getByLabel('Bildqualität').evaluate(e=>e.classList.contains('optimal'));
  assert.equal(await page.getByLabel('Bildqualität').inputValue(),'7','Default quality is the measured optimum');
  assert(await optimal(),'Knob on the optimum gets the green rim');
  await page.getByLabel('Bildqualität').fill('9');
  assert(!await optimal(),'No green rim away from the optimum');
  await page.waitForFunction(()=>window.__vnc.encodings?.includes(-23));
  assert.equal(await page.evaluate(()=>localStorage.getItem('piRelay.screenQuality')),'9');
  await page.getByLabel('Bildqualität').fill('6');
  await page.setViewportSize({width:1000,height:700});
  await page.getByRole('button',{name:'Angepasst'}).click();
  await page.waitForTimeout(200);
  box=await canvas.boundingBox();assert(Math.abs(box.width-800)<1&&Math.abs(box.height-600)<1,'1:1 shows native size');
  await mapsPointer(123,456,'1:1');
  const fitsNative=await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='screenFit').length);
  await page.evaluate(()=>window.__relaySend({type:'screenResizeEnd'}));await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='screenFit').length),fitsNative,'1:1 mode never resizes the window');
  await page.getByRole('button',{name:'1:1'}).click();

  // Real German-layout key events (as WebView2 delivers them on Windows): the character
  // keysym is sent, not the US key position, and every press is released.
  const cdp=await page.context().newCDPSession(page);
  const CTRL=2,ALT=1,SHIFT=8;
  async function key(type,key,code,vk,modifiers=0,text){await cdp.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers,...(text?{text,unmodifiedText:text}:{})});}
  async function tap(k,code,vk,modifiers=0){await key('keyDown',k,code,vk,modifiers,k.length===1?k:undefined);await key('keyUp',k,code,vk,modifiers);}
  await canvas.click();const k0=await page.evaluate(()=>window.__vnc.keys.length);
  for(const [k,code,vk] of [['ä','Quote',222],['ö','Semicolon',192],['ü','BracketLeft',186],['ß','Minus',219],['z','KeyY',90]])await tap(k,code,vk);
  await key('keyDown','Shift','ShiftLeft',16,SHIFT);await tap('A','KeyA',65,SHIFT);await key('keyUp','Shift','ShiftLeft',16);
  // Windows reports AltGr as ControlLeft+AltRight; AltGr+Q is @ and AltGr+E is € on German keyboards.
  await key('keyDown','Control','ControlLeft',17,CTRL);await key('keyDown','AltGraph','AltRight',18,CTRL|ALT);
  await tap('@','KeyQ',81,CTRL|ALT);await tap('€','KeyE',69,CTRL|ALT);
  await key('keyUp','AltGraph','AltRight',18,CTRL);await key('keyUp','Control','ControlLeft',17);
  await page.waitForTimeout(250);
  const keys=await page.evaluate(n=>window.__vnc.keys.slice(n),k0);
  for(const sym of [0xe4,0xf6,0xfc,0xdf,0x7a,0xffe1,0x41,0x40,0x20ac])assert(keys.some(k=>k.down&&k.keysym===sym),'keysym '+sym.toString(16)+' sent: '+JSON.stringify(keys));
  assert(!keys.some(k=>k.down&&k.keysym===0x79),'KeyY on a German layout is z, not y');
  const balance=new Map();for(const k of keys)balance.set(k.keysym,(balance.get(k.keysym)||0)+(k.down?1:-1));
  assert([...balance.values()].every(v=>v===0),'All keys released: '+JSON.stringify([...balance]));
  // noVNC holds a lone ControlLeft for ~100 ms to tell it apart from AltGr on Windows.
  await page.keyboard.down('Control');await page.waitForTimeout(250);
  const held=await page.evaluate(()=>window.__vnc.keys.at(-1));assert(held.down&&held.keysym===0xffe3);
  await page.evaluate(()=>window.__relaySend({type:'screenDeactivated'}));
  await page.waitForFunction(()=>window.__vnc.keys.at(-1).keysym===0xffe3&&window.__vnc.keys.at(-1).down===0);
  await page.keyboard.up('Control');

  // Clipboard in both directions, through the native host only.
  await page.evaluate(()=>window.__vncCutText('Grüße vom Pi'));
  await page.waitForFunction(()=>window.__relayMessages.some(m=>m.action==='screenClipboardWrite'&&m.text==='Grüße vom Pi'));
  await page.evaluate(()=>{window.__windowsClipboard='Hallo Pi – äöü';});
  await page.getByRole('button',{name:'An Pi'}).click();
  await page.waitForFunction(()=>window.__vnc.cut.length>0);
  assert.equal(await page.evaluate(()=>window.__vnc.cut.at(-1)),'Hallo Pi ? äöü','Latin-1 text reaches the Pi; unsupported characters are replaced');
  await page.locator('.screen-notice').filter({hasText:'Latin-1'}).waitFor();

  // Dropping a file copies it over SSH into the Pi inbox and puts its path into the Pi clipboard.
  await page.evaluate(()=>{const bytes=new Uint8Array(2*1024*1024+5);for(let i=0;i<bytes.length;i++)bytes[i]=i*7&255;window.__expected=bytes;const dt=new DataTransfer();dt.items.add(new File([bytes],'Gold Settings.txt'));window.__dt=dt;document.querySelector('.screen-stage').dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true}));});
  await page.locator('.screen-drop').waitFor();
  const cutsBefore=await page.evaluate(()=>window.__vnc.cut.length);
  await page.evaluate(()=>document.querySelector('.screen-stage').dispatchEvent(new DragEvent('drop',{dataTransfer:window.__dt,bubbles:true,cancelable:true})));
  await page.locator('.screen-notice').filter({hasText:'auf dem Pi-Desktop'}).waitFor();
  assert.equal(await page.locator('.screen-drop').count(),0);
  assert(await page.evaluate(()=>{const got=Object.values(window.__uploads)[0],want=window.__expected;return got.length===want.length&&got.every((b,i)=>b===want[i]);}),'Dropped file arrives intact');
  assert.deepEqual(await page.evaluate(()=>window.__uploadChunks),[0,786432,1572864],'Sent in sequential 768 KiB chunks');
  assert.equal(await page.evaluate(n=>window.__vnc.cut.slice(n).at(-1),cutsBefore),'/home/pi/Desktop/Gold Settings.txt','Path lands in the Pi clipboard');
  // F11 toggles fullscreen locally and is never forwarded to the Pi.
  const beforeF11=await page.evaluate(()=>window.__vnc.keys.length);
  await canvas.click();await page.keyboard.press('F11');
  await page.waitForFunction(()=>document.querySelector('.screen-stage.fullscreen.toolbar-hidden'));
  assert.equal(await page.evaluate(n=>window.__vnc.keys.slice(n).filter(k=>k.keysym===0xffc8).length,beforeF11),0,'F11 is not sent to the Pi');
  await page.mouse.move(500,10);await page.waitForFunction(()=>!document.querySelector('.screen-stage.toolbar-hidden'));
  assert.equal(await page.getByRole('button',{name:/Vollbild/}).count(),0,'Fullscreen is F11 only, no toolbar button');
  await canvas.click();await page.keyboard.press('F11');
  await page.waitForFunction(()=>!document.querySelector('.screen-stage.fullscreen'));

  // Optional FPS display beside the status: switched on from the tray settings, counts finished updates.
  assert.equal(await page.locator('.screen-mark b').innerText(),'x11vnc','Badge names the VNC server on the Pi');
  await page.evaluate(()=>window.__relaySend({type:'screenSettings',showFps:true}));
  await page.waitForFunction(()=>/^\d+$/.test(document.querySelector('.screen-mark .screen-fps-in')?.textContent||'')&&document.querySelector('.screen-mark b').textContent==='x11vnc',null,{timeout:3000});
  {const bar=await page.locator('.screen-toolbar').boundingBox(),tag=await page.locator('.screen-mark b').boundingBox();assert(tag.y>=bar.y&&tag.y+tag.height<=bar.y+bar.height,'Badge stays inside the bar');
   await page.screenshot({path:path.join(output,'screen-fps.png'),clip:{x:0,y:bar.y,width:420,height:bar.height}});}
  await page.evaluate(()=>window.__relaySend({type:'screenSettings',showFps:false}));
  await page.waitForFunction(()=>!document.querySelector('.screen-fps-in'));

  // Connection bar under the Pi name (green while connected); the status text slides out on hover.
  {const name=await page.locator('.screen-host').boundingBox(),line=await page.locator('.screen-host-bar').boundingBox();
   assert(Math.abs(line.width-name.width)<1&&line.y>name.y+name.height*0.6&&line.y+line.height<=name.y+name.height+1,'Bar spans the name below its baseline: '+JSON.stringify({name,line}));
   assert.equal(await page.locator('.screen-host-bar').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(56, 216, 108)','Green while connected');
   assert((await page.locator('.screen-status').boundingBox()).width<1,'Status text tucked away');
   const bar=await page.locator('.screen-toolbar').boundingBox();await page.screenshot({path:path.join(output,'screen-hostbar.png'),clip:{x:0,y:bar.y,width:460,height:bar.height}});
   await page.locator('.screen-host').hover();await page.waitForTimeout(600);
   assert((await page.locator('.screen-status').boundingBox()).width>40,'Status slides out on hover');
   await page.screenshot({path:path.join(output,'screen-hostbar-hover.png'),clip:{x:0,y:bar.y,width:460,height:bar.height}});
   await page.mouse.move(600,400);}

  // Disconnect releases only the VNC stream; reconnect is an explicit click.
  await page.getByRole('button',{name:'Trennen'}).click();
  await page.waitForFunction(()=>document.querySelector('.screen-status').textContent.includes('Getrennt'));
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='screenDisconnect')));
  await page.getByRole('button',{name:'Neu verbinden'}).click();
  await page.waitForFunction(()=>window.__vnc.opens===2&&document.querySelector('.screen-status').textContent.includes('Verbunden'));

  // The Pi ends the picture while SSH still stands (VNC server restarted): the viewer reopens by
  // itself over the existing connection, marked as automatic for the host.
  await page.evaluate(()=>window.__relaySend({type:'screenClosed',error:false,message:'Der Pi hat die Bildschirmverbindung beendet.',retry:true}));
  await page.getByText('Bild unterbrochen · verbinde neu …').waitFor();
  await page.waitForFunction(()=>window.__vnc.opens===3&&document.querySelector('.screen-status').textContent.includes('Verbunden'),null,{timeout:5000});
  assert.equal(await page.evaluate(()=>window.__relayMessages.filter(m=>m.action==='screenOpen').at(-1).auto),true,'Automatic reopen is marked for the host');

  // A host-side failure without a live SSH connection is shown honestly and is not retried.
  await page.evaluate(()=>window.__relaySend({type:'screenClosed',error:true,message:'SSH-Verbindung zum Pi beendet.',retry:false}));
  await page.waitForFunction(()=>document.querySelector('.screen-status').textContent.includes('Fehler'));
  assert((await page.locator('.screen-card').innerText()).includes('SSH-Verbindung zum Pi beendet.'));
  await page.waitForTimeout(1300);assert.equal(await page.evaluate(()=>window.__vnc.opens),3,'No automatic reconnect without SSH');

  // VNC password: asked in the window, kept in memory, never sent to the native host.
  await page.evaluate(()=>{window.__vnc.security=2;});
  await page.getByRole('button',{name:'Neu verbinden'}).click();
  await page.getByText('VNC-Anmeldung').waitFor();
  assert((await status.innerText()).includes('Anmeldung nötig'));
  await page.screenshot({path:path.join(output,'screen-viewer-login.png')});
  await page.getByLabel('Passwort').fill('geheim-123');await page.getByRole('button',{name:'Anmelden'}).click();
  await page.waitForFunction(()=>document.querySelector('.screen-status').textContent.includes('Verbunden'));
  assert(!JSON.stringify(await page.evaluate(()=>window.__relayMessages)).includes('geheim-123'),'Password never reaches the native host');
  assert.deepEqual(errors,[]);

  // Without the native host nothing pretends to connect.
  const plain=await browser.newPage({viewport:{width:700,height:500}});
  await plain.goto(base+'?screen=MeinPi');
  await plain.getByText('Integrierter Viewer',{exact:true}).waitFor();
  assert((await plain.locator('.screen-status').innerText()).includes('Nur in der App'));
  await plain.close();
  assert.equal(browser.contexts().length,1);
  console.log('PASS: toolbar order and long-press arranging (swap, Esc, saved), microphone switch (menu with Windows default, off by default, 20 ms 48 kHz mono chunks, remembered device, red marker, stop, receiver-not-ready), file drop to Pi inbox (overlay, chunks, intact, path to Pi clipboard), aspect fit requests (connect, resize end, not in 1:1), quality slider (starts at the marked optimum 7) to server and remembered, real noVNC frame via shared buffers (all released), pointer mapping (fit 1000/600 px, 1:1), aspect ratio, 480 px toolbar, German keysyms, key release on deactivate, clipboard both ways with Latin-1 notice, F11 fullscreen not forwarded, disconnect/explicit reconnect, automatic reopen while SSH stands, honest error without retry, no CSP violations, in-memory VNC password, browser-only state.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
