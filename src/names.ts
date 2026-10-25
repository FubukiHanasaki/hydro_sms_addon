/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import type { Db } from 'mongodb';
import type { Context } from 'hydrooj';
import { AuthorizationService } from './authorization';
export interface AccountName { uid:number; username:string; profileName:string; displayName:string; staff:boolean; canViewProfileName:boolean }
// Name visibility is independent of profile/contact permissions and native Hydro roles.
export class NameService {
 constructor(private db:Db){}
 async staffIds(){
  const auth=new AuthorizationService(this.db),[policy,config,teachers]=await Promise.all([auth.policy(),auth.config(),this.db.collection('sms_teachers').distinct('hydroUid')]);
  return new Set<number>([...policy.admins,...config.bindings.filter(b=>['office','readonly'].includes(b.templateId)).map(b=>b.uid),...teachers].filter((uid):uid is number=>Number.isSafeInteger(uid)&&uid>0));
 }
 async visibleIds(actor:number){const staff=await this.staffIds();return actor>0&&staff.has(actor)?null:new Set([...staff,...actor>0?[actor]:[]]);}
 async resolve(actor:number,values:Iterable<number>):Promise<Map<number,AccountName>>{
  const uids=[...new Set(values)].filter(uid=>Number.isSafeInteger(uid)&&uid>0),staff=await this.staffIds(),all=actor>0&&staff.has(actor),visible=uids.filter(uid=>all||uid===actor||staff.has(uid));
  const [users,teachers,students]=await Promise.all([
   this.db.collection<{_id:number;uname:string}>('user').find({_id:{$in:uids}},{projection:{uname:1}}).toArray(),
   this.db.collection('sms_teachers').find({hydroUid:{$in:visible}},{projection:{hydroUid:1,'basic.name':1}}).toArray(),
   this.db.collection('sms_students').find({hydroUid:{$in:visible}},{projection:{hydroUid:1,'basic.name':1}}).toArray(),
  ]);
  const teacherMap=new Map(teachers.map(p=>[p.hydroUid,p.basic?.name])),studentMap=new Map(students.map(p=>[p.hydroUid,p.basic?.name]));
  return new Map(users.map(u=>{const profileName=String(teacherMap.get(u._id)||studentMap.get(u._id)||'');return [u._id,{uid:u._id,username:u.uname,profileName,displayName:profileName&&profileName!==u.uname?`${profileName} (${u.uname})`:u.uname,staff:staff.has(u._id),canViewProfileName:all||u._id===actor||staff.has(u._id)}];}));
 }
 async project<T>(actor:number,value:T):Promise<T>{
  const ids=new Set<number>(),seen=new WeakSet<object>();
  const identity=(v:any)=>typeof v.uname==='string'&&Number.isSafeInteger(v._id)?v._id:Number.isSafeInteger(v.hydroUid)?v.hydroUid:Number.isSafeInteger(v.uid)?v.uid:null;
  const scan=(v:any)=>{if(!v||typeof v!=='object'||v instanceof Date||Buffer.isBuffer(v)||seen.has(v))return;seen.add(v);const id=identity(v);if(id&&('uname'in v||'username'in v||'name'in v||'studentName'in v||'basic'in v))ids.add(id);if(Number.isSafeInteger(v.teacherUid)&&'teacherName'in v)ids.add(v.teacherUid);for(const[k,item]of Object.entries(v))if(!k.startsWith('_'))scan(item);};
  scan(value);if(!ids.size)return value;const names=await this.resolve(actor,ids),copies=new WeakMap<object,any>();
  const copy=(v:any):any=>{if(!v||typeof v!=='object'||v instanceof Date||Buffer.isBuffer(v)||v._bsontype)return v;if(copies.has(v))return copies.get(v);const out=Array.isArray(v)?[]:Object.create(Object.getPrototypeOf(v));copies.set(v,out);for(const[k,item]of Object.entries(v))Object.defineProperty(out,k,{value:k.startsWith('_')?item:copy(item),writable:true,enumerable:true,configurable:true});
   const identityFields='uname'in v||'username'in v||'name'in v||'studentName'in v||'basic'in v;
   const name=identityFields?names.get(identity(v)):undefined;if(name){
    if(typeof v.uname==='string'){out.displayName=name.profileName;out.smsDisplayName=name.displayName;if(Array.isArray(v._publicFields))out._publicFields=[...new Set([...v._publicFields,'smsDisplayName'])];}
    else {out.displayName=name.displayName;out.profileName=name.profileName;}
    if(v.basic&&typeof v.basic.name==='string'&&!name.canViewProfileName)out.basic.name=name.username;
    if(out.capabilities&&v.basic)out.capabilities.editName=name.canViewProfileName;
    if('studentName'in v)out.studentName=name.canViewProfileName?(name.profileName||v.studentName||null):null;
    if('name'in v)out.name=name.displayName;
   }
   if('teacherName'in v&&names.has(v.teacherUid))out.teacherName=names.get(v.teacherUid)!.displayName;
   return out;
  };return copy(value);
 }
 async exportNames(actor:number,headers:string[],rows:any[][]){
  const uidColumn=headers.findIndex(h=>['UID','Hydro UID','学生 UID'].includes(h)),nameColumns=headers.flatMap((h,i)=>['姓名','学生','关联学生','学生姓名'].includes(h)?[i]:[]);
  if(uidColumn<0||!nameColumns.length)return rows;
  const names=await this.resolve(actor,rows.map(r=>Number(r[uidColumn])));
  return rows.map(r=>{const n=names.get(Number(r[uidColumn]));if(!n)return r;const result=[...r];for(const i of nameColumns)if(!n.canViewProfileName)result[i]=n.username;return result;});
 }
}
export function installNames(ctx:Context,names:NameService){
 ctx.on('handler/after',async(h:any)=>{
  const actor=h.user?._id??0;
  const body=await names.project(actor,h.response.body),changed=body!==h.response.body;h.response.body=body;
  if(changed||h.response.template){h.response.addHeader('Cache-Control','private, no-store');h.response.addHeader('Vary','Cookie, Authorization');}
  if(h.response.template){h.user=await names.project(actor,h.user);if(h.UiContext)Object.assign(h.UiContext,await names.project(actor,h.UiContext));}
 });
}
