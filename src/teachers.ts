import { createHash } from 'node:crypto';
/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { Db } from 'mongodb';
import { StudentService } from './service';
import { OrganizationService } from './organization';
import { SmsError } from './types';
import { object, positiveInt, text } from './validation';
interface Teacher {
 _id:string;hydroUid:number;basic:{name:string;teacherNo:string;gender:string;campus:string;status:string};
 sensitive:{phone:string;wechat:string};internalNote:string;version:number;createdAt:Date;updatedAt:Date;updatedBy:number;requestHash?:string;
}
const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class TeacherService {
 constructor(private db:Db,private students:StudentService,private org:OrganizationService){}
 get teachers(){return this.db.collection<Teacher>('sms_teachers');}
 async init(){await this.teachers.createIndex({hydroUid:1},{unique:true});await this.teachers.createIndex({'basic.teacherNo':1},{unique:true,partialFilterExpression:{'basic.teacherNo':{$gt:''}}});await this.teachers.createIndex({updatedAt:-1});}
 async assignments(){const metadata=await this.org.classes.find({}).toArray(),members=await this.db.collection('domain.user').find({join:true}).project({domainId:1,uid:1}).toArray(),domains=await this.org.domains.find({}).toArray();return metadata.flatMap(c=>c.teacherUids.filter(uid=>members.some(m=>m.domainId===c.domainId&&m.uid===uid)).map(uid=>({uid,domainId:c.domainId,className:domains.find(d=>d._id===c.domainId)?.name||c.domainId})));}
 async list(actor:number,qValue:unknown='',statusValue:unknown='',pageValue:unknown=1){
  const me=await this.students.me(actor),canRead=await this.students.authorization.can(actor,'teachers.read',[]),canManage=await this.students.authorization.can(actor,'teachers.update',[]),q=text(qValue??'',80,'搜索词'),status=text(statusValue??'',10,'教师状态'),page=positiveInt(Number(pageValue),'页码');if(page>100000)throw new SmsError(400,'页码无效');if(status&&!['在职','离职','待建档'].includes(status))throw new SmsError(400,'教师状态无效');
  const assignments=await this.assignments(),profiles=await this.teachers.find(canRead?{}:{hydroUid:actor}).toArray();
  if(!canRead&&!profiles.length&&!assignments.some(a=>a.uid===actor))throw new SmsError(403,'没有教师档案访问权限');
  const uids=[...new Set([...profiles.map(t=>t.hydroUid),...assignments.filter(a=>canRead||a.uid===actor).map(a=>a.uid)])];
  const users=await this.db.collection<{_id:number;uname:string}>('user').find({_id:{$in:uids}}).project({uname:1}).toArray();
  const rows=uids.map(uid=>{const p=profiles.find(p=>p.hydroUid===uid),username=users.find(u=>u._id===uid)?.uname||`UID ${uid}`;return{id:p?._id??null,hydroUid:uid,username,name:p?.basic.name||username,teacherNo:p?.basic.teacherNo||'',campus:p?.basic.campus||'',status:p?.basic.status||'待建档',version:p?.version??0,classes:assignments.filter(a=>a.uid===uid).map(a=>({id:a.domainId,name:a.className}))};}).filter(t=>(!status||t.status===status)&&(!q||[t.name,t.username,t.teacherNo,t.campus,String(t.hydroUid)].some(v=>v.toLowerCase().includes(q.toLowerCase())))).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.hydroUid-b.hydroUid);
  return{canManage,canCreate:await this.students.authorization.can(actor,'teachers.create',[]),total:rows.length,page,pageSize:20,teachers:rows.slice((page-1)*20,page*20)};
 }
 async detail(actor:number,id:string){const p=await this.teachers.findOne({_id:id});if(!p||p.hydroUid!==actor&&!await this.students.authorization.can(actor,'teachers.read',[]))throw new SmsError(404,'教师档案不存在或无权查看');const sensitive=p.hydroUid===actor||await this.students.authorization.can(actor,'teachers.sensitive',[]),canEdit=await this.students.authorization.can(actor,'teachers.update',[]);if(sensitive)await this.students.audit(actor,'teachers.sensitive.read',id);const user=await this.db.collection<{_id:number;uname:string}>('user').findOne({_id:p.hydroUid},{projection:{uname:1}});return{id:p._id,hydroUid:p.hydroUid,username:user?.uname||`UID ${p.hydroUid}`,basic:p.basic,...sensitive?{sensitive:p.sensitive}:{},version:p.version,updatedAt:p.updatedAt,canEdit,canReadInternal:sensitive&&p.hydroUid!==actor,...sensitive&&p.hydroUid!==actor?{internalNote:p.internalNote}:{}};}
 async save(actor:number,value:unknown,id?:string){
  await this.students.requireAction(actor,id?'teachers.update':'teachers.create');await this.students.requireAction(actor,'teachers.read');const b=object(value);this.org.fields(b,['hydroUid','basic','sensitive','internalNote','version','requestId']);
  return this.org.locked('__sms_teacher_profiles__',async verify=>{
   const uid=(await this.students.assertUser(b.hydroUid))!;if(!uid)throw new SmsError(400,'请指定 Hydro UID');
   const request=text(b.requestId??'',80,'请求标识');if(!/^[a-zA-Z0-9_-]{8,80}$/.test(request))throw new SmsError(400,'请求标识无效');
   const key=id||`teacher:${actor}:${request}`,old=await this.teachers.findOne({_id:key});if(id&&!old)throw new SmsError(404,'教师档案不存在');
   if(!id&&old){if(old.requestHash!==fingerprint(b))throw new SmsError(409,'请求标识已用于其他档案');return this.detail(actor,key);}
   if(!Number.isSafeInteger(b.version)||(b.version as number)<0||(old?.version??0)!==b.version)throw new SmsError(409,'教师档案已更新，请刷新后重试');
   const basic=object(b.basic);this.org.fields(basic,['name','teacherNo','gender','campus','status']);const data={name:text(basic.name,80,'姓名'),teacherNo:text(basic.teacherNo??'',80,'工号'),gender:text(basic.gender??'',10,'性别'),campus:text(basic.campus??'',100,'校区'),status:text(basic.status??'在职',10,'在职状态')};
   if(!data.name||!['男','女','未填写',''].includes(data.gender)||!['在职','离职'].includes(data.status))throw new SmsError(400,'请填写姓名并选择有效性别和在职状态');
   if(await this.teachers.findOne({_id:{$ne:key},hydroUid:uid}))throw new SmsError(409,'该 Hydro UID 已绑定教师档案');
   if(data.teacherNo&&await this.teachers.findOne({_id:{$ne:key},'basic.teacherNo':data.teacherNo}))throw new SmsError(409,'工号已被其他教师使用');
   const sensitive=object(b.sensitive??old?.sensitive??{});this.org.fields(sensitive,['phone','wechat']);const contacts={phone:text(sensitive.phone??'',160,'电话'),wechat:text(sensitive.wechat??'',160,'微信')};
   if('sensitive'in b||'internalNote'in b)await this.students.requireAction(actor,'teachers.sensitive');
   if('internalNote'in b&&uid===actor)throw new SmsError(403,'不能访问本人内部备注');const internalNote='internalNote'in b?text(b.internalNote,3000,'内部备注'):old?.internalNote||'';
   const row:Teacher={_id:key,hydroUid:uid,basic:data,sensitive:contacts,internalNote,version:(old?.version??0)+1,createdAt:old?.createdAt??new Date(),updatedAt:new Date(),updatedBy:actor,requestHash:fingerprint(b)};
   await verify();await this.students.mutation(actor,old?'teachers.update':'teachers.create',key,['basic','sensitive','hydroUid',...('internalNote'in b?['internalNote']:[])],async()=>{if(old){const r=await this.teachers.replaceOne({_id:key,version:old.version},row);if(!r.matchedCount)throw new SmsError(409,'教师档案已更新');}else await this.teachers.insertOne(row);});return this.detail(actor,key);
  });
 }
}
