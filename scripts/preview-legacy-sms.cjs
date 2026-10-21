#!/usr/bin/env node
// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
// Read-only preview. This command has no apply/import mode and never writes to MongoDB.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {MongoClient}=require('mongodb');
const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--source','--target-config','--out','--python'].includes(key)||!process.argv[i+1])throw Error('Usage: node scripts/preview-legacy-sms.cjs --source BACKUP.db --target-config CONFIG.json --out NEW_DIRECTORY [--python python3]');options[key.slice(2)]=process.argv[i+1];}
const digest=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const norm=x=>String(x??'').normalize('NFKC').trim().toLowerCase();
const text=x=>String(x??'').normalize('NFKC').trim();
function instant(value){const raw=text(value);const clock=/[T ](\d\d):(\d\d)(?::(\d\d))?/.exec(raw);if(clock&&(+clock[1]>23||+clock[2]>59||+(clock[3]||0)>59))throw Error('记录时间无效');if(!/^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)?)?$/.test(raw))throw Error('记录时间格式无效');const dateOnly=raw.length===10;const local=(dateOnly?raw+'T00:00:00':raw.replace(' ','T'));const iso=local+(/[Zz]$|[+-]\d\d:\d\d$/.test(local)?'':'+08:00');const at=new Date(iso);if(!Number.isFinite(at.getTime())||at>new Date())throw Error('记录时间无效或在未来');if(new Date(raw.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==raw.slice(0,10))throw Error('日期无效');return {recordedAt:at.toISOString(),dateOnly,sourceTime:raw};}
function basic(s){const result={name:text(s.name),gender:text(s.gender),grade:text(s.grade),school:text(s.school),status:text(s.status)||'在校',enrollmentDate:text(s.enrollment_date),currentStage:text(s.current_stage)},issues=[];
 if(!result.name||result.name.length>80)issues.push('姓名为空或过长');if(!['','未填写','男','女'].includes(result.gender))issues.push('性别无效');if(!['在校','休学','离校'].includes(result.status))issues.push('学生状态无效');
 if(result.enrollmentDate){const m=/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(result.enrollmentDate);if(m)result.enrollmentDate=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;if(!/^\d{4}-\d\d-\d\d$/.test(result.enrollmentDate)||!Number.isFinite(Date.parse(result.enrollmentDate))||new Date(result.enrollmentDate).toISOString().slice(0,10)!==result.enrollmentDate)issues.push('入学日期无效');}
 for(const[k,v]of Object.entries(result)){if(k!=='name'&&v.length>160)issues.push(k+'过长');if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))issues.push(k+'含无效控制字符');}return{basic:result,issues};}
async function main(){
 for(const key of ['source','target-config','out'])if(!options[key])throw Error('Missing --'+key);
 const source=path.resolve(options.source),out=path.resolve(options.out);if(fs.existsSync(out))throw Error('Output directory already exists; use a new path.');
 const sourceHash=digest(fs.readFileSync(source));const raw=JSON.parse(cp.execFileSync(options.python||'python3',[path.join(__dirname,'read-legacy-sms.py'),source],{encoding:'utf8',maxBuffer:128*1024*1024}));if(digest(fs.readFileSync(source))!==sourceHash)throw Error('SQLite backup changed during preview.');
 const cfg=JSON.parse(fs.readFileSync(options['target-config'],'utf8'));const client=new MongoClient(cfg.uri||cfg.url,{serverSelectionTimeoutMS:10000});let target;
 try{await client.connect();const db=client.db(cfg.name||undefined);
  const users=await db.collection('user').find({_id:{$gt:0}},{projection:{_id:1,uname:1,realName:1,displayName:1,studentId:1,school:1,priv:1}}).sort({_id:1}).toArray();
  const students=await db.collection('sms_students').find({},{projection:{basic:1,hydroUid:1,version:1}}).sort({_id:1}).toArray();
  const policy=await db.collection('sms_policy').findOne({_id:'global'},{projection:{admins:1}});const privileges=await db.collection('system').findOne({_id:'default.priv'});if(!Number.isSafeInteger(privileges?.value))throw Error('Cannot determine Hydro default account privileges');
  const head=await db.collection('sms_rating_head').findOne({_id:'global'});const existingSources=head?await db.collection('sms_rating_sources').find({generation:head.generation},{projection:{uid:1,at:1,rating:1,key:1,kind:1}}).sort({_id:1}).toArray():[];
  target={database:db.databaseName,users,students,admins:policy?.admins||[],defaultPrivileges:privileges.value,head,existingSources};
 }finally{await client.close();}
 const snapshot=digest(target),byUid=new Map(target.users.map(u=>[u._id,u]));
 const accountMap=new Map(),historyMap=new Map(),names=new Map(),studentIds=new Set(raw.students.map(s=>s.id));if(raw.history.some(h=>!studentIds.has(h.student_id)))throw Error('Rating 历史含孤立学生 ID，需先人工处理');
 for(const a of raw.accounts){if(!accountMap.has(a.student_id))accountMap.set(a.student_id,[]);accountMap.get(a.student_id).push(a.username);}
 for(const h of raw.history){if(!historyMap.has(h.student_id))historyMap.set(h.student_id,[]);historyMap.get(h.student_id).push(h);}
 for(const s of raw.students){const n=norm(s.name);names.set(n,(names.get(n)||0)+1);}
 const rows=raw.students.map(s=>{const normalized=basic(s),oldAccounts=accountMap.get(s.id)||[],candidates=[];
  for(const u of target.users){const evidence=[];if(oldAccounts.some(a=>norm(a)===norm(u.uname)))evidence.push('旧 SMS 用户名 = Hydro 用户名');if(norm(s.name)&&norm(s.name)===norm(u.uname))evidence.push('学生姓名 = Hydro 用户名');if(norm(s.name)&&[u.realName,u.displayName].some(v=>norm(v)&&norm(v)===norm(s.name)))evidence.push('学生姓名 = Hydro 实名');if(norm(s.student_no)&&[u.studentId,u.uname].some(v=>norm(v)&&norm(v)===norm(s.student_no)))evidence.push('旧学号 = Hydro 标识');if(!evidence.length)continue;
   const existing=target.students.find(p=>p.hydroUid===u._id),protectedAccount=!Number.isSafeInteger(u.priv)||u._id<=1||target.admins.includes(u._id)||!!(u.priv&~target.defaultPrivileges),warnings=[];
   if(protectedAccount)warnings.push('受保护账号，现有导入接口禁止绑定');if(existing)warnings.push('Hydro UID 已绑定插件档案，禁止覆盖');if(u.realName&&norm(u.realName)!==norm(s.name))warnings.push('Hydro 实名与旧姓名不一致');
   candidates.push({uid:u._id,username:u.uname,realName:/^\+?\d[\d ()-]{7,}$/.test(text(u.realName||u.displayName))||/@/.test(text(u.realName||u.displayName))?'（实名字段疑似联系方式，已隐藏）':u.realName||u.displayName||'',school:u.school||'',evidence,blocked:protectedAccount||!!existing,warnings});
  }
  const history=[],ratingIssues=[];const times=new Map();let duplicateRecords=0;
  for(const h of historyMap.get(s.id)||[]){try{if(typeof h.rating_after!=='number'||!Number.isFinite(h.rating_after)||h.rating_after<0||h.rating_after>100000)throw Error('Rating 分数无效');const time=instant(h.exam_date),rating=Number(h.rating_after.toFixed(2)),prior=times.get(time.recordedAt);if(prior){if(prior.rating!==rating)ratingIssues.push({reason:'同一时间存在不同分数',time:time.sourceTime,recordIds:[prior.sourceRecordId,h.id],ratings:[prior.rating,rating],examNames:[prior.sourceExamName,h.exam_name]});else duplicateRecords++;}
   if(Math.abs(h.rating_after*100-Math.round(h.rating_after*100))>1e-7)ratingIssues.push({reason:'原始分数超过两位小数，需确认导入精度',sourceRecordId:h.id});
   const row={sourceRecordId:h.id,sourceExamId:h.exam_id,sourceExamName:text(h.exam_name),rating,...time};history.push(row);if(!prior)times.set(time.recordedAt,row);
  }catch(e){ratingIssues.push({reason:e.message,sourceRecordId:h.id});}}
  history.sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.sourceRecordId.localeCompare(b.sourceRecordId));
  const issues=[...normalized.issues];if(names.get(norm(s.name))>1)issues.push('旧系统存在同名学生，需人工确认');
  const unique=candidates.length===1?candidates[0]:null;
  let status=candidates.length===0?'unmatched':candidates.length>1?'ambiguous':unique.blocked?'blocked':issues.length||unique.warnings.length?'review':'proposed';
  const proposedUid=status==='proposed'?unique.uid:null;
  if(proposedUid)for(const h of history){const prior=target.existingSources.find(p=>p.kind==='import'&&p.uid===proposedUid&&p.at===h.recordedAt);if(prior&&prior.rating!==h.rating)ratingIssues.push({reason:'目标 Hydro 同一时间已有不同的导入分数',time:h.sourceTime,ratings:[prior.rating,h.rating]});}
  const latest=history.at(-1)?.rating??null;const currentRating=typeof s.elo_rating==='number'?s.elo_rating:null;
  if(latest!==null&&currentRating!==null&&Math.abs(latest-currentRating)>0.011)ratingIssues.push({reason:'最后一条历史分数与旧系统当前显示分数不一致',historyRating:latest,currentRating});
  return{sourceStudentId:s.id,name:normalized.basic.name,legacyUsernames:oldAccounts,legacyStudentNo:text(s.student_no),...normalized,status,proposedUid,candidates,history,historyCount:history.length,ratingIssues,duplicateRecords,currentRating,latestHistoryRating:latest,notes:[...issues,...(text(s.status)?[]:['旧状态为空，按现有导入规则设为在校'])]};
 });
 const proposedTargets=new Map();for(const r of rows)if(r.proposedUid){if(!proposedTargets.has(r.proposedUid))proposedTargets.set(r.proposedUid,[]);proposedTargets.get(r.proposedUid).push(r);}
 for(const[uid,list]of proposedTargets)if(list.length>1)for(const r of list){r.status='review';r.proposedUid=null;r.notes.push(`多个旧档案指向 Hydro UID ${uid}，禁止重复绑定`);}
 const summary={sourceStudents:rows.length,sourceHistory:raw.history.length,hydroAccounts:target.users.length,existingPluginStudents:target.students.length,statuses:Object.fromEntries(['proposed','review','ambiguous','unmatched','blocked'].map(k=>[k,rows.filter(r=>r.status===k).length])),studentsWithHistory:rows.filter(r=>r.historyCount).length,ratingIssueStudents:rows.filter(r=>r.ratingIssues.length).length,ratingIssueCount:rows.reduce((n,r)=>n+r.ratingIssues.length,0),duplicateRecords:rows.reduce((n,r)=>n+r.duplicateRecords,0),dateOnlyRecords:rows.flatMap(r=>r.history).filter(r=>r.dateOnly).length,proposedStudentCount:rows.filter(r=>r.proposedUid).length,proposedHistoryCount:rows.filter(r=>r.proposedUid&&!r.ratingIssues.length).reduce((n,r)=>n+r.historyCount-r.duplicateRecords,0)};
 const report={format:'hydro-sms-migration-preview-v1',createdAt:new Date().toISOString(),source:{filename:path.basename(source),sha256:sourceHash},target:{database:target.database,snapshotSha256:snapshot,ratingRevision:target.head?.revision??0},readOnly:true,summary,rules:{matching:'精确用户名/实名匹配；多候选、保护账号、同名档案、UID 冲突必须人工处理',fields:['name','gender','grade','school','status','enrollmentDate','currentStage'],time:'elo_change.exam_date；无时区按北京时间，日期精度保留；created_at 是重算时间，不作为历史发生时间',excluded:['密码和登录资料','生日与联系方式','家长资料','内部备注','旧学号、校区、竞赛等级、目标阶段','班级和教师身份','课程、考勤及旧模拟赛实体'],apply:'没有导入模式；确认后通过插件现有预览/确认接口分批执行，重新核对源文件哈希与目标快照；不自动创建账号、不覆盖已有档案'},rows};
 fs.mkdirSync(out,{recursive:true,mode:0o700});const json=JSON.stringify(report,null,2);fs.writeFileSync(path.join(out,'preview.json'),json,{mode:0o600});
 const html=fs.readFileSync(path.join(__dirname,'legacy-sms-preview.html'),'utf8').replace('/*__PREVIEW_DATA__*/',JSON.stringify(report).replace(/</g,()=>String.fromCharCode(92)+'u003c'));
 fs.writeFileSync(path.join(out,'preview.html'),html,{mode:0o600});fs.writeFileSync(path.join(out,'review-decisions.json'),JSON.stringify({format:'hydro-sms-migration-decisions-v1',sourceSha256:sourceHash,targetSnapshotSha256:snapshot,confirmed:false,decisions:rows.map(r=>({sourceStudentId:r.sourceStudentId,name:r.name,uid:r.proposedUid,includeProfile:!!r.proposedUid,includeRating:!!r.proposedUid&&!r.ratingIssues.length,approved:false}))},null,2),{mode:0o600});
 console.log(JSON.stringify({readOnly:true,output:out,...summary},null,2));
}
module.exports={instant,basic,norm};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
