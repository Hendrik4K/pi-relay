// Windows microphone for the Pi: collects 20 ms of 48 kHz mono as s16le and reports the peak level.
// A plain file (not a blob URL), so the page's content policy can keep script-src at 'self'.
class PiRelayMic extends AudioWorkletProcessor{constructor(){super();this.buf=new Int16Array(960);this.n=0;this.peak=0;}
process(inputs){const ch=inputs[0]&&inputs[0][0];if(!ch)return true;for(let i=0;i<ch.length;i++){const v=Math.max(-1,Math.min(1,ch[i]));this.buf[this.n++]=v<0?v*32768:v*32767;const a=v<0?-v:v;if(a>this.peak)this.peak=a;
if(this.n===960){this.port.postMessage({pcm:this.buf.buffer,level:this.peak},[this.buf.buffer]);this.buf=new Int16Array(960);this.n=0;this.peak=0;}}return true;}}
registerProcessor('pi-relay-mic',PiRelayMic);
