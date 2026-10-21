/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { StudentService } from './service';
import { AccountManagement } from './account-management';
import { usernameBase, type AccountGateway } from './accounts';
import { SmsError, type Student } from './types';
import { object } from './validation';
import { studentLock, requireNoStudentBatch } from './student-lock';
const GRADES = ['一年级','二年级','三年级','四年级','五年级','六年级','七年级','八年级','九年级','高一','高二','高三','已毕业'];
type Kind = 'promotion' | 'provision' | 'password';
interface Item { id: string; name: string; uid?: number; username?: string; version: number; grade?: string; status?: string; revision?: number; afterGrade?: string; afterStatus?: string; expectedRevision?: number; done?: boolean; undone?: boolean; error?: string }
interface Job { _id: string; actor: number; kind: Kind; status: 'preview'|'running'|'completed'|'undoing'|'undone'; createdAt: Date; sequence?: number; expiresAt?: Date; lastActor?: number; startedAt?: Date; completedAt?: Date; undoneAt?: Date; undoneBy?: number; items: Item[]; skipped: { id: string; name: string; reason: string }[]; snapshot: string; warning: string; generation: string; }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class BulkService {
  constructor(private db: Db, private students: StudentService, private accounts: AccountManagement, private provisioner: AccountGateway) {}
  get jobs() { return this.db.collection<Job>('sms_bulk_jobs'); }
  async permission(actor:number,kind:Kind){const codes=kind==='promotion'?['students.promote','students.write','students.read']:kind==='provision'?['accounts.provision','students.bind','students.read']:['accounts.password','accounts.read'];for(const code of codes)await this.students.requireAction(actor,code);return this.students.policy();}
  async init() { await this.jobs.createIndex({ createdAt: -1 }); await this.jobs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); }
  async rows() { return this.students.students.find({}, { projection: { 'basic.name': 1, 'basic.grade': 1, 'basic.status': 1, hydroUid: 1, version: 1, gradeRevision: 1, gradeBatch: 1 } }).sort({_id:1}).toArray(); }
  digest(rows: Student[]) { return hash(rows.map(s => [s._id,s.basic.name,s.basic.grade,s.basic.status,s.hydroUid??null,s.version,s.gradeRevision??0])); }
  async generation() { return hash(await this.jobs.find({kind:'promotion', status:{$ne:'preview'}}, {projection:{status:1,undoneAt:1}}).sort({_id:1}).toArray()); }
  summary(j: Job, canUndo = false) { return { id:j._id,kind:j.kind,status:j.status,actor:j.actor,lastActor:j.lastActor,createdAt:j.createdAt,startedAt:j.startedAt,completedAt:j.completedAt,undoneAt:j.undoneAt,warning:j.warning,total:j.items.length,done:j.items.filter(i=>i.done).length,undone:j.items.filter(i=>i.undone).length,skipped:j.skipped.length,canUndo }; }
  async history(actor: number) { const kinds:Kind[]=[];for(const kind of ['promotion','provision','password'] as Kind[])try{await this.permission(actor,kind);kinds.push(kind);}catch{}if(!kinds.length)throw new SmsError(403,'没有批量操作记录权限'); const latest=await this.jobs.find({kind:'promotion',status:'completed'}).sort({sequence:-1}).limit(1).next(); return (await this.jobs.find({status:{$ne:'preview'},kind:{$in:kinds}}).sort({createdAt:-1}).limit(100).toArray()).map(j=>this.summary(j,j._id===latest?._id)); }
  async detail(actor: number, id: string) { if(!(await this.students.me(actor)).admin&&!(await Promise.all(['students.promote','accounts.provision','accounts.password'].map(code=>this.students.authorization.can(actor,code,[])))).some(Boolean))throw new SmsError(403,'没有批量操作权限');const j=await this.jobs.findOne({_id:id});if(j)await this.permission(actor,j.kind);if(!j)throw new SmsError(404,'批次不存在');if(j.status==='preview'&&j.actor!==actor)throw new SmsError(403,'预览不属于当前管理员');return {...this.summary(j),items:j.items,skippedItems:j.skipped}; }
  async preview(actor: number, value: unknown) {
    const b=object(value);this.students.checkFields(b,['kind','resumeIds','uids']);
    const kind=String(b.kind) as Kind;if(!['promotion','provision','password'].includes(kind))throw new SmsError(400,'批量操作无效');await this.permission(actor,kind);
    return studentLock(this.db, async()=>{
      await requireNoStudentBatch(this.db);const rows=await this.rows();let items:Item[]=[],skipped:Job['skipped']=[];let warning='';
      if(kind==='promotion'){
        const resume=b.resumeIds??[];if(!Array.isArray(resume)||resume.some(v=>typeof v!=='string')||new Set(resume).size!==resume.length)throw new SmsError(400,'复学名单无效');
        if(resume.some(id=>!rows.some(s=>s._id===id&&s.basic.status==='休学'&&GRADES.includes(s.basic.grade)&&s.basic.grade!=='已毕业')))throw new SmsError(400,'复学名单已变化，请重新预览');
        for(const s of rows){const index=GRADES.indexOf(s.basic.grade);const reason=s.basic.grade==='已毕业'?'已毕业':index<0?'年级为空或无法识别':s.basic.status==='离校'?'已离校':s.basic.status==='休学'&&!resume.includes(s._id)?'继续休学':!['在校','休学'].includes(s.basic.status)?'学生状态无法识别':'';
          if(reason){skipped.push({id:s._id,name:s.basic.name,reason});continue;}
          items.push({id:s._id,name:s.basic.name,version:s.version,grade:s.basic.grade,status:s.basic.status,revision:s.gradeRevision??0,expectedRevision:(s.gradeRevision??0)+1,afterGrade:GRADES[index+1],afterStatus:s.basic.status==='休学'?'在校':s.basic.status});}
        const last=await this.jobs.find({kind,status:{$ne:'preview'}}).sort({sequence:-1}).limit(1).next();if(last?.startedAt&&Date.now()-last.startedAt.getTime()<300*86400000)warning=Date.now()<last.startedAt.getTime()?'服务器时间早于上次升年级时间，请核对后确认':'距上次升年级不足 300 天，请确认是否再次执行';
      }else if(kind==='provision'){
        const reserved=new Set((await this.db.collection('user').find({},{projection:{unameLower:1}}).toArray()).map(u=>String(u.unameLower).toLowerCase()));
        for(const s of rows){if(s.hydroUid)continue;if(s.basic.status!=='在校'){skipped.push({id:s._id,name:s.basic.name,reason:'仅为在校学生补建账号'});continue;}
          try{const base=usernameBase(s.basic.name);let username=base,n=0;while(reserved.has(username)&&n<10000)username=`${base}${++n}`;if(reserved.has(username))throw Error();reserved.add(username);items.push({id:s._id,name:s.basic.name,version:s.version,username});}catch{skipped.push({id:s._id,name:s.basic.name,reason:'姓名无法生成可用用户名'});}}
      }else{
        if(!Array.isArray(b.uids)||!b.uids.length||b.uids.length>200||b.uids.some(n=>!Number.isSafeInteger(n)||n<=0)||new Set(b.uids).size!==b.uids.length)throw new SmsError(400,'请选择 1–200 个不同账号');
        const policy=await this.students.policy();
        for(const uid of b.uids as number[]){const u=await this.accounts.users.findOne({_id:uid});if(!u)throw new SmsError(400,`UID ${uid} 不存在`);if(this.accounts.protected(u,policy.admins))throw new SmsError(403,`UID ${uid} 为受保护账号`);const state=await this.accounts.states.findOne({_id:uid});if(state?.pendingOperation)throw new SmsError(409,'所选账号存在未完成的批量重置');items.push({id:String(uid),uid,username:u.uname,name:rows.find(s=>s.hydroUid===uid)?.basic.name||'',version:state?.version??0});}
      }
      if(items.length>2000)throw new SmsError(400,'单批最多 2000 名学生，请先缩小待处理范围');
      const j:Job={_id:randomUUID(),actor,kind,status:'preview',createdAt:new Date(),expiresAt:new Date(Date.now()+15*60000),items,skipped,snapshot:this.digest(rows),warning,generation:await this.generation()};await this.jobs.insertOne(j);
      return {...this.summary(j),items,skippedItems:skipped,suspended:kind==='promotion'?rows.filter(s=>s.basic.status==='休学'&&GRADES.includes(s.basic.grade)&&s.basic.grade!=='已毕业').map(s=>({id:s._id,name:s.basic.name,grade:s.basic.grade})):[]};
    });
  }
  async execute(actor: number,id: string,value:unknown){
    const b=object(value);this.students.checkFields(b,['confirmWarning','password']);
    return studentLock(this.db,async verify=>{
      let j=await this.jobs.findOne({_id:id});if(j)await this.permission(actor,j.kind);if(!j||(j.status==='preview'&&j.actor!==actor))throw new SmsError(403,'批次不存在或预览不属于当前管理员');
      if(j.status==='completed'||j.status==='undone')return this.detail(actor,id);
      if(j.status==='undoing')throw new SmsError(409,'该批次正在撤销');
      const password=j.kind==='password'?this.accounts.password(b.password):undefined;
      if(j.status==='preview'){
        await requireNoStudentBatch(this.db);if(Date.now()<j.createdAt.getTime()||Date.now()-j.createdAt.getTime()>15*60000)throw new SmsError(409,'预览已过期，请重新预览');
        if(!j.items.length)throw new SmsError(400,'没有可处理的记录');if(j.warning&&b.confirmWarning!==true)throw new SmsError(400,'请勾选短期重复升年级确认');
        if(j.kind!=='password'&&(j.snapshot!==this.digest(await this.rows())||j.generation!==await this.generation()))throw new SmsError(409,'学生资料或操作记录已变化，请重新预览');
        if(j.kind==='provision'){if(j.items.some(i=>!i.username||i.username.length<6))throw new SmsError(409,'预览用户名不满足 Hydro 登录要求，请重新预览');for(const i of j.items)if(await this.accounts.users.findOne({unameLower:i.username}))throw new SmsError(409,'预览中的用户名已被占用，请重新预览');}
        if(j.kind==='password'){const policy=await this.students.policy();for(const i of j.items){const u=await this.accounts.users.findOne({_id:i.uid});const state=await this.accounts.states.findOne({_id:i.uid});if(!u||u.uname!==i.username||this.accounts.protected(u,policy.admins)||(state?.version??0)!==i.version||state?.pendingOperation)throw new SmsError(409,'账号已变化，请重新预览');}}
        const counter=await this.db.collection<{_id:string;sequence:number}>('sms_bulk_state').findOneAndUpdate({_id:'global'},{$inc:{sequence:1}},{upsert:true,returnDocument:'after'});
        await this.students.audit(actor,`bulk.${j.kind}.start`,id,[j.kind]);await this.jobs.updateOne({_id:id,status:'preview'},{$set:{status:'running',sequence:counter!.sequence,startedAt:new Date(),lastActor:actor},$unset:{expiresAt:''}});j=(await this.jobs.findOne({_id:id}))!;
      }
      await this.jobs.updateOne({_id:id},{$set:{lastActor:actor}});
      for(let n=0;n<j.items.length;n++){
        const i=j.items[n];if(i.done)continue;await verify();await this.permission(actor,j.kind);
        try{
          if(j.kind==='promotion'){
            const s=await this.students.students.findOne({_id:i.id});if(!s)throw new SmsError(409,'学生档案不存在');
            if(s.gradeBatch===id&&(s.basic.grade!==i.afterGrade||s.basic.status!==i.afterStatus||(s.gradeRevision??0)!==i.expectedRevision))throw new SmsError(409,'已处理的学生资料存在冲突');
            if(s.gradeBatch!==id){if(s.version!==i.version||s.basic.grade!==i.grade||s.basic.status!==i.status)throw new SmsError(409,'学生资料已变化');const r=await this.students.students.updateOne({_id:i.id,version:i.version},{$set:{'basic.grade':i.afterGrade!,'basic.status':i.afterStatus!,gradeBatch:id,updatedAt:new Date(),updatedBy:actor},$inc:{version:1,gradeRevision:1}});if(!r.matchedCount)throw new SmsError(409,'学生资料已变化');}
          }else if(j.kind==='provision'){
            const key=hash(['bulk',id,i.id]).slice(0,32);const s=await this.students.students.findOne({_id:i.id});if(!s)throw new SmsError(409,'学生档案不存在');
            // Recover an account committed by Hydro before the binding write.
            const existing=await this.db.collection<{_id:number;uname:string}>('user').findOne({mailLower:`sms-${key}@accounts.invalid`});
            if(s.hydroUid&&s.hydroUid!==existing?._id)throw new SmsError(409,'学生已绑定其他账号');
            if(!s.hydroUid&&s.version!==i.version)throw new SmsError(409,'学生资料已变化');
            const created=existing?{uid:existing._id as number,username:String(existing.uname)}:await this.provisioner.provision(i.name,key,i.username);
            if(!s.hydroUid){const r=await this.students.students.updateOne({_id:i.id,version:i.version,hydroUid:{$in:[null as never]}},{$set:{hydroUid:created.uid,updatedAt:new Date(),updatedBy:actor},$inc:{version:1}});if(!r.matchedCount)throw new SmsError(409,'账号已创建，绑定未完成，请继续本批次');}
            i.uid=created.uid;i.username=created.username;
          }else await this.accounts.update(actor,i.uid,{action:'password',password,version:i.version},`${id}:${i.uid}`);
          await this.jobs.updateOne({_id:id},{$set:{[`items.${n}.done`]:true,[`items.${n}.error`]:'',...(i.uid?{[`items.${n}.uid`]:i.uid}:{}),...(i.username?{[`items.${n}.username`]:i.username}:{})}});
        }catch(e){await this.jobs.updateOne({_id:id},{$set:{[`items.${n}.error`]:(e as Error).message}});if(j.kind!=='password')break;}
      }
      const result=(await this.jobs.findOne({_id:id}))!;if(result.items.every(i=>i.done)){await this.jobs.updateOne({_id:id,status:'running'},{$set:{status:'completed',completedAt:new Date()}});await this.students.audit(actor,`bulk.${j.kind}.complete`,id,[j.kind]);}
      return this.detail(actor,id);
    });
  }
  async undo(actor:number,id:string){
    await this.permission(actor,'promotion');return studentLock(this.db,async verify=>{
      let j=await this.jobs.findOne({_id:id,kind:'promotion'});if(!j)throw new SmsError(404,'升年级批次不存在');if(j.status==='undone')return this.detail(actor,id);
      if(!['completed','undoing'].includes(j.status))throw new SmsError(409,'只能撤销已完成的升年级');
      if(j.status==='completed'){
        await requireNoStudentBatch(this.db);const latest=await this.jobs.find({kind:'promotion',status:'completed'}).sort({sequence:-1}).limit(1).next();if(latest?._id!==id)throw new SmsError(409,'请先撤销最新的升年级批次');
        for(const i of j.items){const s=await this.students.students.findOne({_id:i.id});if(!s||(s.gradeRevision??0)!==i.expectedRevision||s.basic.grade!==i.afterGrade||s.basic.status!==i.afterStatus)throw new SmsError(409,`${i.name} 的年级或状态已修改，未执行撤销`);}
        await this.students.audit(actor,'bulk.promotion.undo.start',id,['grade','status']);await this.jobs.updateOne({_id:id},{$set:{status:'undoing',undoneBy:actor}});j=(await this.jobs.findOne({_id:id}))!;
      }
      for(let n=0;n<j.items.length;n++){
        const i=j.items[n];if(i.undone)continue;await verify();await this.permission(actor,j.kind);const s=await this.students.students.findOne({_id:i.id});if(!s)throw new SmsError(409,'档案不存在，撤销未完成');
        if(s.gradeBatch!==`undo:${id}`){if((s.gradeRevision??0)!==i.expectedRevision||s.basic.grade!==i.afterGrade||s.basic.status!==i.afterStatus)throw new SmsError(409,`${i.name} 已变化，撤销未完成`);const r=await this.students.students.updateOne({_id:i.id,gradeRevision:i.expectedRevision},{$set:{'basic.grade':i.grade!,'basic.status':i.status!,gradeBatch:`undo:${id}`,updatedAt:new Date(),updatedBy:actor},$inc:{version:1,gradeRevision:1}});if(!r.matchedCount)throw new SmsError(409,'撤销存在冲突');}
        // Maintain a reverse-order undo chain, without forgiving manual edits.
        await this.jobs.updateMany({kind:'promotion',status:'completed',sequence:{$lt:j.sequence!}},{$set:{'items.$[item].expectedRevision':i.expectedRevision!+1}},{arrayFilters:[{'item.id':i.id,'item.expectedRevision':i.revision,'item.afterGrade':i.grade,'item.afterStatus':i.status}]});
        await this.jobs.updateOne({_id:id},{$set:{[`items.${n}.undone`]:true}});
      }
      await this.jobs.updateOne({_id:id},{$set:{status:'undone',undoneAt:new Date(),undoneBy:actor}});await this.students.audit(actor,'bulk.promotion.undo.complete',id,['grade','status']);return this.detail(actor,id);
    });
  }
}
