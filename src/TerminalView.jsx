import {useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './relay.css';

export function TerminalView(){
 const host=useRef(null),[message,setMessage]=useState('');
 const alias=new URLSearchParams(location.search).get('terminal');
 useEffect(()=>{
  const bridge=window.chrome?.webview;
  const term=new Terminal({cursorBlink:true,fontFamily:'Cascadia Code, Consolas, monospace',fontSize:14,scrollback:5000,theme:{background:'#17151a',foreground:'#eee5ef',cursor:'#ed648b',selectionBackground:'#b12a5066'}});
  const fit=new FitAddon();term.loadAddon(fit);term.open(host.current);fit.fit();
  const send=(action,data={})=>bridge?.postMessage({action,...data});
  const receive=e=>{
   if(e.data.type==='terminalData')term.write(Uint8Array.from(atob(e.data.data),c=>c.charCodeAt(0)));
   if(e.data.type==='terminalState')setMessage(e.data.message);
   if(e.data.type==='terminalFocus'){setMessage('');term.focus();send('terminalReady',{cols:term.cols,rows:term.rows});}
  };
  bridge?.addEventListener('message',receive);
  const input=term.onData(data=>send('terminalInput',{data}));
  let resizeTimer;const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{fit.fit();send('terminalResize',{cols:term.cols,rows:term.rows});},120);});observer.observe(host.current);
  if(bridge)send('terminalReady',{cols:term.cols,rows:term.rows});else term.writeln('\x1b[38;2;237;100;139mPi Relay · Terminalvorschau\x1b[0m\r\nDas verbundene Terminal öffnet sich in der Windows-App.');
  term.focus();return()=>{clearTimeout(resizeTimer);observer.disconnect();input.dispose();bridge?.removeEventListener('message',receive);term.dispose();};
 },[]);
 return <main className="terminal-stage"><header><span><img src="/assets/raspberry.png" alt=""/>{alias} <small>Pi Relay</small></span><span className="terminal-channel">Gemeinsame SSH-Verbindung</span></header><div className="terminal-host" ref={host}/>{message&&<div className="terminal-notice" role="status">{message}</div>}</main>;
}
