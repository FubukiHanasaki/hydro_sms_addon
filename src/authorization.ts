/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { randomUUID } from 'node:crypto';
import { Db } from 'mongodb';
import { Policy, SmsError } from './types';
import { object, positiveInt, text, zonedInstant } from './validation';
export const MODULES = {
 students: ['学生档案', {read:'查看基本资料',sensitive:'查看敏感资料',write:'修改资料',bind:'绑定账号',create:'创建学生',import:'批量导入',promote:'批量升年级',export:'导出基本资料'}],
 classes: ['班级与子域',{read:'查看',create:'创建',update:'修改资料',members:'管理成员',teachers:'分配教师',archive:'归档',export:'导出'}],
 teachers: ['教师档案',{read:'查看基本资料',sensitive:'查看联系资料',create:'创建',update:'修改'}],
 schedules: ['排课管理',{read:'查看',create:'创建计划',update:'修改计划',adjust:'调课停课与补课',batch:'批量排课',export:'导出'}],
 courses: ['课程与考勤',{read:'查看',create:'登记课程',update:'修改课程与考勤',link:'关联已有课程',roster:'补充班外学生',export:'导出'}],
 reports: ['教务报表',{read:'查看',export:'导出'}],
 accounts: ['账户管理',{read:'查看',create:'创建账号',rename:'修改用户名',password:'重置密码',status:'启停账号',provision:'批量补建账号',export:'导出'}],
 rating: ['Rating 管理',{configure:'比赛设置',import:'导入历史',recalculate:'重新结算'}],
 audit: ['操作记录',{read:'查看',export:'导出'}],
} as const;
export const GLOBAL_ONLY = new Set(['classes.create','schedules.batch','students.create','students.import','students.promote',...Object.keys(MODULES.teachers[1]).map(k=>`teachers.${k}`),...Object.keys(MODULES.accounts[1]).map(k=>`accounts.${k}`),...Object.keys(MODULES.rating[1]).map(k=>`rating.${k}`),...Object.keys(MODULES.audit[1]).map(k=>`audit.${k}`)]);
export const CODES = Object.entries(MODULES).flatMap(([m,[,actions]])=>Object.keys(actions).map(a=>`${m}.${a}`));
type Scope = 'all' | 'teaching' | 'member';
interface Template { id:string;name:string;rules:Record<string,Scope>;builtin?:boolean }
interface Binding { uid:number;templateId:string }
interface Grant { id:string;uid:number;permissions:string[];classIds:'all'|string[];startsAt:string;expiresAt:string|null;reason:string;createdBy:number;createdAt:string;revokedAt?:string }
interface Config { _id:string;revision:number;templates:Template[];bindings:Binding[];grants:Grant[] }
const rules=(codes:string[],scope:Scope='all')=>Object.fromEntries(codes.map(c=>[c,scope]));
export const BUILTINS:Template[] = [
 {id:'legacy',name:'现有身份权限',builtin:true,rules:{}},
 {id:'office',name:'教务',builtin:true,rules:rules(CODES.filter(c=>!c.startsWith('accounts.')&&!c.startsWith('audit.')&&!c.startsWith('rating.')&&c!=='students.promote'))},
 {id:'teaching',name:'任课教师',builtin:true,rules:rules(['students.read','students.export','classes.read','classes.export','schedules.read','schedules.export','courses.read','courses.create','courses.update','courses.link','reports.read'],'teaching')},
 {id:'readonly',name:'只读教务',builtin:true,rules:rules(CODES.filter(c=>c.endsWith('.read')||c.endsWith('.export')).filter(c=>!c.startsWith('accounts.')&&!c.startsWith('audit.')))},
 {id:'self',name:'学生本人',builtin:true,rules:rules(['classes.read','schedules.read','courses.read'],'member')},
 {id:'none',name:'无业务默认权限',builtin:true,rules:{}},
];
export class AuthorizationService {
 constructor(private db:Db){}
 get collection(){return this.db.collection<Config>('sms_authorization');}
 async config(){return await this.collection.findOne({_id:'global'})??{_id:'global',revision:0,templates:[],bindings:[],grants:[]};}
 async policy():Promise<Policy>{return await this.db.collection<Policy>('sms_policy').findOne({_id:'global'})??{_id:'global',admins:[],grants:[],revision:0};}
 async admin(uid:number){return uid>0&&(await this.policy()).admins.includes(uid);}
 async requireAdmin(uid:number){if(!await this.admin(uid))throw new SmsError(403,'需要插件管理员授权');}
 catalog(){return Object.entries(MODULES).map(([id,[label,actions]])=>({id,label,actions:Object.entries(actions).map(([a,label])=>({code:`${id}.${a}`,label,globalOnly:GLOBAL_ONLY.has(`${id}.${a}`)}))}));}
 async teaching(uid:number){const taught=await this.db.collection('sms_classes').distinct('domainId',{teacherUids:uid});return this.db.collection('domain.user').distinct('domainId',{domainId:{$in:taught},uid,join:true});}
 // A Hydro membership is independent of student/teacher profile binding.
 // Member-scoped rules grant only the ordinary read scope; fullRead and the
 // student/sensitive-data policies remain separate authorization decisions.
 async members(uid:number){
  if(!Number.isSafeInteger(uid)||uid<=0)return [];
  return this.db.collection('domain.user').distinct('domainId',{uid,join:true});
 }
 async scope(uid:number,code:string,config?:Config,knownAdmin?:boolean):Promise<string[]|null>{
  if(uid<=0||!CODES.includes(code))return [];
  if(knownAdmin??await this.admin(uid))return null;
  const c=config??await this.config(),binding=c.bindings.find(b=>b.uid===uid),template=[...BUILTINS,...c.templates].find(t=>t.id===(binding?.templateId??'legacy'));
  let base=template?.rules[code];
  if(template?.id==='legacy'){
   if(['classes.read','schedules.read','courses.read','classes.export','schedules.export','courses.export','reports.export'].includes(code))base='member';
   if(['courses.create','courses.update','courses.link','reports.read'].includes(code))base='teaching';
  }
  if(base==='all')return null;
  const ids=new Set<string>(base==='teaching'?await this.teaching(uid):base==='member'?await this.members(uid):[]),now=Date.now();
  for(const g of c.grants.filter(g=>g.uid===uid&&!g.revokedAt&&Date.parse(g.startsAt)<=now&&(!g.expiresAt||Date.parse(g.expiresAt)>now)&&g.permissions.includes(code))){
   if(g.classIds==='all')return null;for(const id of g.classIds)ids.add(id);
  }
  return [...ids];
 }
 async fullRead(uid:number,id:string){
  if(await this.admin(uid))return true;const c=await this.config(),binding=c.bindings.find(b=>b.uid===uid),t=[...BUILTINS,...c.templates].find(t=>t.id===(binding?.templateId??'legacy'));
  if(t?.id==='legacy'&&(await this.teaching(uid)).includes(id))return true;
  for(const code of ['classes.read','courses.read','reports.read','courses.create','courses.update','classes.members']){
   if(t?.rules[code]&&t.rules[code]!=='member'&&await this.can(uid,code,[id]))return true;
   if(c.grants.some(g=>g.uid===uid&&!g.revokedAt&&Date.parse(g.startsAt)<=Date.now()&&(!g.expiresAt||Date.parse(g.expiresAt)>Date.now())&&g.permissions.includes(code)&&(g.classIds==='all'||g.classIds.includes(id))))return true;
  }return false;
 }
 async can(uid:number,code:string,classIds?:string[]){const ids=await this.scope(uid,code);return ids===null||!!(classIds?.length?classIds.every(id=>ids.includes(id)):classIds?false:ids.length);}
 async require(uid:number,code:string,classIds:string[]=[]){if(!await this.can(uid,code,classIds)){await this.db.collection('sms_audit').insertOne({uid,action:'authorization.denied',target:code,fields:classIds,at:new Date(),outcome:'denied'});throw new SmsError(403,`没有对应操作权限或超出班级范围：${code}`);}}
 async snapshot(uid:number){const c=await this.config(),admin=await this.admin(uid),scopes:Record<string,string[]|null>=Object.fromEntries(await Promise.all(CODES.map(async code=>[code,await this.scope(uid,code,c,admin)])));return {catalog:this.catalog(),classes:(await this.db.collection('domain').find({},{projection:{_id:1,name:1}}).toArray()).filter(d=>admin||Object.entries(scopes).some(([code,ids])=>!GLOBAL_ONLY.has(code)&&(ids===null||ids.includes(String(d._id))))).map(d=>({id:String(d._id),name:d.name||String(d._id)})),legacyGrants:(await this.policy()).grants.filter(g=>g.uid===uid&&(!g.expiresAt||Date.parse(g.expiresAt)>Date.now())),templateName:[...BUILTINS,...c.templates].find(t=>t.id===(c.bindings.find(b=>b.uid===uid)?.templateId??'legacy'))?.name,admin,revision:c.revision,templateId:c.bindings.find(b=>b.uid===uid)?.templateId??'legacy',scopes,capabilities:Object.fromEntries(Object.entries(scopes).map(([code,ids])=>[code,ids===null||!!ids.length]))};}
 async searchAccounts(actor:number,query:unknown){
  await this.requireAdmin(actor);
  const q=text(query??'',80,'账号搜索词');if(!q)return [];
  const pattern=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),match={$regex:pattern,$options:'i'};
  return this.db.collection('user').aggregate([
   {$match:{_id:{$gt:0}}},
   {$lookup:{from:'sms_students',localField:'_id',foreignField:'hydroUid',pipeline:[{$project:{_id:0,'basic.name':1}}],as:'student'}},
   {$lookup:{from:'sms_teachers',localField:'_id',foreignField:'hydroUid',pipeline:[{$project:{_id:0,'basic.name':1}}],as:'teacher'}},
   {$match:{$or:[{uname:match},{'student.basic.name':match},{'teacher.basic.name':match},.../^\d+$/.test(q)?[{_id:Number(q)}]:[]]}},
   {$set:{exactUid:{$eq:['$_id',Number(q)]}}},{$sort:{exactUid:-1,_id:1}},{$limit:20},
   {$project:{_id:0,uid:'$_id',username:'$uname',studentName:{$ifNull:[{$first:'$student.basic.name'},null]},teacherName:{$ifNull:[{$first:'$teacher.basic.name'},null]}}},
  ]).toArray();
 }
 async manage(uid:number){await this.requireAdmin(uid);const c=await this.config();return {...c,templates:[...BUILTINS,...c.templates],catalog:this.catalog(),classes:await this.db.collection('domain').find({},{projection:{_id:1,name:1}}).sort({_id:1}).toArray()};}
 async update(uid:number,value:unknown){
  await this.requireAdmin(uid);const b=object(value),c=await this.config();if(b.revision!==c.revision)throw new SmsError(409,'权限配置已变化，请刷新');
  const unknown=Object.keys(b).filter(k=>!['revision','action','uid','templateId','name','rules','permissions','classIds','startsAt','expiresAt','reason','id'].includes(k));if(unknown.length)throw new SmsError(400,'授权包含未知字段');
  const action=text(b.action,30,'操作'),target=action==='template'?0:positiveInt(b.uid,'Hydro UID');
  if(target){if(!await this.db.collection('user').findOne({_id:target as never}))throw new SmsError(400,'账号不存在');if((await this.policy()).admins.includes(target))throw new SmsError(400,'插件管理员由服务器 CLI 维护');}
  if(action==='bind'){
   const templateId=text(b.templateId,80,'权限模板');if(![...BUILTINS,...c.templates].some(t=>t.id===templateId))throw new SmsError(400,'权限模板不存在');
   c.bindings=c.bindings.filter(v=>v.uid!==target);if(templateId!=='legacy')c.bindings.push({uid:target,templateId});
  }else if(action==='template'){
   const id=b.id?text(b.id,80,'模板 ID'):`custom:${randomUUID()}`;if(BUILTINS.some(t=>t.id===id))throw new SmsError(400,'内置模板不能修改');
   const name=text(b.name,60,'模板名称'),r=object(b.rules);if(!name)throw new SmsError(400,'请填写模板名称');if([...BUILTINS,...c.templates].some(t=>t.id!==id&&t.name===name))throw new SmsError(409,'模板名称已存在');
   if(Object.entries(r).some(([code,scope])=>!CODES.includes(code)||!['all','teaching'].includes(String(scope))||GLOBAL_ONLY.has(code)&&scope!=='all'))throw new SmsError(400,'模板权限或范围无效');
   c.templates=c.templates.filter(t=>t.id!==id);c.templates.push({id,name,rules:r as Template['rules']});
  }else if(action==='grant'){
   const permissions=b.permissions;if(!Array.isArray(permissions)||!permissions.length||permissions.length>CODES.length||new Set(permissions).size!==permissions.length||permissions.some(p=>!CODES.includes(p)))throw new SmsError(400,'请选择有效操作');
   const ids=b.classIds;if(ids!=='all'&&(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length))throw new SmsError(400,'请选择有效班级范围');
   if(ids!=='all'){if(permissions.some(p=>GLOBAL_ONLY.has(p)))throw new SmsError(400,'所选操作只支持全局授权');if(await this.db.collection('domain').countDocuments({_id:{$in:ids}as never})!==ids.length)throw new SmsError(400,'班级不存在');}
   const at=(v:unknown,required:boolean)=>!v&&!required?null:zonedInstant(v);
   const startsAt=b.startsAt?at(b.startsAt,true)!:new Date().toISOString(),expiresAt=at(b.expiresAt,false);if(expiresAt&&(Date.parse(expiresAt)<=Date.now()||expiresAt<=startsAt))throw new SmsError(400,'失效时间须晚于开始时间和当前时间');
   c.grants.push({id:randomUUID(),uid:target,permissions,classIds:ids as Grant['classIds'],startsAt,expiresAt,reason:text(b.reason??'',500,'授权备注'),createdBy:uid,createdAt:new Date().toISOString()});
  }else if(action==='revoke'){
   const g=c.grants.find(g=>g.id===b.id&&g.uid===target);if(!g)throw new SmsError(404,'授权不存在');g.revokedAt=new Date().toISOString();
  }else throw new SmsError(400,'授权操作无效');
  if(c.templates.length>100||c.bindings.length>5000||c.grants.length>5000)throw new SmsError(400,'权限配置数量超过上限');
  // One revision replaces the entire authority document; concurrent admins cannot overwrite one another.
  await this.requireAdmin(uid);try{const result=await this.collection.updateOne({_id:'global',revision:c.revision},{$set:{templates:c.templates,bindings:c.bindings,grants:c.grants},$inc:{revision:1}},{upsert:c.revision===0});if(!result.matchedCount&&!result.upsertedCount)throw new SmsError(409,'权限配置已变化，请刷新');}catch(e){if((e as any).code===11000)throw new SmsError(409,'权限配置已变化，请刷新');throw e;}
  await this.db.collection('sms_audit').insertOne({uid,action:`authorization.${action}`,target:String(target||b.id||'template'),fields:['permissions','scope'],at:new Date(),outcome:'success'});
  return this.manage(uid);
 }
}
