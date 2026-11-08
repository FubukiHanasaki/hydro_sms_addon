/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { captureNative, resultFingerprint } from './exam-native';
import { ObjectId } from 'mongodb';
import { Context, ContestModel, UserModel, RecordModel, PERM, PRIV, ForbiddenError, ValidationError } from 'hydrooj';
import { ExamService, EXAM_BRIDGE } from './exams';
import { SmsError } from './types';
import { text } from './validation';
import { installCorrectionRecords } from './correction-records';
export function examHost(){return {async contest(actor:number,domain:string,id:string,manager=false){
 if(!actor||!/^[a-f\d]{24}$/i.test(id))return null;const u=await UserModel.getById(domain,actor);if(!u?.hasPriv(PRIV.PRIV_USER_PROFILE)||!u.hasPerm(PERM.PERM_VIEW_CONTEST))return null;
 let c;try{c=await ContestModel.get(domain,new ObjectId(id));}catch(err){if((err as Error).name==='ContestNotFoundError')return null;throw err;}if(!c||c.domainId!==domain||ContestModel.RULES[c.rule]?.hidden)return null;
 if(!manager&&c.assign?.length&&c.owner!==actor&&!u.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)){const groups=await UserModel.listGroup(domain,actor);if(!groups.some((g:any)=>c.assign.includes(g.name)))return null;}
 return c;
}};}
export function installExams(ctx:Context,exams:ExamService){
 // Guard native routes before their own prepare methods, including contests
 // not linked to SMS yet. Native ownership or broad domain roles never bypass
 // independent module scopes. Permission adaptation is request-local only.
 const scopeNative=async(h:any,action?:'create'|'update')=>{
  const actor=h.user?._id??0,domain=h.domain._id;
  // Hydro merges body/query into args before routing. Bind both the operation
  // and its native permission lookup to the actual domain/contest in the URL.
  h.args.domainId=domain;if(h.context.params?.tid)h.args.tid=h.context.params.tid;
  const raw=String(h.args?.tid??''),id=/^[a-f\d]{24}$/i.test(raw)?raw:undefined;
  if(id){const c=await ContestModel.get(domain,new ObjectId(id));if(c&&ContestModel.RULES[c.rule]?.hidden)return;}
  try{if(action)await exams.requireNative(actor,domain,id,`exams.${action}`);}catch(err){if(err instanceof SmsError)throw new ForbiddenError();throw err;}
  const canCreate=await exams.nativeAllowed(actor,domain,undefined,'exams.create');
  const canEdit=id?await exams.nativeAllowed(actor,domain,id,'exams.update'):false;
  // Use the current session ceiling, not a scope retained in Hydro's user cache.
  const base=await UserModel.getById(domain,actor);if(!base)throw new ForbiddenError();let sessionScope:bigint;
  try{sessionScope=BigInt(h.session?.scope??base.scope);}catch{throw new ForbiddenError();}
  const inScope=(p:bigint)=>(sessionScope&p)===p;
  if(action&&!(action==='create'?inScope(PERM.PERM_CREATE_CONTEST):inScope(PERM.PERM_EDIT_CONTEST)||inScope(PERM.PERM_EDIT_CONTEST_SELF)))throw new ForbiddenError();
  const user=Object.create(base),mapped=new Map([[PERM.PERM_CREATE_CONTEST,canCreate],[PERM.PERM_EDIT_CONTEST,canEdit],[PERM.PERM_EDIT_CONTEST_SELF,canEdit],[PERM.PERM_VIEW_HIDDEN_CONTEST,base.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)||canEdit&&(inScope(PERM.PERM_EDIT_CONTEST)||inScope(PERM.PERM_EDIT_CONTEST_SELF))]]);
  user.hasPerm=(...perms:bigint[])=>perms.some(p=>inScope(p)&&(mapped.has(p)?mapped.get(p):base.hasPerm(p)));
  user.own=(doc:any,arg:any=false)=>doc?.docType===30&&doc.domainId===domain?canEdit&&(inScope(PERM.PERM_EDIT_CONTEST)||inScope(PERM.PERM_EDIT_CONTEST_SELF))&&base.own(doc,arg):base.own(doc,arg);
  h.user=user;
 };
 ctx.on('handler/before-prepare/ContestEdit',async(h:any)=>{await scopeNative(h,h.context.params?.tid||h.args?.tid?'update':'create');});
 for(const name of ['ContestManagement','ContestUser','ContestClarification','ContestBalloon','ContestCode'])ctx.on(`handler/before-prepare/${name}`,async(h:any)=>{await scopeNative(h,'update');});
 for(const name of ['ContestList','ContestDetail','ContestProblemList','ContestScoreboard','ContestFileDownload'])ctx.on(`handler/before-prepare/${name}`,async(h:any)=>{
  await scopeNative(h); // File downloads retain Hydro's participant/time checks.
 });
 // Homework handlers share the contest collection and do not themselves
 // verify the document rule. Never let an OI contest be mutated through those
 // alternate forms; genuine homework retains its original authorization.
 for(const name of ['HomeworkEdit','HomeworkFiles'])ctx.on(`handler/before-prepare/${name}`,async(h:any)=>{
  const id=String(h.args?.tid??'');if(!/^[a-f\d]{24}$/i.test(id))return;
  const c=await ContestModel.get(h.domain._id,new ObjectId(id));
  if(c&&!ContestModel.RULES[c.rule]?.hidden)throw new ForbiddenError();
 });
 const correctionRecord=async(actor:number,domain:string,id:string,owner:number)=>{
  try {
  await exams.requireReady();
  await exams.model(actor,domain,id,'exams.read');
  if(owner===actor&&!await exams.correction(actor,domain,id))return null;
  const claim=await ctx.db.db.collection('offline_judge_contests').findOne({_id:`${domain}:${id}` as any});
  if(claim&&claim.state!=='complete')return null;
  return exams.native(actor,{domainId:domain,contestId:id});
  } catch(error) { if(error instanceof SmsError)throw new ForbiddenError();throw error; }
 };
 installCorrectionRecords(ctx,'smsCorrection',(h,record,id)=>correctionRecord(h.user._id,h.domain._id,id,record.uid));
 ctx.effect(()=>{const bridge={reviewRequired:true,correctionRecord,authorize:(actor:number,domain:string,id?:string)=>exams.canUpload(actor,domain,id),participants:(actor:number,domain:string,id:string,uids:number[])=>exams.participants(actor,domain,id,uids),managed:async(domain:string,id:string)=>!!await exams.exams.findOne({_id:exams.key(domain,id)})};(globalThis as any)[EXAM_BRIDGE]=bridge;return()=>{if((globalThis as any)[EXAM_BRIDGE]===bridge)delete(globalThis as any)[EXAM_BRIDGE];};});
 // Apply the independent module scope to every native contest subpage/API,
 // while retaining all original Hydro checkers and hidden/assign restrictions.
 ctx.on('handler/before',async(h:any)=>{
  const id=String(h.args?.tid??'');if(!/^[a-f\d]{24}$/i.test(id))return;
  const e=await exams.exams.findOne({_id:exams.key(h.domain._id,id)});if(!e)return;
  try{await exams.requireReady();await exams.require(h.user?._id??0,e,'exams.read');await exams.native(h.user?._id??0,e);}catch(err){if(err instanceof SmsError)throw new ForbiddenError();throw err;}
 });
 const changed=async(domain:string,id:string)=>{if(domain&&/^[a-f\d]{24}$/i.test(id))await ctx.db.db.collection('sms_rating_contests').updateOne({_id:`${domain}:${id}` as any},{$inc:{resultVersion:1}});};
 ctx.on('contest/edit',async(c:any)=>{
  const prior=await ctx.db.db.collection('sms_exam_native').findOne({_id:`${c.domainId}:${c.docId}` as any});
  if(prior&&resultFingerprint(prior.config)!==resultFingerprint(c))await changed(c.domainId,String(c.docId));
  await captureNative(ctx.db.db,c);
 });
 ctx.on('record/judge',async(r:any)=>{if(r?.contest)await changed(r.domainId,String(r.contest));});
 // Keep Hydro's complete editor, validators, permission checks and scheduling
 // side effects. SMS fields share the same submit, scoped checks and version lock.
 ctx.on('handler/before/ContestEdit',async(h:any)=>{
  const id=String(h.args?.tid??'');
  if(h.context.method!=='POST')return;
  const existing=id?await exams.exams.findOne({_id:exams.key(h.domain._id,id)}):null;
  const b=h.context.request.body??{};
  if(typeof b.operation!=='string')throw new ValidationError('操作格式无效');
  if(id&&b.operation==='delete'&&await exams.deletionProtected(h.domain._id,id))throw new ValidationError('已纳入模拟赛管理的比赛不能直接删除，请在模拟赛管理中归档');
  if(id&&!existing&&!Object.hasOwn(b,'smsVersion'))return;
  if(existing)try{await exams.require(h.user._id,existing,'exams.update');}catch(err){if(err instanceof SmsError)throw new ForbiddenError();throw err;}
  if(b.operation!=='update')return;
  const original=h.postUpdate.bind(h);
  h.postUpdate=async(...args:any[])=>{
   try {
    if(id&&!Object.hasOwn(b,'smsVersion'))throw new SmsError(409,'请刷新比赛编辑页后重试');
    if(!id){
     await exams.requireReady();await exams.requireNative(h.user._id,h.domain._id,undefined,'exams.create');await exams.requireNative(h.user._id,h.domain._id,undefined,'exams.update');
     // Validate every SMS field before Hydro creates its document.
     const editor=await exams.editor(h.user._id,h.domain._id);
     if(b.smsVersion!==undefined&&(!Number.isSafeInteger(Number(b.smsVersion))||Number(b.smsVersion)<0))throw new SmsError(409,'请刷新比赛创建页后重试');
     text(b.smsExamType??'模拟赛',80,'比赛类型');text(b.smsRemark??'',2000,'说明');
     if(!editor.difficulties.includes(b.smsDifficulty??'CSP-J'))throw new SmsError(400,'模拟赛设置无效');
    }
    const payload={domainId:h.domain._id,contestId:id,version:id?Number(b.smsVersion??0):0,
     classIds:existing?.classIds??[h.domain._id],
     examType:b.smsExamType??'模拟赛',scope:existing?.scope??'',source:existing?.source??'',remark:b.smsRemark??'',
     difficulty:b.smsDifficulty??'CSP-J',rated:!!(b.rated&&!['false','off','no','0'].includes(b.rated))};
    if(!['oi','ioi','strictioi','acm'].includes(b.rule))throw new SmsError(400,'模拟赛暂不支持此赛制');
    if(id)await exams.save(h.user._id,payload,()=>original(...args));
    else {await original(...args);const created=String(h.response.body?.tid??'');if(!/^[a-f\d]{24}$/i.test(created))throw new SmsError(409,'比赛创建结果异常');await exams.save(h.user._id,{...payload,contestId:created});}
   }catch(err){if(err instanceof SmsError){if(err.status===403)throw new ForbiddenError();throw new ValidationError(err.message);}throw err;}
  };
 });
 ctx.on('handler/after/ContestEdit',async(h:any)=>{
  if(h.context.method!=='GET'||h.response.template!=='contest_edit.html'||h.tdoc&&!['oi','ioi','strictioi','acm'].includes(h.tdoc.rule))return;
  try {h.response.body.smsEditor=await exams.editor(h.user._id,h.domain._id,h.tdoc?String(h.tdoc.docId):undefined);}
  catch(err){if(err instanceof SmsError&&[403,409].includes(err.status))return;throw err;}
  h.response.addHeader('Cache-Control','private, no-store');
  h.response.template='sms_contest_edit.html';
 });
 ctx.on('handler/after/ContestDetail',async(h:any)=>{
  const id=String(h.tdoc?.docId??'');if(!/^[a-f\d]{24}$/i.test(id))return;const e=await exams.exams.findOne({_id:exams.key(h.domain._id,id)});if(!e)return;
  h.response.addHeader('Cache-Control','private, no-store');
  h.response.body.smsExam=await exams.detail(h.user._id,h.domain._id,id);h.response.body.smsExamsApi=h.url('sms_api_exams');
  if(h.response.template==='contest_detail.html')h.response.template='sms_contest_detail.html';
  else if(h.response.template==='offline_contest_detail.html'&&h.response.body.offlineBaseTemplate==='contest_detail.html')h.response.body.offlineBaseTemplate='sms_contest_detail.html';
 });
 ctx.on('handler/before-prepare/ProblemSubmit',async(h:any)=>{
  const id=String(h.args?.tid??'');if(!/^[a-f\d]{24}$/i.test(id))return;const e=await exams.exams.findOne({_id:exams.key(h.domain._id,id)});if(!e)return;
  const c=await exams.native(h.user?._id??0,e);if(+new Date(c.endAt)>Date.now())return;
  const original=h.post.bind(h);h.smsExamCorrection=true;h.args.domainId=h.domain._id;h.args.pid=h.context.params.pid;
  const valid=async()=>{
   if(!h.user?._id||!await exams.correction(h.user._id,h.domain._id,id))throw new ForbiddenError();
   const claim=await ctx.db.db.collection('offline_judge_contests').findOne({_id:`${h.domain._id}:${id}` as any});if(claim&&claim.state!=='complete')throw new ForbiddenError();
   if(!['oi','ioi','strictioi','acm'].includes(h.tdoc?.rule)||h.tdoc.domainId!==h.domain._id||+new Date(h.tdoc.endAt)>Date.now())throw new ForbiddenError();
   const config=h.pdoc?.config;if(!config||typeof config==='string'||!['default',undefined].includes(config.type)||config.langs&&!config.langs.length)throw new ForbiddenError();
  };
  h.prepare=async()=>{await valid();};
  h.post=async(args:any)=>{
   await valid();if(h.context.get('origin')!==`${h.context.request.protocol}://${h.context.request.host}`)throw new ForbiddenError();
   const tid=args.tid;delete args.tid;
   try{await original(args);const rid=h.response.body?.rid;if(rid&&ObjectId.isValid(String(rid)))await RecordModel.coll.updateOne({_id:new ObjectId(String(rid)),domainId:h.domain._id,uid:h.user._id,contest:{$exists:false}},{$set:{smsCorrection:{contestId:id,at:new Date()}}});}
   finally{args.tid=tid;}
  };
 });
 ctx.on('handler/after/ProblemSubmit',async(h:any)=>{if(h.smsExamCorrection&&h.response.template==='problem_submit.html')h.response.template='sms_problem_correction.html';});
}
