/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { ObjectId } from 'mongodb';
import { Context, ContestModel, UserModel, RecordModel, PERM, PRIV, ForbiddenError } from 'hydrooj';
import { ExamService, EXAM_BRIDGE } from './exams';
import { SmsError } from './types';
import { installCorrectionRecords } from './correction-records';
export function examHost(){return {async contest(actor:number,domain:string,id:string){
 if(!actor||!/^[a-f\d]{24}$/i.test(id))return null;const u=await UserModel.getById(domain,actor);if(!u?.hasPriv(PRIV.PRIV_USER_PROFILE)||!u.hasPerm(PERM.PERM_VIEW_CONTEST))return null;
 let c;try{c=await ContestModel.get(domain,new ObjectId(id));}catch(err){if((err as Error).name==='ContestNotFoundError')return null;throw err;}if(!c||c.domainId!==domain||ContestModel.RULES[c.rule]?.hidden)return null;
 if(c.assign?.length&&c.owner!==actor&&!u.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)){const groups=await UserModel.listGroup(domain,actor);if(!groups.some((g:any)=>c.assign.includes(g.name)))return null;}
 return c;
}};}
export function installExams(ctx:Context,exams:ExamService){
 installCorrectionRecords(ctx,'smsCorrection',async(h,record,id)=>{
  await exams.requireReady();
  await exams.model(h.user._id,h.domain._id,id,'exams.read');
  if(record.uid===h.user._id&&!await exams.correction(h.user._id,h.domain._id,id))return null;
  const claim=await ctx.db.db.collection('offline_judge_contests').findOne({_id:`${h.domain._id}:${id}` as any});
  if(claim&&claim.state!=='complete')return null;
  return exams.native(h.user._id,{domainId:h.domain._id,contestId:id});
 });
 ctx.effect(()=>{const bridge={reviewRequired:true,authorize:(actor:number,domain:string,id?:string)=>exams.canUpload(actor,domain,id),participants:(actor:number,domain:string,id:string,uids:number[])=>exams.participants(actor,domain,id,uids),managed:async(domain:string,id:string)=>!!await exams.exams.findOne({_id:exams.key(domain,id)})};(globalThis as any)[EXAM_BRIDGE]=bridge;return()=>{if((globalThis as any)[EXAM_BRIDGE]===bridge)delete(globalThis as any)[EXAM_BRIDGE];};});
 // Apply the independent module scope to every native contest subpage/API,
 // while retaining all original Hydro checkers and hidden/assign restrictions.
 ctx.on('handler/before',async(h:any)=>{
  const id=String(h.args?.tid??'');if(!/^[a-f\d]{24}$/i.test(id))return;
  const e=await exams.exams.findOne({_id:exams.key(h.domain._id,id)});if(!e)return;
  try{await exams.requireReady();await exams.require(h.user?._id??0,e,'exams.read');await exams.native(h.user?._id??0,e);}catch(err){if(err instanceof SmsError)throw new ForbiddenError();throw err;}
 });
 const changed=async(domain:string,id:string)=>{if(domain&&/^[a-f\d]{24}$/i.test(id))await ctx.db.db.collection('sms_rating_contests').updateOne({_id:`${domain}:${id}` as any},{$inc:{resultVersion:1}});};
 ctx.on('contest/edit',async(c:any)=>{await changed(c.domainId,String(c.docId));});
 ctx.on('record/judge',async(r:any)=>{if(r?.contest)await changed(r.domainId,String(r.contest));});
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
