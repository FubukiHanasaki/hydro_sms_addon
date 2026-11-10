/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { Context, PERM, UserModel, ForbiddenError, ValidationError } from 'hydrooj';
import { StudentService } from './service';
import { SmsError } from './types';
import { ObjectId } from 'mongodb';

// A second, independent permission boundary. Original Hydro checks (including
// source visibility, data access, reference restrictions and session scope) stay.
export function installProblemPermissions(ctx:Context,students:StudentService){
 const create=PERM.PERM_CREATE_PROBLEM,edit=PERM.PERM_EDIT_PROBLEM|PERM.PERM_EDIT_PROBLEM_SELF|PERM.PERM_REJUDGE_PROBLEM|PERM.PERM_REJUDGE;
 const bind=(h:any)=>{h.args.domainId=h.domain._id;if(h.context.params?.pid!==undefined)h.args.pid=h.context.params.pid;if(h.context.params?.rid!==undefined)h.args.rid=h.context.params.rid;};
 const operation=(h:any)=>{const b=h.context.request.body??{};if(b.operation!==undefined&&typeof b.operation!=='string')throw new ValidationError('操作格式无效');h.args.operation=b.operation;return b.operation??'';};
 const requireAction=async(h:any,code:string,domain=h.domain._id)=>{
  try{await students.requireAction(h.user?._id??0,code,[domain]);}catch(e){if(e instanceof SmsError)throw new ForbiddenError();throw e;}
  let scope:bigint;try{scope=BigInt(h.session?.scope??h.user.scope);}catch{throw new ForbiddenError();}
  const mask=code==='problems.create'?create:edit;
  if(code==='problems.create'?(scope&mask)!==mask:!(scope&mask))throw new ForbiddenError();
 };
 const narrowUser=async(h:any,beforeChecker=false)=>{
  if(!h.user||!h.domain?._id)return;
  const actor=h.user._id??0,domain=h.domain._id;
  const fresh=await UserModel.getById(domain,actor);if(!fresh)throw new ForbiddenError();
  // Hydro's cached user can retain another request's scope. Use its raw domain
  // permissions and this session's ceiling on a private, request-local object.
  const base=beforeChecker?await fresh.private():h.user,nativePerm=BigInt(fresh.perm);
  const [canCreate,canEdit]=await Promise.all([students.authorization.can(actor,'problems.create',[domain]),students.authorization.can(actor,'problems.update',[domain])]);
  let sessionScope:bigint;try{sessionScope=BigInt(h.session?.scope??base.scope);}catch{sessionScope=0n;}
  const denied=(canCreate?0n:create)|(canEdit?0n:edit),user=Object.create(base);
  user.perm=nativePerm;user.scope=sessionScope;
  user.hasPerm=(...perms:bigint[])=>perms.some(p=>!(p&denied)&&(sessionScope&p)===p&&(beforeChecker||(p&(create|edit))!==0n?(nativePerm&p)===p:base.hasPerm(p)));
  user.own=(doc:any,arg:any=false)=>typeof arg==='bigint'&&(arg&(create|edit))?user.hasPerm(arg)&&(doc?.owner===actor||doc?.maintainer?.includes(actor)):base.own(doc,arg);
  h.user=user;
 };
 // Native route checkers run before before-prepare. Normalize the actual
 // source domain before those checkers, including requests with body aliases.
 ctx.on('handler/create/http',async(h:any)=>{
  const path=h.context.path??h.context.request.path??'';
  if(/\/(?:d\/[^/]+\/)?(?:p(?:\/|$)|problem(?:\/|$)|record(?:\/|$))/.test(path)){
   bind(h);await narrowUser(h,true);
  }
 });
 // Reapply after contest-specific adapters, retaining their non-problem rules.
 ctx.on('handler/before-prepare',async(h:any)=>{
  await narrowUser(h);
  const path=h.context.path??h.context.request.path??'';
  // Import routes can be supplied by another addon (e.g. the FPS importer).
  if(/\/(?:d\/[^/]+\/)?problem\/(?:create|import(?:\/[^/]*)?)\/?$/.test(path)){
   bind(h);await requireAction(h,'problems.create');
  }
 });
 for(const name of ['ProblemCreate','ProblemImportHydro','FpsProblemImport'])ctx.on(`handler/before-prepare/${name}`,async(h:any)=>{bind(h);await requireAction(h,'problems.create');});
 for(const name of ['ProblemEdit','ProblemConfig'])ctx.on(`handler/before-prepare/${name}`,async(h:any)=>{bind(h);await requireAction(h,'problems.update');});
 ctx.on('handler/before-prepare/ProblemMain',async(h:any)=>{
  bind(h);if(h.context.method!=='POST')return;const op=operation(h);
  if(op==='copy'){
   const target=h.args.target;if(typeof target!=='string')throw new ValidationError('目标子域无效');
   const domains=ctx.db.db.collection('domain');
   const d=await domains.findOne({_id:target as any},{projection:{_id:1}})??await domains.findOne({lower:target.toLowerCase()},{projection:{_id:1}});
   if(!d)throw new ForbiddenError();h.args.target=String(d._id);await requireAction(h,'problems.create',String(d._id));
   // Some Hydro versions project out hidden/owner before filtering copied
   // sources. Validate visibility from complete permission fields first.
   const raw=h.args.pids,ids=(Array.isArray(raw)?raw:typeof raw==='string'?raw.split(','):[]).map(Number);
   if(!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw new ValidationError('题目列表无效');
   const unique=[...new Set(ids)],sources=await ctx.db.db.collection('document').find({domainId:h.domain._id,docType:10,docId:{$in:unique}},{projection:{docId:1,owner:1,maintainer:1,hidden:1}}).toArray();
   if(sources.length!==unique.length||!h.user.hasPerm(PERM.PERM_VIEW_PROBLEM)||sources.some(p=>p.hidden&&!h.user.own(p)&&!h.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)))throw new ForbiddenError();
   h.args.pids=ids;
  }else if(['delete','hide','unhide'].includes(op))await requireAction(h,'problems.update');
 });
 ctx.on('handler/before-prepare/ProblemDetail',async(h:any)=>{bind(h);if(h.context.method==='POST'&&['delete','rejudge'].includes(operation(h)))await requireAction(h,'problems.update');});
 ctx.on('handler/before-prepare/ProblemFiles',async(h:any)=>{bind(h);if(h.context.method==='POST'&&operation(h)!=='get_links')await requireAction(h,'problems.update');});
 ctx.on('handler/before-prepare/RecordDetail',async(h:any)=>{bind(h);if(h.context.method==='POST'){
  operation(h);await requireAction(h,'problems.update');
  const rid=String(h.context.params?.rid??'');if(!/^[a-f\d]{24}$/i.test(rid))return;
  const record=await ctx.db.db.collection('record').findOne({_id:new ObjectId(rid),domainId:h.domain._id},{projection:{contest:1}});
  if(record?.contest){
   const exam=await ctx.db.db.collection('sms_exams').findOne({_id:`${h.domain._id}:${record.contest}` as any},{projection:{classIds:1}});
   try{await students.requireAction(h.user._id,'exams.update',exam?.classIds??[h.domain._id]);}catch(e){if(e instanceof SmsError)throw new ForbiddenError();throw e;}
  }
 }});
 // Whole-problem rejudging also changes official records. It must not become
 // a shortcut around a shared contest's all-class management boundary.
 ctx.on('handler/before-operation/ProblemDetail',async(h:any)=>{
  if(h.context.request.body?.operation!=='rejudge'||!h.pdoc)return;
  const contests=await ctx.db.db.collection('record').distinct('contest',{domainId:h.domain._id,pid:h.pdoc.docId,contest:{$type:'objectId'}});
  for(const contest of contests){const id=String(contest);if(id.startsWith('0'.repeat(23)))continue;
   const exam=await ctx.db.db.collection('sms_exams').findOne({_id:`${h.domain._id}:${id}` as any},{projection:{classIds:1}});
   try{await students.requireAction(h.user._id,'exams.update',exam?.classIds??[h.domain._id]);}catch(e){if(e instanceof SmsError)throw new ForbiddenError();throw e;}
  }
 });
 // Original file-fragment responses unconditionally declare can_edit:true.
 ctx.on('handler/after/ProblemFiles',async(h:any)=>{
  if(!Array.isArray(h.response.pjax))return;
  const allowed=await students.authorization.can(h.user?._id??0,'problems.update',[h.domain._id])&&(h.user.hasPerm(PERM.PERM_EDIT_PROBLEM)||h.user.own(h.pdoc,PERM.PERM_EDIT_PROBLEM_SELF));
  for(const fragment of h.response.pjax)if(Array.isArray(fragment)&&fragment[1])fragment[1].can_edit=!!fragment[1].can_edit&&allowed;
 });
 ctx.on('handler/after/ProblemDetail',async(h:any)=>{
  if(h.response.template!=='problem_detail.html')return;
  const scope=BigInt(h.session?.scope??h.user.scope??0);
  h.response.body.smsProblemCanCopy=(scope&create)===create&&await students.authorization.can(h.user?._id??0,'problems.create');
  h.response.addHeader('Cache-Control','private, no-store');h.response.template='sms_problem_detail.html';
 });
}
