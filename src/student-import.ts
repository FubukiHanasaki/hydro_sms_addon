/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { AccountGateway, usernameBase } from './accounts';
import { AccountManagement } from './account-management';
import { StudentService } from './service';
import { Student, SmsError, BASIC_FIELDS } from './types';
import { object, text, validateBasic, validateSensitive, validDate } from './validation';
import { studentLock, requireNoStudentBatch } from './student-lock';
import { IMPORT_FIELDS, parseStudentFile } from './student-import-file';
type ImportKind='create'|'bind'|'duplicate'|'suspect'|'error';
interface ImportItem { row:number;basic:Student['basic'];provided:string[];kind:ImportKind;reason:string;selected:boolean;username?:string;hydroUid?:number;targetId?:string;targetVersion?:number;matches:{id:string;name:string;grade:string;school:string}[];done?:boolean;error?:string;studentId?:string; accountCreated?:boolean; }
interface ImportJob { _id:string;actor:number;lastActor?:number;filename:string;createdAt:Date;expiresAt?:Date;startedAt?:Date;completedAt?:Date;status:'preview'|'running'|'completed';snapshot:string;items:ImportItem[] }
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const keyFor=(id:string,row:number)=>hash(['student-import',id,row]).slice(0,32);
export class StudentImportService {
  constructor(private db:Db,private students:StudentService,private accounts:AccountManagement,private provisioner:AccountGateway){}
  get jobs(){return this.db.collection<ImportJob>('sms_student_imports');}
  async importPermission(actor:number){for(const code of ['students.import','students.create','students.write','students.bind','students.read'])await this.students.requireAction(actor,code);return this.students.policy();}
 async init(){await this.jobs.createIndex({createdAt:-1});await this.jobs.createIndex({expiresAt:1},{expireAfterSeconds:0});}
  async parse(actor:number,value:unknown){await this.importPermission(actor);return parseStudentFile(value);}
  async snapshot(){const s=await this.students.students.find({},{projection:{basic:1,hydroUid:1,version:1}}).sort({_id:1}).toArray();return {rows:s,digest:hash(s.map(s=>[s._id,s.basic,s.hydroUid??null,s.version]))};}
  view(j:ImportJob,detail=false){return {id:j._id,actor:j.actor,lastActor:j.lastActor,filename:j.filename,status:j.status,createdAt:j.createdAt,startedAt:j.startedAt,completedAt:j.completedAt,total:j.items.length,selected:j.items.filter(i=>i.selected).length,done:j.items.filter(i=>i.done).length,counts:Object.fromEntries(['create','bind','duplicate','suspect','error'].map(k=>[k,j.items.filter(i=>i.kind===k).length])),...(detail?{items:j.items}:{})};}
  async history(actor:number){await this.importPermission(actor);return (await this.jobs.find({status:{$ne:'preview'}}).sort({createdAt:-1}).limit(100).toArray()).map(j=>this.view(j));}
  async detail(actor:number,id:string){await this.importPermission(actor);const j=await this.jobs.findOne({_id:id});if(!j)throw new SmsError(404,'导入批次不存在');if(j.status==='preview'&&j.actor!==actor)throw new SmsError(403,'预览不属于当前管理员');return this.view(j,true);}
  async preview(actor:number,value:unknown){
    const policy=await this.importPermission(actor),b=object(value);this.students.checkFields(b,['filename','headers','rows','mapping','allowNewRows','skipRows']);
    const filename=text(b.filename,160,'文件名');if(!Array.isArray(b.headers)||!b.headers.length||b.headers.length>50||b.headers.some(h=>typeof h!=='string'||h.length>100))throw new SmsError(400,'表头无效');
    const headers=b.headers as string[],mapping=object(b.mapping);if(Object.keys(mapping).some(k=>!Object.hasOwn(IMPORT_FIELDS,k))||Object.values(mapping).some(n=>!Number.isInteger(n)||(n as number)<0||(n as number)>=headers.length)||new Set(Object.values(mapping)).size!==Object.values(mapping).length||mapping.name===undefined)throw new SmsError(400,'请将姓名及其他字段分别对应到有效列');
    if(!Array.isArray(b.rows)||!b.rows.length||b.rows.length>1000)throw new SmsError(400,'每次导入 1–1000 行');
    const numbers=new Set<number>();const source=b.rows.map(v=>{const r=object(v);if(!Number.isSafeInteger(r.row)||(r.row as number)<2||(r.row as number)>1001||numbers.has(r.row as number)||!Array.isArray(r.values)||r.values.length>headers.length||r.values.some(v=>typeof v!=='string'||v.length>1000)||!Array.isArray(r.errors)||r.errors.length>50||r.errors.some(v=>typeof v!=='string'||v.length>200))throw new SmsError(400,'资料行格式无效');numbers.add(r.row as number);return {row:r.row as number,values:r.values as string[],errors:r.errors as string[]};});
    const decisions=(value:unknown)=>{if(value===undefined)return new Set<number>();if(!Array.isArray(value)||value.length>1000||value.some(n=>!numbers.has(n)))throw new SmsError(400,'行选择无效');return new Set<number>(value);};
    const allow=decisions(b.allowNewRows),skip=decisions(b.skipRows);
    return studentLock(this.db,async()=>{
      await requireNoStudentBatch(this.db);const {rows,digest}=await this.snapshot();const users=await this.accounts.users.find({},{projection:{uname:1,unameLower:1,priv:1}}).toArray();const reserved=new Set(users.map(u=>(u.unameLower||u.uname.toLowerCase()))),seen=new Map<string,number>(),seenUids=new Map<number,number>(),seenTargets=new Map<string,number>();const items:ImportItem[]=[];
      for(const row of source){
        let basic:Student['basic']={name:'',gender:'',grade:'',school:'',status:'在校',enrollmentDate:'',currentStage:''};
        const i:ImportItem={row:row.row,basic,provided:Object.keys(mapping).filter(k=>k!=='hydroUid'),kind:'create',reason:'新增学生并创建账号',selected:true,matches:[]};
        try{
          if(row.errors.length)throw new SmsError(400,row.errors.join('；'));
          const input:Record<string,string>={status:'在校'};for(const field of BASIC_FIELDS)if(mapping[field]!==undefined)input[field]=(row.values[mapping[field] as number]||'').normalize('NFKC').trim();
          if(!input.status)input.status='在校';if(input.enrollmentDate){const m=/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(input.enrollmentDate);if(m)input.enrollmentDate=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;validDate(input.enrollmentDate,'入学日期');}
          i.basic={...basic,...input} as Student['basic'];basic=validateBasic(input);i.basic=basic;
          const raw=mapping.hydroUid===undefined?'':(row.values[mapping.hydroUid as number]||'').trim();if(raw){if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new SmsError(400,'Hydro UID 必须为正整数');i.hydroUid=Number(raw);const user=users.find(u=>u._id===i.hydroUid);if(!user)throw new SmsError(400,'Hydro UID 不存在');if(this.accounts.protected(user,policy.admins))throw new SmsError(400,'不能通过导入绑定受保护账号');i.username=user.uname;}
          i.accountCreated=!i.hydroUid;if(i.hydroUid)i.reason='新建档案并绑定指定账号';
          const signature=hash([i.provided.map(f=>[f,basic[f as keyof typeof basic]]),i.hydroUid??null]);
          if(seen.has(signature)){i.kind='duplicate';i.reason=`与文件第 ${seen.get(signature)} 行重复`;i.selected=false;}
          else if(i.hydroUid&&seenUids.has(i.hydroUid)){i.kind='duplicate';i.reason=`Hydro UID 与文件第 ${seenUids.get(i.hydroUid)} 行重复`;i.selected=false;}
          else{
            seen.set(signature,row.row);if(i.hydroUid)seenUids.set(i.hydroUid,row.row);
            const bound=i.hydroUid?rows.find(s=>s.hydroUid===i.hydroUid):undefined;
            const sameName=rows.filter(s=>s.basic.name.normalize('NFKC').trim()===basic.name);
            i.matches=sameName.map(s=>({id:s._id,name:s.basic.name,grade:s.basic.grade,school:s.basic.school}));
            const exact=sameName.filter(s=>i.provided.every(f=>!basic[f as keyof typeof basic]||s.basic[f as keyof typeof basic]===basic[f as keyof typeof basic]));
            if(bound){i.kind='duplicate';i.reason=bound.basic.name===basic.name?'该 UID 已绑定学生档案':'该 UID 已绑定其他学生，不能重复绑定';i.selected=false;}
            else if(exact.length===1&&(!i.hydroUid||!exact[0].hydroUid)){
              const s=exact[0];i.targetId=s._id;i.targetVersion=s.version;
              if(s.hydroUid){i.kind='duplicate';i.reason='已有相同学生档案和绑定账号';i.selected=false;}
              else{i.kind='bind';i.reason=i.hydroUid?'为已有未绑定档案绑定指定账号':'为已有未绑定档案创建并绑定账号';}
            }else if(sameName.length){i.kind='suspect';i.reason='同名档案资料不同或匹配不唯一，请核对';i.selected=allow.has(row.row);}
            if(i.targetId){if(seenTargets.has(i.targetId)){i.kind='duplicate';i.reason=`与文件第 ${seenTargets.get(i.targetId)} 行匹配同一档案`;i.selected=false;}else seenTargets.set(i.targetId,row.row);}
            const prior=items.find(p=>p.basic.name===basic.name&&p.kind!=='error'&&p.kind!=='duplicate');
            if(prior&&i.kind!=='duplicate'){i.kind='suspect';i.reason=`与文件第 ${prior.row} 行同名，请核对`;i.selected=allow.has(row.row);}
          }
          if(skip.has(row.row))i.selected=false;
          if(i.selected&&!i.hydroUid){const base=usernameBase(basic.name);let name=base,n=0;while(reserved.has(name)&&n<10000)name=`${base}${++n}`;if(reserved.has(name))throw new SmsError(400,'同名账号过多');reserved.add(name);i.username=name;}
        }catch(e){i.kind='error';i.reason=(e as Error).message;i.selected=false;}
        items.push(i);
      }
      const j:ImportJob={_id:randomUUID(),actor,filename,createdAt:new Date(),expiresAt:new Date(Date.now()+15*60000),status:'preview',snapshot:digest,items};await this.jobs.insertOne(j);return this.view(j,true);
    });
  }
  async execute(actor:number,id:string){
    await this.importPermission(actor);return studentLock(this.db,async verify=>{
      let j=await this.jobs.findOne({_id:id});if(!j||(j.status==='preview'&&j.actor!==actor))throw new SmsError(403,'批次不存在或预览不属于当前管理员');if(j.status==='completed')return this.detail(actor,id);
      if(j.status==='preview'){
        await requireNoStudentBatch(this.db);if(Date.now()<j.createdAt.getTime()||Date.now()-j.createdAt.getTime()>15*60000)throw new SmsError(409,'预览已过期，请重新预览');
        if(!j.items.some(i=>i.selected))throw new SmsError(400,'没有选择可导入的记录');if((await this.snapshot()).digest!==j.snapshot)throw new SmsError(409,'学生档案已变化，请重新预览');
        const policy=await this.importPermission(actor);
        for(const i of j.items.filter(i=>i.selected)){if(i.hydroUid){const u=await this.accounts.users.findOne({_id:i.hydroUid});if(!u||u.uname!==i.username||this.accounts.protected(u,policy.admins))throw new SmsError(409,'待绑定账号已变化，请重新预览');}else if(await this.accounts.users.findOne({unameLower:i.username}))throw new SmsError(409,'用户名已被占用，请重新预览');}
        await this.students.audit(actor,'students.import.start',id,['basic','hydroUid']);await this.jobs.updateOne({_id:id,status:'preview'},{$set:{status:'running',startedAt:new Date(),lastActor:actor},$unset:{expiresAt:''}});j=(await this.jobs.findOne({_id:id}))!;
      }
      for(let n=0;n<j.items.length;n++){
        const i=j.items[n];if(!i.selected||i.done)continue;await verify();await this.importPermission(actor);
        try{
          const key=keyFor(id,i.row),studentId=i.targetId||`import_${key}`;
          const current=await this.students.students.findOne({_id:studentId});
          if(i.targetId&&(!current||current.version!==i.targetVersion&&!((current as Student&{importBatch?:string}).importBatch===id)))throw new SmsError(409,'已有档案已变化');
          let uid=i.hydroUid,username=i.username;
          if(!uid){const account=await this.provisioner.provision(i.basic.name,key,i.username);uid=account.uid;username=account.username;}
          else{const policy=await this.importPermission(actor),user=await this.accounts.users.findOne({_id:uid});if(!user||this.accounts.protected(user,policy.admins)||user.uname!==username)throw new SmsError(409,'待绑定账号已变化');}
          const owner=await this.students.students.findOne({hydroUid:uid});if(owner&&owner._id!==studentId)throw new SmsError(409,'账号已绑定其他学生');
          if(i.targetId){
            if(current?.hydroUid&&current.hydroUid!==uid)throw new SmsError(409,'已有档案已绑定其他账号');
            if(!current?.hydroUid){const r=await this.students.students.updateOne({_id:studentId,version:i.targetVersion,hydroUid:{$in:[null as never]}},{$set:{hydroUid:uid,importBatch:id,updatedAt:new Date(),updatedBy:actor},$inc:{version:1}});if(!r.matchedCount)throw new SmsError(409,'账号已准备，绑定未完成');}
          }else if(!current){const now=new Date();await this.students.students.insertOne({_id:studentId,basic:i.basic,sensitive:validateSensitive({}),internalNote:'',hydroUid:uid,version:1,createdAt:now,updatedAt:now,createdBy:actor,updatedBy:actor,importBatch:id}as Student);}
          else if(current.hydroUid!==uid||(current as Student&{importBatch?:string}).importBatch!==id)throw new SmsError(409,'目标档案存在冲突');
          await this.jobs.updateOne({_id:id},{$set:{[`items.${n}.done`]:true,[`items.${n}.error`]:'',[`items.${n}.hydroUid`]:uid,[`items.${n}.username`]:username,[`items.${n}.studentId`]:studentId}});
        }catch(e){await this.jobs.updateOne({_id:id},{$set:{[`items.${n}.error`]:(e as Error).message}});break;}
      }
      const latest=(await this.jobs.findOne({_id:id}))!;if(latest.items.every(i=>!i.selected||i.done)){await this.jobs.updateOne({_id:id},{$set:{status:'completed',completedAt:new Date(),lastActor:actor}});await this.students.audit(actor,'students.import.complete',id,['basic','hydroUid']);}
      return this.detail(actor,id);
    });
  }
}
