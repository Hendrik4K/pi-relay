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
 const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));return btoa(s);};
 const vnc=window.__vnc={security:1,keys:[],pointers:[],cut:[],frames:0,opens:0,state:'off',buffer:new Uint8Array(0),width:800,height:600};
 const u16=v=>[v>>8&255,v&255],u32=v=>[v>>>24&255,v>>16&255,v>>8&255,v&255];
 function reply(bytes){bytes=bytes instanceof Uint8Array?bytes:Uint8Array.from(bytes);for(let i=0;i<bytes.length;i+=32768){const part=bytes.subarray(i,i+32768);setTimeout(()=>deliver({type:'screenData',data:b64(part)}),0);}}
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
  addEventListener:(...a)=>events.addEventListener(...a),removeEventListener:(...a)=>events.removeEventListener(...a),
  postMessage:m=>{
   if(m.action!=='screenSend')window.__relayMessages.push(m);
   if(m.action==='screenReady')setTimeout(()=>deliver({type:'screenInit',alias:'MasterControl',version:'0.4.0',autoConnect:true,fullscreen:false}),0);
   if(m.action==='screenOpen'){vnc.opens++;vnc.state='version';vnc.buffer=new Uint8Array(0);setTimeout(()=>{deliver({type:'screenOpened'});reply([...'RFB 003.008\n'].map(c=>c.charCodeAt(0)));},5);}
   if(m.action==='screenSend'){const chunk=Uint8Array.from(atob(m.data),c=>c.charCodeAt(0));const all=new Uint8Array(vnc.buffer.length+chunk.length);all.set(vnc.buffer);all.set(chunk,vnc.buffer.length);vnc.buffer=all;pump();}
   if(m.action==='screenUpload'){const chunk=Uint8Array.from(atob(m.data),c=>c.charCodeAt(0));const prev=(window.__uploads||={})[m.token]||new Uint8Array(0);const all=new Uint8Array(prev.length+chunk.length);all.set(prev);all.set(chunk,prev.length);window.__uploads[m.token]=all;(window.__uploadChunks||=[]).push(m.offset);setTimeout(()=>deliver({type:'screenUploadResult',id:m.id,ok:true,result:m.final?{path:'/home/pi/Desktop/'+m.name,size:all.length}:{size:all.length}}),5);}
   if(m.action==='screenInfo')setTimeout(()=>deliver({type:'screenInfo',info:{os:'Raspberry Pi OS Trixie',host:'Raspi5',server:'x11vnc'}}),0);
   if(m.action==='screenDisconnect')vnc.state='off';
   if(m.action==='screenFullscreen')setTimeout(()=>deliver({type:'screenFullscreen',on:m.on}),0);
   if(m.action==='screenClipboardRead')setTimeout(()=>deliver({type:'screenClipboardText',text:window.__windowsClipboard||'',reason:m.reason}),0);
  }
 };
}

(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PI_RELAY_CHROME?{executablePath:process.env.PI_RELAY_CHROME}:{})});
 const output=path.resolve(__dirname,'../qa');fs.mkdirSync(output,{recursive:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(mockHost);
  await page.goto(base+'?screen=MasterControl');
  const status=page.locator('.screen-status');
  await page.waitForFunction(()=>document.querySelector('.screen-status')?.textContent.includes('Verbunden')&&window.__vnc.frames>0);
  await page.waitForTimeout(150);
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
  await page.locator('.screen-host',{hasText:'Raspi5'}).waitFor();
  assert.equal(await page.locator('.screen-os').innerText(),'Raspberry Pi OS Trixie');
  assert(!(await page.locator('.screen-title').innerText()).includes('MasterControl'),'Access name only in the window title');
  assert((await page.locator('.screen-status').innerText()).includes('x11vnc'),'VNC server shown next to the status');
  assert.equal(await page.locator('.screen-host').evaluate(e=>getComputedStyle(e).color),'rgb(226, 87, 127)');
  const firstFit=await page.evaluate(()=>window.__relayMessages.find(m=>m.action==='screenFit'));
  assert(firstFit&&Math.abs(firstFit.dw-(Math.round(654*4/3)-1000))<=1&&firstFit.dh===0,'Initial fit request: '+JSON.stringify(firstFit));
  let box=await mapsPointer(400,300,'Fit 1000px');
  assert(Math.abs(box.width/box.height-4/3)<.01&&box.height<=700-46+1,'Fit keeps 4:3 inside the window');
  await mapsPointer(37,551,'Fit corner');
  await page.screenshot({path:path.join(output,'screen-viewer-1000.png')});

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
  // Quality slider: sent to the server as noVNC quality pseudo-encoding and remembered.
  await page.getByLabel('Bildqualität').fill('9');
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

  // Disconnect releases only the VNC stream; reconnect is an explicit click.
  await page.getByRole('button',{name:'Trennen'}).click();
  await page.waitForFunction(()=>document.querySelector('.screen-status').textContent.includes('Getrennt'));
  assert(await page.evaluate(()=>window.__relayMessages.some(m=>m.action==='screenDisconnect')));
  await page.getByRole('button',{name:'Neu verbinden'}).click();
  await page.waitForFunction(()=>window.__vnc.opens===2&&document.querySelector('.screen-status').textContent.includes('Verbunden'));

  // A host-side failure is shown honestly and is not retried automatically.
  await page.evaluate(()=>window.__relaySend({type:'screenClosed',error:true,message:'SSH-Verbindung zum Pi beendet.'}));
  await page.waitForFunction(()=>document.querySelector('.screen-status').textContent.includes('Fehler'));
  assert((await page.locator('.screen-card').innerText()).includes('SSH-Verbindung zum Pi beendet.'));
  await page.waitForTimeout(800);assert.equal(await page.evaluate(()=>window.__vnc.opens),2,'No automatic reconnect');

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
  await plain.goto(base+'?screen=MasterControl');
  await plain.getByText('Integrierter Viewer',{exact:true}).waitFor();
  assert((await plain.locator('.screen-status').innerText()).includes('Nur in der App'));
  await plain.close();
  assert.equal(browser.contexts().length,1);
  console.log('PASS: file drop to Pi inbox (overlay, chunks, intact, path to Pi clipboard), aspect fit requests (connect, resize end, not in 1:1), quality slider to server and remembered, real noVNC frame, pointer mapping (fit 1000/600 px, 1:1), aspect ratio, 480 px toolbar, German keysyms, key release on deactivate, clipboard both ways with Latin-1 notice, F11 fullscreen not forwarded, disconnect/explicit reconnect, honest error without retry, in-memory VNC password, browser-only state.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
