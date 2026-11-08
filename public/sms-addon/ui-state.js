/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
 const app=document.getElementById('sms-app');if(!app)return;
 const pending=new Map(),guarded=new Set();let navigating=false,acceptedURL=location.href,authorityInvalidated=false;
 function readLocation(){pending.clear();const url=new URL(location.href);for(const [key,value]of url.searchParams){const match=/^sms\.([a-z]+)\.([a-zA-Z]+)$/.exec(key);if(match){if(!pending.has(match[1]))pending.set(match[1],{});pending.get(match[1])[match[2]]=value;}}}
 readLocation();
 function historyRoute(){if(!app.isConnected)return;if(location.href===acceptedURL)return;if(!allowNavigation()){history.replaceState(null,'',acceptedURL);return;}readLocation();acceptedURL=location.href;app.dispatchEvent(new CustomEvent('sms:route'));}
 window.addEventListener('popstate',historyRoute);window.addEventListener('hashchange',historyRoute);
 function list(key,page,fields){const saved=pending.get(key);if(saved){pending.delete(key);page=Number(saved.page)||1;for(const [name,node]of Object.entries(fields))if(Object.hasOwn(saved,name)){if(node.tagName==='SELECT'&&saved[name]&&![...node.options].some(o=>o.value===saved[name])){const o=document.createElement('option');o.value=o.textContent=saved[name];node.append(o);}node.value=saved[name];}}
  page=Math.max(1,Math.min(100000,Math.trunc(page)||1));const url=new URL(location.href);url.searchParams.set(`sms.${key}.page`,page);for(const [name,node]of Object.entries(fields)){const value=node.value;if(value)url.searchParams.set(`sms.${key}.${name}`,value);else url.searchParams.delete(`sms.${key}.${name}`);}history.replaceState(null,'',url);acceptedURL=location.href;return page;
 }
 function snapshot(d){return JSON.stringify([...d.querySelectorAll('input,select,textarea')].filter(n=>!n.disabled&&!n.readOnly&&!['hidden','search','file','submit','button'].includes(n.type)&&n.name!=='accountSearch').map(n=>[n.name||n.id,n.type==='checkbox'||n.type==='radio'?n.checked:n.multiple?[...n.selectedOptions].map(o=>o.value):n.value]));}
 const baselines=new WeakMap();
 function editable(d){return !d.classList.contains('sms-members-dialog')&&!!d.querySelector('button[type=submit]:not([hidden]),button:not([type])[data-sms-save]');}
 function dirty(d){return d.open&&editable(d)&&baselines.has(d)&&baselines.get(d)!==snapshot(d);}
 function saved(d){baselines.set(d,snapshot(d));}
 function guard(d){if(guarded.has(d))return;guarded.add(d);const close=d.close.bind(d),show=d.showModal.bind(d);
  d.showModal=(...args)=>{if(authorityInvalidated||!app.isConnected)return;const result=show(...args);queueMicrotask(()=>saved(d));return result;};
  d.close=(...args)=>{if(dirty(d)&&!confirm('有未保存的修改，确认放弃？'))return;close(...args);};
  d.addEventListener('cancel',e=>{e.preventDefault();d.close();});d.addEventListener('close',()=>baselines.delete(d));if(d.open)saved(d);
 }
 function allowNavigation(){const dirtyDialogs=[...guarded].filter(dirty);if(dirtyDialogs.length&&!confirm('有未保存的修改，确认放弃并切换页面？'))return false;for(const d of guarded){saved(d);if(d.open)d.close();}return true;}
 function closePrivateDialogs(){for(const d of document.querySelectorAll('dialog[open]'))if([...d.classList].some(c=>c.startsWith('sms-'))){saved(d);d.close();}}
 function observe(){if(authorityInvalidated)closePrivateDialogs();for(const d of guarded)if(!d.isConnected)guarded.delete(d);for(const d of app.querySelectorAll('dialog'))if(!d.classList.contains('sms-bulk-dialog')&&d.querySelector('form')&&!d.querySelector('form[method=dialog]'))guard(d);}
 const observer=new MutationObserver(()=>{if(!app.isConnected){observer.disconnect();return;}observe();});observer.observe(document.body,{childList:true,subtree:true});observe();
 window.addEventListener('beforeunload',e=>{if(app.isConnected&&!navigating&&[...guarded].some(dirty)){e.preventDefault();e.returnValue='';}});
 app.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(a&&!a.target&&[...guarded].some(dirty)&&!allowNavigation()){e.preventDefault();e.stopImmediatePropagation();}},true);
 function navigate(tab){if(!allowNavigation())return false;const url=new URL(location.href);if(url.hash!==`#${tab}`){url.hash=tab;history.pushState(null,'',url);}acceptedURL=location.href;return true;}
 function authorityChanged(){if(authorityInvalidated)return;authorityInvalidated=true;
  // Do not keep rendering a previous authority's private data or in-flight results.
  // An unsaved editor is retained behind a blocking layer until the user elects
  // to discard it; no drafts containing student data enter localStorage.
  if([...guarded].some(dirty)&&!confirm('访问权限已变化，需要刷新页面；确认放弃未保存的修改？')){
   app.hidden=true;app.inert=true;closePrivateDialogs();
   const box=document.createElement('div');box.className='section section__body';box.setAttribute('role','alert');box.append(document.createTextNode('访问权限已变化。'));const button=document.createElement('button');button.className='rounded button';button.textContent='刷新页面';button.onclick=()=>{if(confirm('刷新会放弃未保存的修改，确认继续？')){navigating=true;location.reload();}};box.append(button);app.before(box);return;
  }
  navigating=true;app.hidden=true;closePrivateDialogs();location.reload();
 }
 globalThis.SmsUI={list,saved,guard,allowNavigation,navigate,authorityChanged};
})();
