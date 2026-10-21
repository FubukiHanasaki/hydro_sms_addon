/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import * as XLSX from 'xlsx';
import { Db, Document } from 'mongodb';
import { ScheduleBatchService } from './schedule-batch';
import { StudentService } from './service';
import { OrganizationService } from './organization';
import { TeachingService } from './teaching';
import { RatingService } from './rating';
import { AccountManagement } from './account-management';
import { BulkService } from './bulk';
import { StudentImportService } from './student-import';
import { visibleStudent } from './access';
import { SmsError } from './types';
import { text } from './validation';
type Cell = string | number | boolean | null | undefined;
export interface ExportTable { name:string; headers:string[]; rows:Cell[][] }
export const MAX_EXPORT_ROWS=10000;
const at=(v:unknown)=>v?new Date(v as string).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false}):'';
export function encodeExport(table:ExportTable,format:string){
 if(!['xlsx','csv'].includes(format))throw new SmsError(400,'请选择 Excel 或 CSV 格式');
 if(table.rows.length>MAX_EXPORT_ROWS)throw new SmsError(400,'导出最多 10000 行，请缩小筛选范围');
 let bytes:Buffer;
 if(format==='csv')bytes=Buffer.from('\uFEFF'+[table.headers,...table.rows].map(row=>row.map(v=>{let s=String(v??'');if(typeof v==='string'&&/^[\s\uFEFF]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n'),'utf8');
 else{const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([table.headers,...table.rows.map(r=>r.map(v=>v??''))]);sheet['!cols']=table.headers.map((h,n)=>({wch:Math.min(48,Math.max(12,h.length*2,...table.rows.slice(0,100).map(r=>String(r[n]??'').length+2)))}));sheet['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:table.rows.length,c:table.headers.length-1}})};XLSX.utils.book_append_sheet(book,sheet,table.name.replace(/[\\/?*\[\]:]/g,'').slice(0,31));bytes=XLSX.write(book,{type:'buffer',bookType:'xlsx'});}
 if(bytes.length>20*1024*1024)throw new SmsError(400,'导出文件超过 20 MB，请缩小范围');
 return {bytes,type:format==='csv'?'text/csv; charset=utf-8':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',filename:`${table.name}-${new Date(Date.now()+8*3600000).toISOString().slice(0,10)}.${format}`};
}
export async function collectExport<T>(read:(page:number)=>Promise<{total:number;rows:T[];revision?:number}>):Promise<T[]>{
 const first=await read(1);if(first.total>MAX_EXPORT_ROWS)throw new SmsError(400,'导出最多 10000 行，请缩小筛选范围');const rows=[...first.rows];if(first.total&&!rows.length)throw new SmsError(409,'列表已变化，请重新查询');
 for(let page=2;rows.length<first.total;page++){const next=await read(page);if(next.total!==first.total||next.revision!==first.revision||!next.rows.length)throw new SmsError(409,'数据在导出期间已变化，请重新导出');rows.push(...next.rows);}
 return rows;
}
export class ExportService {
 constructor(private db:Db,private students:StudentService,private org:OrganizationService,private teaching:TeachingService,private rating:RatingService,private accounts:AccountManagement,private bulk:BulkService,private imports:StudentImportService,private batches?:ScheduleBatchService){}
 async build(actor:number,kind:string,q:Record<string,unknown>,domain='system'):Promise<ExportTable>{
  const all=collectExport;
  if(kind==='students'){
   if(q.sensitive!==undefined&&!['true','false'].includes(String(q.sensitive)))throw new SmsError(400,'敏感资料选项无效');
   const rows=await all(async page=>{const d=await this.students.list(actor,q.q,page,q.status,{grade:q.grade,school:q.school,domainId:q.domainId});return {total:d.total,rows:d.students};});
   const include=q.sensitive==='true',policy=await this.students.policy();const details=include?await this.students.students.find({_id:{$in:rows.map(s=>s.id)}}).toArray():[];
   return {name:'学生资料',headers:['姓名','性别','年级','学校','学生状态','入学日期','学习阶段','Hydro UID',...(include?['生日','联系电话','家长姓名','家长电话','微信','家庭地址','内部备注','敏感资料可见']:[])],rows:rows.map(s=>{const v=details.find(v=>v._id===s.id),visible=v?visibleStudent(policy,actor,v):null;return [s.name,s.gender,s.grade,s.school,s.status,s.enrollmentDate,s.currentStage,s.hydroUid,...(include?[visible?.sensitive?.birthday,visible?.sensitive?.phone,visible?.sensitive?.parentName,visible?.sensitive?.parentPhone,visible?.sensitive?.wechat,visible?.sensitive?.address,visible?.internalNote,visible?.sensitive?'是':'否']:[])];})};
  }
  if(kind==='accounts'){const rows=await all<Document>(async page=>{const d=await this.accounts.list(actor,q.q,q.enabled,page);return {total:d.total,rows:d.accounts};});return {name:'账户列表',headers:['UID','用户名','关联学生','启用状态','受保护账号'],rows:rows.map(a=>[a.uid,a.username,a.studentName,a.enabled?'已启用':'已停用',a.protected?'是':'否'])};}
  if(kind==='classes'){const rows=await all(async page=>{const d=await this.org.classList(actor,q.q,q.domainId,q.status,page);return {total:d.total,rows:d.classes};});return {name:'班级与子域',headers:['子域 ID','名称','班型','学年','状态','成员数'],rows:rows.map(c=>[c.domainId,c.name,c.type,c.academicYear,c.status==='active'?'开班中':'已归档',c.memberCount])};}
  if(kind==='members'){const id=text(q.classId,160,'班级 ID');const rows=await all<Document>(async page=>{const d=await this.org.domainMembers(actor,id,q.q,page);return {total:d.total,rows:d.members};});return {name:'班级成员',headers:['子域 ID','UID','用户名','学生姓名','身份'],rows:rows.map(m=>[id,m.uid,m.username,m.studentName,({teacher:'任课教师',student:'学生',member:'普通成员'}as Record<string,string>)[m.kind]||m.kind])};}
  if(kind==='rating'){const scope=await this.org.ratingScope(actor,domain,q.classId);const rows=await all(async page=>{const d=await this.rating.board(scope.domainId,q.q,page,q.mode??'all',q.grade,q.school);return {total:d.total,rows:d.users,revision:d.revision};});return {name:'Rating排行榜',headers:['排名','UID','用户名','Rating','称号','近30天变化','趋势','计分比赛','最高Rating'],rows:rows.map(u=>[u.rank,u.uid,u.username,u.rating,u.title,u.recent.delta,u.recent.text,u.contests,u.peak])};}
  if(kind==='rating-history'){if(q.period&&!['all','recent'].includes(String(q.period)))throw new SmsError(400,'历史范围无效');const rows=await all(async page=>{const d=await this.rating.history(q.uid,page);return {total:d.total,rows:d.history,revision:d.revision};});const recent=Date.now()-30*86400000;return {name:'Rating历史',headers:['UID','记录时间（北京时间）','来源','类型','难度','原分数','新分数','变化','名次','参赛人数'],rows:rows.filter(r=>q.period!=='recent'||+new Date(r.at)>=recent).map(r=>[r.uid,at(r.at),r.title,r.kind==='import'?'历史导入':'比赛',r.difficulty,r.before,r.after,r.delta,r.rank,r.participants])};}
  if(kind==='audit'){await this.students.requireAdmin(actor);const rows=await this.db.collection('sms_audit').find({}).sort({at:-1}).limit(MAX_EXPORT_ROWS+1).toArray();return {name:'操作记录',headers:['时间（北京时间）','操作者 UID','操作','对象','字段','结果'],rows:rows.map(r=>[at(r.at),r.uid,r.action,r.target,(r.fields||[]).join('、'),r.outcome||'已记录'])};}
  if(kind==='permissions'){const p=await this.students.permissions(actor);return {name:'访问授权',headers:['UID','身份','允许操作','学生范围','失效时间（北京时间）'],rows:[...p.admins.map(uid=>[uid,'插件管理员','全部','全部学生','']),...p.grants.map(g=>[g.uid,'已授权用户',g.permissions.join('、'),g.studentIds==='all'?'全部学生':g.studentIds.join('、'),at(g.expiresAt)])]};}
  if(kind==='bulk-result'||kind==='bulk-accounts'){
   const j=await this.bulk.detail(actor,text(q.id,100,'批次 ID'));
   if(kind==='bulk-accounts'){if(j.kind!=='provision')throw new SmsError(400,'此批次不是账号补建');return {name:'补建账号',headers:['学生','UID','用户名','初始密码'],rows:j.items.filter(i=>i.done).map(i=>[i.name,i.uid,i.username,i.username])};}
   return {name:'批量操作结果',headers:['批次','类型','学生','UID','用户名','原年级','新年级','原状态','新状态','执行结果','错误'],rows:j.items.map(i=>[j.id,j.kind,i.name,i.uid,i.username,i.grade,i.afterGrade,i.status,i.afterStatus,i.undone?'已撤销':i.done?'已完成':'未完成',i.error])};
  }
  if(kind==='import-accounts'||kind==='import-result'){
   const j=await this.imports.detail(actor,text(q.id,100,'批次 ID'));const items=j.items!;
   if(kind==='import-accounts')return {name:'导入学生账号',headers:['姓名','UID','用户名','初始密码'],rows:items.filter(i=>i.done).map(i=>[i.basic.name,i.hydroUid,i.username,i.accountCreated?i.username:''])};
   return {name:'学生导入结果',headers:['文件行','姓名','年级','学校','学生状态','UID','用户名','识别结果','选择导入','执行结果','原因'],rows:items.map(i=>[i.row,i.basic.name,i.basic.grade,i.basic.school,i.basic.status,i.hydroUid,i.username,({create:'新增',bind:'绑定已有档案',duplicate:'重复',suspect:'疑似重复',error:'错误'}as Record<string,string>)[i.kind]||i.kind,i.selected?'是':'否',i.done?'已完成':'未执行',i.error||i.reason])};
  }
  if(kind==='schedule-batch-result'||kind==='schedule-batch-conflicts'){
   if(!this.batches)throw new SmsError(400,'批量排课不可用');const j=await this.batches.detail(actor,text(q.id,100,'批次 ID'));
   if(kind==='schedule-batch-conflicts')return {name:'排课冲突展示',headers:['文件行','日期','开始时间','结束时间','原因','来源','对方文件行','对方子域','对方排课','对方开始','对方结束'],rows:j.conflicts.map(c=>[c.row,c.date,c.start,c.end,c.reasons.join('、'),c.source==='batch'?'本批排课':'既有排课',c.otherRow,c.otherDomainId,c.otherTitle,c.otherStart,c.otherEnd])};
   return {name:'批量排课检查结果',headers:['文件行','班级','子域 ID','排课名称','教师','教师 UID','开始日期','结束日期','每周时段','状态','课次数','校验错误','批次状态','本批冲突总数'],rows:j.entries.map(e=>[e.row,e.className,e.domainId,e.data?.title||e.inputTitle,e.teacherName,e.data?.teacherUid,e.data?.from,e.data?.to,e.data?.slots.map(s=>`周${'一二三四五六日'[s.weekday-1]} ${s.start}–${s.end}`).join('；'),e.data?.status,e.count,e.error,j.status,j.conflictCount])};
  }
  const teachingKinds=['courses','attendance','attendance-summary','schedule','plans','class-summary','class-rating','rating-timeline','contest-analysis','contests'];
  if(teachingKinds.includes(kind)){
   if((kind==='schedule'||kind==='plans')&&!q.classId){const d=await this.teaching.scheduleBoard(actor,q.teacherUid,q.from,q.to);return kind==='schedule'?this.lessonTable(d.lessons,id=>d.classes.find(c=>c.id===id)?.name||id,uid=>d.teachers.find(t=>t.uid===uid)?.name||`UID ${uid}`):this.planTable(d.plans,id=>d.classes.find(c=>c.id===id)?.name||id,uid=>d.teachers.find(t=>t.uid===uid)?.name||`UID ${uid}`);}
   const d=await this.teaching.overview(actor,text(q.classId,160,'班级 ID'),q.from,q.to),c=d.class;
   const teacher=(uid:number)=>c.teachers.find(t=>t.uid===uid)?.name||`UID ${uid}`;
   if(kind==='class-summary')return {name:'班级概览',headers:['子域 ID','班级','开始日期','结束日期','实际课程','计划课次','模拟赛','到课率(%)','平均Rating'],rows:[[c.domainId,c.name,d.period.from,d.period.to,d.courses.length,d.lessons.length,d.contests.length,d.attendance.rate,d.rating.average]]};
   if(kind==='courses')return {name:'实际课程',headers:['班级','课程 ID','日期','开始时间','结束时间','时长(分钟)','课程标题','教师','教师 UID','地点','教学内容','课程备注','模拟赛 ID','关联课次','可见考勤条数'],rows:d.courses.map(r=>[c.name,r._id,r.date,r.start,r.end,this.minutes(r.start,r.end),r.title,teacher(r.teacherUid),r.teacherUid,r.location,r.content,r.remark,r.examId,r.lessonId,r.attendance.length])};
   if(kind==='attendance')return {name:'考勤明细',headers:['班级','日期','开始时间','课程','课程 ID','学生 UID','学生姓名','考勤','考勤备注'],rows:d.courses.flatMap(r=>r.attendance.map(a=>[c.name,r.date,r.start,r.title,r._id,a.uid,c.students.find(s=>s.hydroUid===a.uid)?.name||`UID ${a.uid}`,a.status||'未填写',a.remark]))};
   if(kind==='attendance-summary')return {name:'学生考勤汇总',headers:['班级','开始日期','结束日期','UID','学生','到课','迟到','请假','旷课','有效考勤次数','到课率(%)'],rows:d.attendance.students.map(s=>[c.name,d.period.from,d.period.to,s.uid,s.name,s.present,s.late,s.leave,s.absent,s.recorded,s.recorded?Math.round((s.present+s.late)/s.recorded*10000)/100:null])};
   if(kind==='schedule')return this.lessonTable(d.lessons,()=>c.name,teacher);
   if(kind==='plans')return this.planTable(d.plans.map(p=>({...p,domainId:c.domainId})),()=>c.name,teacher);
   if(kind==='class-rating')return {name:'班级Rating',headers:['班级','UID','学生','Rating','称号','区间变化','计分比赛'],rows:d.rating.board.map(s=>[c.name,s.uid,s.name,s.rating,s.title,s.periodDelta,s.contests])};
   if(kind==='rating-timeline')return {name:'平均Rating走势',headers:['班级','时间（北京时间）','平均Rating'],rows:d.rating.timeline.map(s=>[c.name,at(s.at),s.rating])};
   if(kind==='contest-analysis')return {name:'模拟赛涨跌分析',headers:['班级','时间（北京时间）','比赛','比赛子域','比赛 ID','人数','平均变化','中位数','最大变化','最小变化'],rows:d.rating.trend.map(t=>[c.name,at(t.at),t.title,t.domainId,t.contestId,t.count,t.average,t.median,t.max,t.min])};
   if(!d.canTeach)throw new SmsError(403,'没有班级模拟赛管理权限');return {name:'班级模拟赛',headers:['班级','比赛 ID','标题','开始时间（北京时间）','结束时间（北京时间）','赛制','Rating已结算'],rows:d.contests.map(t=>[c.name,t.id,t.title,at(t.beginAt),at(t.endAt),t.rule,t.settled?'是':'否'])};
  }
  throw new SmsError(400,'不支持此导出项目');
 }
 minutes(start:string,end:string){const n=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3));return n(end)-n(start);}
 lessonTable(rows:{domainId:string;date:string;start:string;end:string;title:string;teacherUid:number;location:string;status:string;id:string;planId:string;courseId?:string}[],name:(id:string)=>string,teacher:(uid:number)=>string):ExportTable{return {name:'排课课次',headers:['班级','子域 ID','日期','开始时间','结束时间','时长(分钟)','排课','教师','教师 UID','地点','状态','课次 ID','计划 ID','实际课程 ID'],rows:rows.map(l=>[name(l.domainId),l.domainId,l.date,l.start,l.end,this.minutes(l.start,l.end),l.title,teacher(l.teacherUid),l.teacherUid,l.location,({planned:'待上课',draft:'草稿',cancelled:'已停课',completed:'已登记课程'}as Record<string,string>)[l.status]||l.status,l.id,l.planId,l.courseId])};}
 planTable(rows:{domainId:string;title:string;from:string;to:string;teacherUid:number;location:string;status:string;remark:string;slots:{weekday:number;start:string;end:string}[]}[],name:(id:string)=>string,teacher:(uid:number)=>string):ExportTable{return {name:'排课计划',headers:['班级','子域 ID','计划','开始日期','结束日期','教师','教师 UID','地点','状态','每周时段','备注'],rows:rows.map(p=>[name(p.domainId),p.domainId,p.title,p.from,p.to,teacher(p.teacherUid),p.teacherUid,p.location,({active:'进行中',draft:'草稿',paused:'已暂停'}as Record<string,string>)[p.status]||p.status,p.slots.map(s=>`周${'一二三四五六日'[s.weekday-1]} ${s.start}–${s.end}`).join('；'),p.remark])};}
 async download(actor:number,kind:string,q:Record<string,unknown>,domain='system'){
  if(!Number.isSafeInteger(actor)||actor<=0)throw new SmsError(403,'请先登录');const started=Date.now(),policy=await this.students.policy(),before=JSON.stringify(policy);const data=await this.build(actor,kind,q,domain);
  if(policy.grants.some(g=>g.uid===actor&&g.expiresAt&&Date.parse(g.expiresAt)>started&&Date.parse(g.expiresAt)<=Date.now())||JSON.stringify(await this.students.policy())!==before)throw new SmsError(409,'授权在导出期间发生变化，请重试');
  const result=encodeExport(data,String(q.format??'xlsx'));await this.students.audit(actor,'exports.download',kind,[...(q.sensitive==='true'?['sensitive']:[]),'rows:'+data.rows.length]);return result;
 }
}
