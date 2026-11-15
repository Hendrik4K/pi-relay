// Display language. The UI is written in German; for English, visible texts and the title/aria-label/
// placeholder/alt attributes are swapped from a dictionary as they appear (also the host's and the Pi's
// messages). Nothing in the app logic changes, and switching back restores the German texts exactly.
import { EN, PATTERNS } from './i18n-en.js';

let lang = 'de', observer = null;
const textOriginal = new WeakMap(), textWritten = new WeakMap();   // text node -> German / what we wrote
const attrOriginal = new WeakMap();                                // element -> {attr: [German, written]}
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

export function translate(text) {
 if (lang !== 'en' || !text) return text;
 const core = text.trim(); if (!core) return text;
 let out = EN[core];
 if (out === undefined) for (const [re, make] of PATTERNS) { const m = core.match(re); if (m) { out = make(m); break; } }
 if (out === undefined) return text;
 return text.slice(0, text.indexOf(core)) + out + text.slice(text.indexOf(core) + core.length);
}

function textNode(node) {
 const value = node.nodeValue, written = textWritten.get(node);
 if (lang !== 'en') {                                              // back to German: restore what React wrote
  if (written !== undefined) { const de = textOriginal.get(node); textOriginal.delete(node); textWritten.delete(node); if (value === written) node.nodeValue = de; }
  return;
 }
 if (written !== undefined && value === written) return;           // our own write coming back
 const english = translate(value);
 if (english === value) { textOriginal.delete(node); textWritten.delete(node); return; }
 textOriginal.set(node, value); textWritten.set(node, english); node.nodeValue = english;
}

function element(el) {
 let saved = attrOriginal.get(el);
 for (const name of ATTRS) {
  if (!el.hasAttribute(name)) continue;
  const value = el.getAttribute(name), entry = saved?.[name];
  if (lang !== 'en') { if (entry) { if (entry[1] === value) el.setAttribute(name, entry[0]); delete saved[name]; } continue; }
  if (entry && entry[1] === value) continue;
  const english = translate(value);
  if (english === value) { if (entry) delete saved[name]; continue; }
  if (!saved) { saved = {}; attrOriginal.set(el, saved); }
  saved[name] = [value, english]; el.setAttribute(name, english);
 }
}

function walk(root) {
 if (root.nodeType === Node.TEXT_NODE) { if (!root.parentElement?.closest('script,style,textarea,.xterm')) textNode(root); return; }
 if (root.nodeType !== Node.ELEMENT_NODE) return;
 if (root.closest('script,style,.xterm')) return;
 element(root);
 const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
 let n; while ((n = it.nextNode())) { if (n.nodeType === Node.TEXT_NODE) { if (!n.parentElement?.closest('script,style,textarea,.xterm')) textNode(n); } else if (!n.closest('.xterm')) element(n); }
}

export function setLanguage(next) {
 next = next === 'en' ? 'en' : 'de';
 if (next === lang) return;
 lang = next; document.documentElement.lang = lang;
 if (!observer) {
  observer = new MutationObserver(list => {
   for (const m of list) {
    if (m.type === 'characterData') textNode(m.target);
    else if (m.type === 'attributes') element(m.target);
    else m.addedNodes.forEach(walk);
   }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
 }
 walk(document.body);
}
export const language = () => lang;

// Before the host tells us (previews, terminal window): ?lang=en
const query = new URLSearchParams(location.search).get('lang');
if (query) queueMicrotask(() => setLanguage(query));
