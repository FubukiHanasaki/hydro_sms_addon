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
 exams: ['模拟赛管理',{read:'查看',create:'关联比赛',update:'修改比赛信息',archive:'归档',submit:'打包提交代码',review:'核验 Rating（限插件管理员）',export:'导出'}],
 reports: ['教务报表',{read:'查看',export:'导出'}],
 accounts: ['账户管理',{read:'查看',create:'创建账号',rename:'修改用户名',password:'重置密码',status:'启停账号',provision:'批量补建账号',export:'导出'}],
 rating: ['Rating 管理',{configure:'比赛设置',import:'导入历史',recalculate:'重新结算'}],
 audit: ['操作记录',{read:'查看',export:'导出'}],
} as const;
export const GLOBAL_ONLY = new Set(['exams.review','classes.create','schedules.batch','students.create','students.import','students.promote',...Object.keys(MODULES.teachers[1]).map(k=>`teachers.${k}`),...Object.keys(MODULES.accounts[1]).map(k=>`accounts.${k}`),...Object.keys(MODULES.rating[1]).map(k=>`rating.${k}`),...Object.keys(MODULES.audit[1]).map(k=>`audit.${k}`)]);
export const CODES = Object.entries(MODULES).flatMap(([m,[,actions]])=>Object.keys(actions).map(a=>`${m}.${a}`));
type Scope = 'all' | 'teaching' | 'member';
interface Template { id:string;name:string;rules:Record<string,Scope>;builtin?:boolean }
interface Binding { uid:number;templateId:string }
interface Grant { id:string;uid:number;permissions:string[];classIds:'all'|string[];startsAt:string;expiresAt:string|null;reason:string;createdBy:number;createdAt:string;revokedAt?:string }
interface Config { _id:string;revision:number;templates:Template[];bindings:Binding[];grants:Grant[] }
const rules=(codes:string[],scope:Scope='all')=>Object.fromEntries(codes.map(c=>[c,scope]));
// Dependencies describe existing workflow requirements, never implied grants.
export const DEPENDENCIES:Record<string,string[]> = {
 'students.create':['students.read','students.bind'],
 'students.import':['students.create','students.write','students.bind','students.read'],
 'students.promote':['students.write','students.read'],
 'classes.archive':['classes.update'],
 'teachers.create':['teachers.read'],'teachers.update':['teachers.read'],
 'schedules.create':['schedules.read'],'schedules.update':['schedules.read'],'schedules.adjust':['schedules.read'],
 'courses.create':['courses.read'],'courses.update':['courses.read'],
 'courses.link':['courses.update','courses.read','schedules.read'],
 'courses.roster':['students.read'],
 'accounts.create':['accounts.read'],'accounts.rename':['accounts.read'],'accounts.password':['accounts.read'],'accounts.status':['accounts.read'],
 'accounts.provision':['students.bind','students.read'],'accounts.export':['accounts.read'],'audit.export':['audit.read'],
};
export function permissionLabel(code:string){const [module,action]=code.split('.');const entry=MODULES[module as keyof typeof MODULES];return entry?`${entry[0]} · ${(entry[1] as Record<string,string>)[action]??action}`:code;}
function dependenciesFor(codes:string[]){const needed=new Set<string>();const include=(code:string)=>{if(needed.has(code))return;needed.add(code);for(const required of DEPENDENCIES[code]??[])include(required);};codes.forEach(include);return [...needed];}
function dependencyState(raw:Record<string,string[]|null>,legacyRead:boolean,admin=false){
 const scopes:Record<string,string[]|null>={},dependencyIssues:{code:string;requires:string;classIds:string[]|null}[]=[];
 const resolve=(code:string):string[]|null=>{
  if(Object.hasOwn(scopes,code))return scopes[code];let ids=raw[code];
  if(!admin)for(const required of DEPENDENCIES[code]??[]){
   const dependency=resolve(required);
   if(code==='courses.roster'&&(dependency===null||dependency.length||legacyRead))continue;
   if(dependency===null)continue;
   const missing=ids===null?null:ids.filter(id=>!dependency.includes(id));
   if(ids===null||missing?.length)dependencyIssues.push({code,requires:required,classIds:missing});
   ids=ids===null?dependency:ids.filter(id=>dependency.includes(id));
  }
  return scopes[code]=GLOBAL_ONLY.has(code)&&ids!==null?[]:ids;
 };
 for(const code of Object.keys(raw))resolve(code);return {raw,scopes,dependencyIssues};
}
export const BUILTINS:Template[] = [
 {id:'legacy',name:'现有身份权限',builtin:true,rules:{}},
 {id:'office',name:'教务',builtin:true,rules:rules(CODES.filter(c=>!c.startsWith('accounts.')&&!c.startsWith('audit.')&&!c.startsWith('rating.')&&c!=='students.promote'&&c!=='exams.review'))},
 {id:'teaching',name:'任课教师',builtin:true,rules:{...rules(['students.read','students.export','classes.members','classes.export','schedules.export','courses.create','courses.update','courses.link','courses.export','reports.read','reports.export','exams.create','exams.update','exams.archive','exams.submit','exams.export'],'teaching'),...rules(['classes.read','schedules.read','courses.read','exams.read'],'member')}},
 {id:'readonly',name:'只读教务',builtin:true,rules:rules(CODES.filter(c=>c.endsWith('.read')||c.endsWith('.export')).filter(c=>!c.startsWith('accounts.')&&!c.startsWith('audit.')))},
 {id:'self',name:'学生本人',builtin:true,rules:rules(['classes.read','schedules.read','courses.read','exams.read'],'member')},
 {id:'none',name:'无业务默认权限',builtin:true,rules:{}},
];
export class AuthorizationService {
 constructor(private db:Db){}
 get collection(){return this.db.collection<Config>('sms_authorization');}
 async config(){return await this.collection.findOne({_id:'global'})??{_id:'global',revision:0,templates:[],bindings:[],grants:[]};}
 async policy():Promise<Policy>{return await this.db.collection<Policy>('sms_policy').findOne({_id:'global'})??{_id:'global',admins:[],grants:[],revision:0};}
 async admin(uid:number){return uid>0&&(await this.policy()).admins.includes(uid);}
 async requireAdmin(uid:number){if(!await this.admin(uid))throw new SmsError(403,'需要插件管理员授权');}
 catalog(){return Object.entries(MODULES).map(([id,[label,actions]])=>({id,label,actions:Object.entries(actions).map(([a,label])=>({code:`${id}.${a}`,label,globalOnly:GLOBAL_ONLY.has(`${id}.${a}`),requires:DEPENDENCIES[`${id}.${a}`]??[]}))}));}
 async departed(uid:number){return !!await this.db.collection('sms_teachers').findOne({hydroUid:uid,'basic.status':'离职'},{projection:{_id:1}});}
 async teaching(uid:number){if(await this.departed(uid))return [];const taught=await this.db.collection('sms_classes').distinct('domainId',{teacherUids:uid});return this.db.collection('domain.user').distinct('domainId',{domainId:{$in:taught},uid,join:true});}
 // A Hydro membership is independent of student/teacher profile binding.
 // Member-scoped rules grant only the ordinary read scope; fullRead and the
 // student/sensitive-data policies remain separate authorization decisions.
 async members(uid:number){
  if(!Number.isSafeInteger(uid)||uid<=0)return [];
  return this.db.collection('domain.user').distinct('domainId',{uid,join:true});
 }
 async scope(uid:number,code:string,config?:Config,knownAdmin?:boolean,knownDeparted?:boolean,at=Date.now()):Promise<string[]|null>{
  if(uid<=0||!CODES.includes(code))return [];
  if(knownAdmin??await this.admin(uid))return null;
  const c=config??await this.config(),binding=c.bindings.find(b=>b.uid===uid),template=[...BUILTINS,...c.templates].find(t=>t.id===(binding?.templateId??'legacy'));
  if(knownDeparted??await this.departed(uid))return ['legacy','self'].includes(template?.id??'')&&['classes.read','schedules.read','courses.read','exams.read'].includes(code)?this.members(uid):[];
  let base=template?.rules[code];
  if(template?.id==='legacy'){
   if(['exams.read','classes.read','schedules.read','courses.read','classes.export','schedules.export','courses.export','reports.export'].includes(code))base='member';
   if(['students.read','classes.members','exams.create','exams.update','exams.archive','exams.submit','exams.export','courses.create','courses.update','courses.link','reports.read'].includes(code))base='teaching';
  }
  if(base==='all')return null;
  const ids=new Set<string>(base==='teaching'?await this.teaching(uid):base==='member'?await this.members(uid):[]),now=at;
  for(const g of c.grants.filter(g=>g.uid===uid&&!g.revokedAt&&Date.parse(g.startsAt)<=now&&(!g.expiresAt||Date.parse(g.expiresAt)>now)&&g.permissions.includes(code))){
   if(g.classIds==='all')return null;for(const id of g.classIds)ids.add(id);
  }
  // Creating a domain includes reading its basic class information, not every
  // class or its roster. Revoking creation authority removes this fallback.
  if(code==='classes.read'&&await this.scope(uid,'classes.create',c,false,false,at)===null){
   for(const domain of await this.db.collection('domain').find({owner:uid},{projection:{_id:1}}).toArray())ids.add(String(domain._id));
  }
  return [...ids];
 }
 async dependencyScopes(uid:number,config?:Config,at=Date.now(),codes=CODES){
  const c=config??await this.config(),admin=await this.admin(uid),departed=await this.departed(uid);
  const raw:Record<string,string[]|null>=Object.fromEntries(await Promise.all(dependenciesFor(codes).map(async code=>[code,await this.scope(uid,code,c,admin,departed,at)])));
  const legacy=await this.policy(),legacyRead=!departed&&legacy.grants.some(g=>g.uid===uid&&g.permissions.includes('students.read')&&(!g.expiresAt||Date.parse(g.expiresAt)>at));
  // Roster lookup still applies studentPolicy, including legacy student grants.
  return dependencyState(raw,legacyRead,admin);
 }
 private async validateGrant(uid:number,c:Config,grant:Grant){
  const codes=grant.permissions.filter(code=>DEPENDENCIES[code]);if(!codes.length)return;
  const needed=dependenciesFor(codes),base=(await this.dependencyScopes(uid,{...c,grants:[]},Date.now(),codes)).raw,policy=await this.policy();
  const start=Math.max(Date.now(),Date.parse(grant.startsAt)),end=grant.expiresAt?Date.parse(grant.expiresAt):Infinity,points=new Set([start]);
  // Evaluate every authority boundary so a longer grant cannot outlive its
  // prerequisite. Base membership scopes are resolved once, not per boundary.
  const relevant=c.grants.filter(g=>g.uid===uid&&!g.revokedAt&&g.permissions.some(code=>needed.includes(code)));
  for(const g of relevant)for(const date of [g.startsAt,g.expiresAt]){const at=date?Date.parse(date):NaN;if(at>start&&at<end)points.add(at);}
  for(const g of policy.grants)if(g.uid===uid&&g.permissions.includes('students.read')&&g.expiresAt){const at=Date.parse(g.expiresAt);if(at>start&&at<end)points.add(at);}
  for(const at of [...points].sort((a,b)=>a-b)){
   const raw=Object.fromEntries(needed.map(code=>{let ids=base[code];for(const g of relevant)if(g.permissions.includes(code)&&Date.parse(g.startsAt)<=at&&(!g.expiresAt||Date.parse(g.expiresAt)>at)){if(g.classIds==='all'){ids=null;break;}if(ids!==null)ids=[...new Set([...ids,...g.classIds])];}return [code,ids];}));
   const state=dependencyState(raw,policy.grants.some(g=>g.uid===uid&&g.permissions.includes('students.read')&&(!g.expiresAt||Date.parse(g.expiresAt)>at)));
   for(const code of codes){const ids=state.scopes[code];if(ids!==null&&(grant.classIds==='all'||!grant.classIds.every(id=>ids.includes(id)))){
    const missing=[...new Set(state.dependencyIssues.filter(i=>dependenciesFor([code]).includes(i.code)).map(i=>permissionLabel(i.requires)))];
    throw new SmsError(400,`${permissionLabel(code)} 缺少前置权限或其范围、有效期不足：${missing.join('、')}。请明确补齐后再授权`);
   }}
  }
 }
 async fullRead(uid:number,id:string){
  if(await this.admin(uid))return true;if(await this.departed(uid))return false;const c=await this.config(),binding=c.bindings.find(b=>b.uid===uid),t=[...BUILTINS,...c.templates].find(t=>t.id===(binding?.templateId??'legacy'));
  if(t?.id==='legacy'&&(await this.teaching(uid)).includes(id))return true;
  for(const code of ['classes.read','courses.read','reports.read','courses.create','courses.update','classes.members']){
   if(t?.rules[code]&&t.rules[code]!=='member'&&await this.can(uid,code,[id]))return true;
   if(c.grants.some(g=>g.uid===uid&&!g.revokedAt&&Date.parse(g.startsAt)<=Date.now()&&(!g.expiresAt||Date.parse(g.expiresAt)>Date.now())&&g.permissions.includes(code)&&(g.classIds==='all'||g.classIds.includes(id)))&&await this.can(uid,code,[id]))return true;
  }return false;
 }
 async can(uid:number,code:string,classIds?:string[]){
  // Most read checks need no dependency expansion or additional database reads.
  let ids=await this.scope(uid,code);if(DEPENDENCIES[code]&&(ids===null||ids.length))ids=(await this.dependencyScopes(uid,undefined,Date.now(),[code])).scopes[code];
  return ids===null||!!(classIds?.length?classIds.every(id=>ids.includes(id)):classIds?false:ids.length);
 }
 async require(uid:number,code:string,classIds:string[]=[]){if(!await this.can(uid,code,classIds)){await this.db.collection('sms_audit').insertOne({uid,action:'authorization.denied',target:code,fields:classIds,at:new Date(),outcome:'denied'});const issues=DEPENDENCIES[code]?(await this.dependencyScopes(uid,undefined,Date.now(),[code])).dependencyIssues:[],missing=[...new Set(issues.map(i=>permissionLabel(i.requires)))];throw new SmsError(403,missing.length?`${permissionLabel(code)} 缺少前置权限或范围不足：${missing.join('、')}`:`没有对应操作权限或超出班级范围：${code}`);}}
 async snapshot(uid:number){const c=await this.config(),admin=await this.admin(uid),departed=await this.departed(uid),{scopes,dependencyIssues}=await this.dependencyScopes(uid,c);return {catalog:this.catalog(),classes:(await this.db.collection('domain').find({},{projection:{_id:1,name:1}}).toArray()).filter(d=>admin||Object.entries(scopes).some(([code,ids])=>!GLOBAL_ONLY.has(code)&&(ids===null||ids.includes(String(d._id))))).map(d=>({id:String(d._id),name:d.name||String(d._id)})),legacyGrants:(await this.policy()).grants.filter(g=>(admin||!departed)&&g.uid===uid&&(!g.expiresAt||Date.parse(g.expiresAt)>Date.now())),templateName:[...BUILTINS,...c.templates].find(t=>t.id===(c.bindings.find(b=>b.uid===uid)?.templateId??'legacy'))?.name,admin,revision:c.revision,templateId:c.bindings.find(b=>b.uid===uid)?.templateId??'legacy',scopes,dependencyIssues,capabilities:Object.fromEntries(Object.entries(scopes).map(([code,ids])=>[code,ids===null||!!ids.length]))};}
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
  if(target&&await this.departed(target)&&(action==='grant'||action==='bind'&&b.templateId!=='none'))throw new SmsError(400,'请先办理教师复职，再重新授权');
  if(action==='bind'){
   const templateId=text(b.templateId,80,'权限模板');if(![...BUILTINS,...c.templates].some(t=>t.id===templateId))throw new SmsError(400,'权限模板不存在');
   c.bindings=c.bindings.filter(v=>v.uid!==target);if(templateId!=='legacy')c.bindings.push({uid:target,templateId});
  }else if(action==='template'){
   const id=b.id?text(b.id,80,'模板 ID'):`custom:${randomUUID()}`;if(BUILTINS.some(t=>t.id===id))throw new SmsError(400,'内置模板不能修改');
   const name=text(b.name,60,'模板名称'),r=object(b.rules);if(!name)throw new SmsError(400,'请填写模板名称');if([...BUILTINS,...c.templates].some(t=>t.id!==id&&t.name===name))throw new SmsError(409,'模板名称已存在');
   if(Object.entries(r).some(([code,scope])=>!CODES.includes(code)||!['all','teaching'].includes(String(scope))||GLOBAL_ONLY.has(code)&&scope!=='all'))throw new SmsError(400,'模板权限或范围无效');
   for(const [code,scope]of Object.entries(r))for(const required of DEPENDENCIES[code]??[])if(!r[required]||code!=='courses.roster'&&scope==='all'&&r[required]!=='all')throw new SmsError(400,`${permissionLabel(code)} 需要 ${permissionLabel(required)}，请在模板中明确设置足够的范围`);
   c.templates=c.templates.filter(t=>t.id!==id);c.templates.push({id,name,rules:r as Template['rules']});
  }else if(action==='grant'){
   const permissions=b.permissions;if(!Array.isArray(permissions)||!permissions.length||permissions.length>CODES.length||new Set(permissions).size!==permissions.length||permissions.some(p=>!CODES.includes(p)))throw new SmsError(400,'请选择有效操作');
   const ids=b.classIds;if(ids!=='all'&&(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length))throw new SmsError(400,'请选择有效班级范围');
   if(ids!=='all'){if(permissions.some(p=>GLOBAL_ONLY.has(p)))throw new SmsError(400,'所选操作只支持全局授权');if(await this.db.collection('domain').countDocuments({_id:{$in:ids}as never})!==ids.length)throw new SmsError(400,'班级不存在');}
   const at=(v:unknown,required:boolean)=>!v&&!required?null:zonedInstant(v);
   const startsAt=b.startsAt?at(b.startsAt,true)!:new Date().toISOString(),expiresAt=at(b.expiresAt,false);if(expiresAt&&(Date.parse(expiresAt)<=Date.now()||expiresAt<=startsAt))throw new SmsError(400,'失效时间须晚于开始时间和当前时间');
   const grant={id:randomUUID(),uid:target,permissions,classIds:ids as Grant['classIds'],startsAt,expiresAt,reason:text(b.reason??'',500,'授权备注'),createdBy:uid,createdAt:new Date().toISOString()};
   c.grants.push(grant);await this.validateGrant(target,c,grant);
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
