/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { StudentService } from './service';
import { RatingService } from './rating';
import { OrganizationService } from './organization';
import { DIFFICULTIES, type Difficulty } from './rating-core';
import { SmsError } from './types';
import { object, text } from './validation';
export const EXAM_BRIDGE = Symbol.for('hydro.sms.exams');
export const OFFLINE_BRIDGE = Symbol.for('hydro.offline-judge');
export interface ExamDoc { _id: string; domainId: string; contestId: string; classIds: string[]; examType: string; scope: string; source: string; remark: string; archived: boolean; version: number; updatedBy: number; updatedAt: Date }
export interface ExamHost { contest(actor: number, domain: string, id: string): Promise<any | null> }
const eligible = ['oi','ioi','strictioi','acm'];
export class ExamService {
 constructor(private db: Db, private students: StudentService, private org: OrganizationService, private rating: RatingService, private host: ExamHost) {}
 get exams(){return this.db.collection<ExamDoc>('sms_exams');}
 get settings(){return this.db.collection('sms_exam_settings');}
 async init(){await this.exams.createIndex({classIds:1,archived:1});await this.db.collection('sms_exam_initializations').createIndex({expiresAt:1},{expireAfterSeconds:0});}
 key(domain: unknown,id: unknown){const d=text(domain,160,'子域 ID'),c=text(id,24,'比赛 ID');if(!d||! /^[a-f\d]{24}$/i.test(c))throw new SmsError(400,'比赛 ID 无效');return `${d}:${c.toLowerCase()}`;}
 async ready(){return !!(await this.settings.findOne({_id:'global' as any}))?.initializedAt;}
 async requireReady(){if(!await this.ready())throw new SmsError(409,'请先由插件管理员完成过往比赛 Rated 初始化');}
 async allowed(actor:number,exam:ExamDoc,code:string){if(['exams.read','exams.export'].includes(code)){const scope=await this.students.authorization.scope(actor,code);return scope===null||exam.classIds.some(id=>scope.includes(id));}return this.students.authorization.can(actor,code,exam.classIds);}
 async require(actor:number,exam:ExamDoc,code:string){if(['exams.read','exams.export'].includes(code)){if(!await this.allowed(actor,exam,code)){await this.students.audit(actor,'authorization.denied',code,exam.classIds);throw new SmsError(403,'没有对应模拟赛的班级访问权限');}return;}await this.students.requireAction(actor,code,exam.classIds);}
 async native(actor:number,exam:Pick<ExamDoc,'domainId'|'contestId'>){const c=await this.host.contest(actor,exam.domainId,exam.contestId);if(!c)throw new SmsError(404,'比赛不存在或无权访问');return c;}
 async model(actor:number,domain:unknown,id:unknown,code='exams.read'){
  const row=await this.exams.findOne({_id:this.key(domain,id)});if(!row)throw new SmsError(404,'模拟赛不存在');await this.require(actor,row,code);await this.native(actor,row);return row;
 }
 async list(actor:number,query:unknown={},all=false){
  const q=object(query),page=this.org.page(q.page),pattern=this.org.pattern(text(q.q??'',80,'关键词')),classId=text(q.classId??'',160,'班级');
  const rated=text(q.rated??'all',16,'Rated 筛选'),settlement=text(q.settlement??'all',16,'结算筛选');
  if(!['all','rated','unrated'].includes(rated)||!['all','pending','settled','unsettled'].includes(settlement))throw new SmsError(400,'比赛筛选无效');
  const date=(value:unknown)=>{const v=text(value??'',10,'日期');if(!v)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw new SmsError(400,'比赛筛选日期无效');return Date.parse(v+'T00:00:00+08:00');};
  const from=date(q.from),to=date(q.to);if(from!==null&&to!==null&&from>to)throw new SmsError(400,'开始日期不能晚于结束日期');
  const scope=await this.students.authorization.scope(actor,'exams.read');
  const ready=await this.ready();const admin=await this.students.authorization.admin(actor);
  if(!ready)return {initialized:false,admin,total:0,page,pageSize:20,exams:[],difficulties:DIFFICULTIES};
  const filter:any={...scope===null?{}:{classIds:{$in:scope}},archived:q.archived==='true'};
  if(classId)filter.$and=[{classIds:classId}];
  const rows=await this.exams.find(filter).sort({updatedAt:-1}).limit(2001).toArray();if(rows.length>2000)throw new SmsError(400,'请先按班级缩小范围');
  const head=await this.rating.head();
  const configs=await this.db.collection('sms_rating_contests').find({_id:{$in:rows.map(r=>r._id)} as any}).toArray();
  const sources=await this.rating.sources.find({generation:head.generation,key:{$in:rows.map(r=>`contest:${r._id}`)}}).toArray();
  const configMap=new Map(configs.map(c=>[String(c._id),c])),sourceMap=new Map(sources.map(s=>[s.key,s]));
  const visible=[];for(const e of rows){
   const state=this.ratingState(configMap.get(e._id),sourceMap.get(`contest:${e._id}`));
   if(rated!=='all'&&(rated==='rated')!==state.rated)continue;
   if(settlement==='pending'&&!state.reviewPending||settlement==='settled'&&(!state.settled||state.reviewPending)||settlement==='unsettled'&&(state.settled||state.reviewPending))continue;
   try{const c=await this.native(actor,e);const at=+new Date(c.beginAt);
    if(from!==null&&at<from||to!==null&&at>=to+86400000)continue;
    if(!pattern||new RegExp(pattern,'i').test(c.title)||new RegExp(pattern,'i').test(e.examType))visible.push({e,c});
   }catch(err){if(!(err instanceof SmsError&&err.status===404))throw err;}
  }
  visible.sort((a,b)=>+new Date(b.c.beginAt)-+new Date(a.c.beginAt));
  return {initialized:true,admin,total:visible.length,page,pageSize:20,exams:await Promise.all((all?visible:visible.slice((page-1)*20,page*20)).map(({e,c})=>this.view(actor,e,c))),difficulties:DIFFICULTIES};
 }
 private ratingState(config:any,published:any){return {rated:config?.enabled??false,settled:!!published,reviewPending:!!config&&(!!config.enabled!==!!published||(!!published&&((published.review?.configVersion??0)!==(config.version??0)||(published.review?.resultVersion??0)!==(config.resultVersion??0))))};}
 async view(actor:number,e:ExamDoc,c:any){
  const config=await this.db.collection('sms_rating_contests').findOne({_id:e._id as any});const head=await this.rating.head();const published=await this.rating.sources.findOne({generation:head.generation,key:`contest:${e._id}`});
  return {...e,title:c.title,rule:c.rule,beginAt:c.beginAt,endAt:c.endAt,durationMinutes:Math.round((+new Date(c.endAt)-+new Date(c.beginAt))/60000),fullScore:(c.pids??[]).reduce((sum:number,pid:number)=>sum+(c.score?.[pid]??100),0),problemCount:c.pids?.length??0,...this.ratingState(config,published),difficulty:config?.difficulty??'CSP-J',reviewedAt:published?.review?.at??null,canEdit:await this.allowed(actor,e,'exams.update'),canArchive:await this.allowed(actor,e,'exams.archive'),canReview:await this.students.authorization.admin(actor),canUpload:!!(globalThis as any)[OFFLINE_BRIDGE]&&+new Date(c.endAt)<=Date.now()&&await this.canUpload(actor,e.domainId,e.contestId),url:`/d/${encodeURIComponent(e.domainId)}/contest/${e.contestId}`,uploadUrl:`/d/${encodeURIComponent(e.domainId)}/contest/${e.contestId}#offline-code`};
 }
 async detail(actor:number,domain:unknown,id:unknown){const e=await this.model(actor,domain,id);return this.view(actor,e,await this.native(actor,e));}
 async candidates(actor:number,domainValue:unknown){
  const domainId=text(domainValue,160,'比赛子域');await this.students.requireAction(actor,'exams.create',[domainId]);
  const docs=await this.db.collection('document').find({domainId,docType:30,rule:{$in:eligible}}).sort({beginAt:-1}).limit(200).toArray();const result=[];
  for(const c of docs)if(await this.host.contest(actor,domainId,String(c.docId)))result.push({id:String(c.docId),title:c.title,rule:c.rule,beginAt:c.beginAt,endAt:c.endAt});return result;
 }
 async save(actor:number,value:unknown){
  await this.requireReady();const b=object(value);this.org.fields(b,['domainId','contestId','classIds','examType','scope','source','remark','difficulty','rated','version','archived']);
  const key=this.key(b.domainId,b.contestId),domainId=key.slice(0,key.lastIndexOf(':')),contestId=key.slice(key.lastIndexOf(':')+1);
  if(!Array.isArray(b.classIds)||!b.classIds.length||b.classIds.length>50||new Set(b.classIds).size!==b.classIds.length||b.classIds.some(x=>typeof x!=='string'||!x||x.length>160))throw new SmsError(400,'请选择有效且不重复的参赛班级');
  if(!Number.isSafeInteger(b.version)||(b.version as number)<0||typeof b.rated!=='boolean'||!DIFFICULTIES.includes(b.difficulty as Difficulty))throw new SmsError(400,'版本或比赛设置无效');
  const old=await this.exams.findOne({_id:key});await this.students.requireAction(actor,old?'exams.update':'exams.create',b.classIds as string[]);if(old)await this.require(actor,old,'exams.update');await this.students.requireAction(actor,'exams.update',b.classIds as string[]);
  for(const id of b.classIds)await this.org.domain(id as string);const c=await this.native(actor,{domainId,contestId});if(!eligible.includes(c.rule))throw new SmsError(400,'此赛制暂不支持模拟赛管理');
  const data={domainId,contestId,classIds:b.classIds as string[],examType:text(b.examType??'模拟赛',80,'比赛类型'),scope:text(b.scope??'',160,'比赛范围'),source:text(b.source??'',300,'来源'),remark:text(b.remark??'',2000,'说明'),archived:old?.archived??false,updatedBy:actor,updatedAt:new Date()};
  return this.org.locked(`exam:${key}`,async()=>{
   const fresh=await this.exams.findOne({_id:key});if((fresh?.version??0)!==b.version)throw new SmsError(409,'模拟赛信息已更新，请刷新');
   await this.students.requireAction(actor,fresh?'exams.update':'exams.create',data.classIds);if(fresh)await this.require(actor,fresh,'exams.update');await this.native(actor,{domainId,contestId});
   await this.students.mutation(actor,'exams.save',key,Object.keys(data),async()=>{await this.exams.updateOne({_id:key},{$set:data,$inc:{version:1}},{upsert:true});});
   await this.rating.configureRequest(actor,domainId,contestId,b.difficulty as Difficulty,b.rated as boolean);
   return this.detail(actor,domainId,contestId);
  });
 }
 async archive(actor:number,domain:unknown,id:unknown,value:unknown){const e=await this.model(actor,domain,id,'exams.archive'),b=object(value);this.org.fields(b,['version','archived']);if(typeof b.archived!=='boolean'||b.version!==e.version)throw new SmsError(409,'资料已变化');await this.students.mutation(actor,'exams.archive',e._id,['archived'],async()=>this.org.locked(`exam:${e._id}`,async()=>{await this.require(actor,e,'exams.archive');await this.native(actor,e);const r=await this.exams.updateOne({_id:e._id,version:e.version},{$set:{archived:b.archived as boolean,updatedBy:actor,updatedAt:new Date()},$inc:{version:1}});if(!r.matchedCount)throw new SmsError(409,'资料已变化');}));return {saved:true};}
 async canUpload(actor:number,domain:string,id?:string):Promise<boolean|null>{
  if(!await this.ready())return id&&await this.exams.findOne({_id:this.key(domain,id)})?false:null;
  const rows=id?await this.exams.find({_id:this.key(domain,id)}).toArray():await this.exams.find({domainId:domain,archived:false}).toArray();if(id&&!rows.length)return null;
  for(const e of rows){if(e.archived||!await this.allowed(actor,e,'exams.read')||!await this.allowed(actor,e,'exams.submit'))continue;const teacher=await this.students.authorization.admin(actor)||e.classIds.every(cid=>cid!=='system');if(!teacher)continue;
   if(!await this.students.authorization.admin(actor)){const taught=await this.students.authorization.teaching(actor);if(!e.classIds.every(cid=>taught.includes(cid)))continue;}
   try{const c=await this.native(actor,e);if(c.rule==='oi')return true;}catch{}
  }return false;
 }
 async participants(actor:number,domain:string,id:string,uids:number[]){const e=await this.exams.findOne({_id:this.key(domain,id)});if(!e)return;if(!await this.canUpload(actor,domain,id))throw new SmsError(403,'没有当前班级代码上传权限');if(e.classIds.includes('system'))return;
  const eligibleIds=await this.db.collection('domain.user').distinct('uid',{domainId:{$in:e.classIds},join:true,uid:{$in:uids}});if(uids.some(uid=>!eligibleIds.includes(uid)))throw new SmsError(403,'代码包包含参赛班级之外的账号');
 }
 async correction(actor:number,domain:string,id:string){const e=await this.exams.findOne({_id:this.key(domain,id)});if(!e||e.archived)return false;if(!await this.allowed(actor,e,'exams.read'))return false;const c=await this.native(actor,e);return eligible.includes(c.rule)&&+new Date(c.endAt)<=Date.now()&&!!await this.db.collection('domain.user').findOne({domainId:{$in:e.classIds},uid:actor,join:true});}
 async export(actor:number,query:unknown){if(!await this.students.authorization.can(actor,'exams.export'))throw new SmsError(403,'没有模拟赛导出权限');const data=await this.list(actor,query,true);const rows=[];for(const e of data.exams)if(await this.allowed(actor,e,'exams.export'))rows.push([e.title,e.domainId,e.contestId,e.examType,e.classIds.join('、'),e.rule,e.beginAt?new Date(e.beginAt).toISOString():'',e.endAt?new Date(e.endAt).toISOString():'',e.durationMinutes,e.fullScore,e.difficulty,e.rated?'Rated':'Unrated',e.settled?'已结算':'未结算',e.scope,e.source,e.remark]);return {name:'模拟赛列表',headers:['比赛','比赛子域','比赛 ID','类型','参赛班级','赛制','开始时间','结束时间','时长（分钟）','满分','难度','Rated','结算','范围','来源','说明'],rows};}
 async initializationPreview(actor:number){
  await this.students.authorization.requireAdmin(actor);if(await this.ready())throw new SmsError(409,'初始化已经完成，请在各比赛中修改 Rated 并核验');
  const docs=await this.db.collection('document').find({docType:30,rule:{$in:eligible},endAt:{$lte:new Date()}}).sort({domainId:1,docId:1}).limit(2001).toArray();if(docs.length>2000)throw new SmsError(400,'过往比赛超过2000场，请先分批整理');
  const allowedDocs=[];for(const c of docs)if(await this.host.contest(actor,c.domainId,String(c.docId)))allowedDocs.push(c);
  const head=await this.rating.head(),sources=await this.rating.allSources(head.generation);const configs=await this.db.collection('sms_rating_contests').find({}).toArray();
  const rows=allowedDocs.map(c=>{const key=`${c.domainId}:${c.docId}`,config=configs.find(v=>String(v._id)===key),published=sources.find(s=>s.key===`contest:${key}`);return {key,domainId:c.domainId,contestId:String(c.docId),title:c.title,rule:c.rule,beginAt:c.beginAt,endAt:c.endAt,difficulty:config?.difficulty??'CSP-J',configVersion:config?.version??0,previousRated:!!config?.enabled||!!c.rated,published:!!published};});
  const id=randomUUID();await this.db.collection('sms_exam_initializations').insertOne({_id:id as any,actor,revision:head.revision,rows,state:'preview',expiresAt:new Date(Date.now()+1800000)});return {id,revision:head.revision,rows,importCheckpoints:sources.filter(s=>s.kind==='import').length};
 }
 async initializationConfirm(actor:number,value:unknown){
  await this.students.authorization.requireAdmin(actor);const b=object(value);this.org.fields(b,['id','ratedKeys','acknowledgeRatingChanges']);if(!Array.isArray(b.ratedKeys)||b.ratedKeys.some(k=>typeof k!=='string')||new Set(b.ratedKeys).size!==b.ratedKeys.length||b.acknowledgeRatingChanges!==true)throw new SmsError(400,'请确认 Rated 选择及历史 Rating 变更影响');
  const ratedKeys=b.ratedKeys as string[];
  return this.org.locked('__sms_exam_setup__',async()=>{
  const p=await this.db.collection('sms_exam_initializations').findOne({_id:text(b.id,40,'预览ID') as any,actor,state:'preview',expiresAt:{$gt:new Date()}});if(!p||await this.ready())throw new SmsError(409,'初始化预览已失效');
  const rows=p.rows as any[];if(ratedKeys.some(k=>!rows.some(r=>r.key===k)))throw new SmsError(400,'包含预览之外的比赛');const selected=new Set(ratedKeys),keys=new Set(rows.map(r=>`contest:${r.key}`));
  const result=await this.rating.mutate(actor,'exams.initialize',async old=>{
   await this.students.authorization.requireAdmin(actor);if(await this.ready())throw new SmsError(409,'初始化已完成');
   for(const r of rows){await this.native(actor,{domainId:r.domainId,contestId:r.contestId});const c=await this.db.collection('document').findOne({docType:30,domainId:r.domainId,docId:new ObjectId(r.contestId)});const cfg=await this.db.collection('sms_rating_contests').findOne({_id:r.key as any});if(!c||c.rule!==r.rule||c.title!==r.title||+new Date(c.beginAt)!==+new Date(r.beginAt)||(cfg?.version??0)!==r.configVersion||!eligible.includes(c.rule)||+new Date(c.endAt)!==+new Date(r.endAt))throw new SmsError(409,'过往比赛已变化，请重新预览');}
   for(const r of rows){await this.exams.updateOne({_id:r.key},{$setOnInsert:{domainId:r.domainId,contestId:r.contestId,classIds:[r.domainId],examType:'模拟赛',scope:'',source:'',remark:'',archived:false,version:1,updatedBy:actor,updatedAt:new Date()}},{upsert:true});await this.db.collection('sms_rating_contests').updateOne({_id:r.key as any},{$set:{domainId:r.domainId,contestId:r.contestId,difficulty:r.difficulty,enabled:selected.has(r.key),updatedBy:actor,updatedAt:new Date()},$inc:{version:1}},{upsert:true});}
   return old.filter(s=>s.kind==='import'||!keys.has(s.key)||selected.has(s.key.slice(8)));
  },p.revision);
  await this.settings.updateOne({_id:'global' as any},{$set:{initializedAt:new Date(),initializedBy:actor,ratedCount:selected.size}},{upsert:true});await this.db.collection('sms_exam_initializations').updateOne({_id:p._id},{$set:{state:'complete'}});await this.students.audit(actor,'exams.initialize','global',['rated:'+selected.size,'total:'+rows.length]);return {...result,initialized:true,rated:selected.size,total:rows.length};
  });
 }
}
