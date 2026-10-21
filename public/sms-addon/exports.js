/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
 const app=document.getElementById('sms-app'),native=document.querySelector('[data-sms-native-rating]');
 const profile=document.querySelector('[data-sms-profile-rating]');const api=app?.dataset.api||native?.dataset.historyApi?.replace(/\/rating\/users$/,'/students')||profile?.dataset.api?.replace(/\/rating\/users\/\d+$/,'/students');if(!api)return;
 const base=api.replace(/\/students$/,'/exports');let opened;
 function control(label,kind,query=()=>({}),options={}){
  const wrap=document.createElement('span');wrap.className='sms-export-control';const toggle=document.createElement('button');toggle.type='button';toggle.className='rounded button sms-export-toggle';toggle.textContent=label;toggle.setAttribute('aria-expanded','false');const menu=document.createElement('span');menu.className='sms-export-menu';menu.hidden=true;if(typeof menu.showPopover==='function')menu.setAttribute('popover','manual');menu.setAttribute('aria-label',label+'格式');
  let sensitive;
  if(options.sensitive){const l=document.createElement('label');sensitive=document.createElement('input');sensitive.type='checkbox';l.append(sensitive,document.createTextNode('包含有权查看的联系资料'));menu.append(l);}
  const error=document.createElement('span');error.className='sms-export-error';error.setAttribute('role','alert');
  for(const [format,text]of [['xlsx','Excel (.xlsx)'],['csv','CSV (.csv)']]){const b=document.createElement('button');b.type='button';b.className='link';b.textContent=text;b.addEventListener('click',async e=>{e.stopPropagation();if(b.disabled)return;for(const item of menu.querySelectorAll('button'))item.disabled=true;error.textContent='';try{const q=query();if(!q)throw Error('请先查询列表');const url=new URL(`${base}/${kind}`,location.origin);url.search=new URLSearchParams({...q,format,...(sensitive?{sensitive:String(sensitive.checked)}:{})});url.searchParams.delete('page');const response=await fetch(url,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/octet-stream'}});if(!response.ok){let result;try{result=await response.json();}catch{}throw Error(result?.message||'导出失败，请重试');}const disposition=response.headers.get('content-disposition')||'',encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition),a=document.createElement('a');a.download=encoded?decodeURIComponent(encoded[1]):`export.${format}`;a.href=URL.createObjectURL(await response.blob());a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);hide(wrap);}catch(e){error.textContent=e.message;}finally{for(const item of menu.querySelectorAll('button'))item.disabled=false;}});menu.append(b);}
  menu.append(error);wrap.append(toggle,menu);
  toggle.addEventListener('click',e=>{
   e.stopPropagation();if(opened&&opened!==wrap)hide(opened);
   if(!menu.hidden){hide(wrap);return;}
   menu.hidden=false;toggle.setAttribute('aria-expanded','true');opened=wrap;
   if(menu.hasAttribute('popover')){
    menu.showPopover();const box=menu.getBoundingClientRect(),anchor=toggle.getBoundingClientRect();
    menu.style.left=`${Math.max(8,Math.min(innerWidth-box.width-8,anchor.right-box.width))}px`;
    menu.style.top=`${Math.max(8,Math.min(innerHeight-box.height-8,anchor.bottom+5+box.height>innerHeight-8?anchor.top-box.height-5:anchor.bottom+5))}px`;
   }else{menu.style.right='0';menu.style.left='auto';const box=menu.getBoundingClientRect();if(box.left<8){menu.style.left='0';menu.style.right='auto';}}
  });
  menu.addEventListener('click',e=>e.stopPropagation());return wrap;
 }
 function hide(wrap){if(!wrap)return;const menu=wrap.querySelector('.sms-export-menu');if(menu.hasAttribute('popover')&&menu.matches(':popover-open'))menu.hidePopover();menu.hidden=true;wrap.querySelector('button').setAttribute('aria-expanded','false');}
 document.addEventListener('click',()=>hide(opened));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&opened&&!opened.querySelector('.sms-export-menu').hidden){hide(opened);opened.querySelector('button').focus();e.stopPropagation();e.preventDefault();}},true);
 window.addEventListener('resize',()=>hide(opened));
 document.addEventListener('scroll',()=>{if(!opened)return;const menu=opened.querySelector('.sms-export-menu');if(menu.hidden||!menu.hasAttribute('popover'))return;const box=menu.getBoundingClientRect(),anchor=opened.querySelector('button').getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(innerWidth-box.width-8,anchor.right-box.width))}px`;menu.style.top=`${Math.max(8,Math.min(innerHeight-box.height-8,anchor.bottom+5+box.height>innerHeight-8?anchor.top-box.height-5:anchor.bottom+5))}px`;},true);

 globalThis.SmsExport={control};
 for(const source of document.querySelectorAll('[data-sms-export]')){
  const kind=source.dataset.smsExport;let provider=()=>{if(['audit','permissions'].includes(kind))return {};const saved=app?.dataset[`export${({students:'Students',accounts:'Accounts',classes:'Classes',rating:'Rating'})[kind]}`];return saved?JSON.parse(saved):null;};
  if(native)provider=()=>Object.fromEntries(new URLSearchParams(location.search));const wrapper=control(source.textContent,kind,provider,{sensitive:kind==='students'});if(source.hidden)wrapper.hidden=true;source.replaceWith(wrapper);
 }
})();
