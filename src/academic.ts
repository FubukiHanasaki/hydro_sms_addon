/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { readFilter } from './access';
import { Db } from 'mongodb';
import { StudentService } from './service';
import { OrganizationService } from './organization';
import { TeachingService } from './teaching';
import { Actual, Lesson, period } from './teaching-planner';
import { SmsError } from './types';
import { text } from './validation';
export const LESSON_STATES={future:'未开始',live:'上课时段',unrecorded:'待录课程',incomplete:'考勤待补',completed:'已完成',cancelled:'已停课',draft:'草稿'};
export function attendanceCounts(course?:Actual){const rows=course?.attendance??[];return {participants:rows.length,present:rows.filter(r=>r.status==='到课').length,late:rows.filter(r=>r.status==='迟到').length,leave:rows.filter(r=>r.status==='请假').length,absent:rows.filter(r=>r.status==='旷课').length,missing:rows.filter(r=>!r.status).length};}
export function lessonState(lesson:Lesson,course?:Actual,now=Date.now()){
 const a=attendanceCounts(course),start=Date.parse(`${lesson.date}T${lesson.start}+08:00`),end=Date.parse(`${lesson.date}T${lesson.end}+08:00`);
 const state: keyof typeof LESSON_STATES=lesson.status==='draft'?'draft':lesson.status==='cancelled'?'cancelled':course?Date.parse(`${course.date}T${course.start}+08:00`)>now?'future':a.missing||!a.participants?'incomplete':'completed':now<start?'future':now<end?'live':'unrecorded';
 const exceptions:string[]=[];if(state==='unrecorded')exceptions.push('待登记实际课程');if(state==='incomplete')exceptions.push(a.participants?`${a.missing} 人考勤未填`:'未确认参与名单');
 if(course&&(course.date!==lesson.date||course.start!==lesson.start||course.end!==lesson.end))exceptions.push('实际时间与排课不同');
 return {state,stateLabel:LESSON_STATES[state],attendance:a,exceptions};
}
interface Daily {date:string;planned:number;cancelled:number;makeup:number;actual:number;independent:number;uniqueStudents:number;participants:number;present:number;late:number;leave:number;absent:number;missing:number}
export class AcademicService {
 constructor(private db:Db,private students:StudentService,private org:OrganizationService,private teaching:TeachingService){}
 async candidates(actor:number,domainId:string,value:unknown){await this.students.requireAction(actor,'courses.roster',[domainId]);const policy=await this.students.studentPolicy(actor),q=text(value??'',80,'学生搜索');if(!q)return [];const filter=readFilter(policy,actor),pattern=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return this.students.students.find({$and:[filter,{hydroUid:{$type:'number'}},{$or:[{'basic.name':{$regex:pattern,$options:'i'}},.../^[1-9]\d*$/.test(q)?[{hydroUid:Number(q)}]:[]]}]},{projection:{hydroUid:1,'basic.name':1}}).limit(20).toArray();}
 async board(actor:number,q:Record<string,unknown>={}){
  const scope=await this.students.authorization.scope(actor,'reports.read'),courseScope=await this.students.authorization.scope(actor,'courses.read'),scheduleScope=await this.students.authorization.scope(actor,'schedules.read');
  if(scope!==null&&!scope.length)throw new SmsError(403,'没有教务报表权限');
  const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10),dates=period(q.from||`${day.slice(0,7)}-01`,q.to||new Date(Date.UTC(+day.slice(0,4),+day.slice(5,7),0)).toISOString().slice(0,10));
  const visible=await this.org.domainList(actor),classes=visible.filter(c=>(scope===null||scope.includes(c._id))&&(courseScope===null||courseScope.includes(c._id))),classId=text(q.classId??'',64,'班级'),teacher=text(q.teacherUid??'',20,'教师');
  if(classId&&!classes.some(c=>c._id===classId))throw new SmsError(403,'无权查看该班教务数据');if(teacher&&!/^[1-9]\d*$/.test(teacher))throw new SmsError(400,'教师 UID 无效');
  const ids=classes.filter(c=>!classId||c._id===classId).map(c=>c._id),planIds=ids.filter(id=>scheduleScope===null||scheduleScope.includes(id)),allLessons=(await Promise.all(planIds.map(id=>this.teaching.instances(id,dates.from,dates.to)))).flat();
  const actual=await this.teaching.records.find({domainId:{$in:ids},date:{$gte:dates.from,$lte:dates.to}}).sort({date:1,start:1,_id:1}).limit(5001).toArray();if(actual.length>5000||allLessons.length>10000)throw new SmsError(400,'教务数据过多，请缩小日期范围');
  const linked=await this.teaching.records.find({_id:{$in:allLessons.flatMap(l=>l.courseId?[l.courseId]:[])},domainId:{$in:ids}}).toArray();
  const metadata=await this.org.classes.find({domainId:{$in:ids}}).toArray(),members=await this.db.collection('domain.user').find({domainId:{$in:ids},join:true}).toArray();
  const assigned=metadata.flatMap(c=>c.teacherUids.filter(uid=>members.some(m=>m.domainId===c.domainId&&m.uid===uid)));
  const uids=[...new Set([...assigned,...allLessons.map(l=>l.teacherUid),...actual.map(c=>c.teacherUid)])],users=await this.db.collection('user').find({_id:{$in:uids} as never},{projection:{uname:1}}).toArray(),profiles=await this.db.collection('sms_teachers').find({hydroUid:{$in:uids}},{projection:{hydroUid:1,'basic.name':1}}).toArray();
  const teachers=uids.map(uid=>({uid,name:profiles.find(p=>p.hydroUid===uid)?.basic?.name||users.find(u=>Number(u._id)===uid)?.uname||`UID ${uid}`}));
  if(teacher&&!teachers.some(t=>t.uid===Number(teacher)))throw new SmsError(403,'教师不在可访问教务范围');
  const names=(domainId:string,teacherUid:number)=>({className:classes.find(c=>c._id===domainId)?.name||domainId,teacherName:teachers.find(t=>t.uid===teacherUid)?.name||`UID ${teacherUid}`});
  const lessons=allLessons.filter(l=>!teacher||l.teacherUid===Number(teacher)).map(l=>({...l,...names(l.domainId,l.teacherUid),...lessonState(l,linked.find(c=>c._id===l.courseId))})).sort((a,b)=>`${a.date} ${a.start} ${a.id}`.localeCompare(`${b.date} ${b.start} ${b.id}`));
  const records=actual.filter(c=>!teacher||c.teacherUid===Number(teacher)).map(c=>({id:c._id,domainId:c.domainId,date:c.date,start:c.start,end:c.end,title:c.title,teacherUid:c.teacherUid,lessonId:c.lessonId,version:c.version,...names(c.domainId,c.teacherUid),attendance:attendanceCounts(c),participantUids:c.attendance.map(a=>a.uid),source:c.lessonId?'linked':'independent'}));
  const states=Object.fromEntries(Object.keys(LESSON_STATES).map(k=>[k,lessons.filter(l=>l.state===k).length])),daily:Daily[]=[];
  for(let t=Date.parse(dates.from);t<=Date.parse(dates.to);t+=86400000){const date=new Date(t).toISOString().slice(0,10),p=lessons.filter(l=>l.date===date),a=records.filter(c=>c.date===date);daily.push({date,planned:p.filter(l=>!['cancelled','draft'].includes(l.state)).length,cancelled:p.filter(l=>l.state==='cancelled').length,makeup:p.filter(l=>l.makeupFor&&!['cancelled','draft'].includes(l.state)).length,actual:a.length,independent:a.filter(c=>c.source==='independent').length,uniqueStudents:new Set(a.flatMap(c=>c.participantUids)).size,...Object.fromEntries(['participants','present','late','leave','absent','missing'].map(key=>[key,a.reduce((n,c)=>n+c.attendance[key as keyof typeof c.attendance],0)]))} as Daily);}
  const totals={...Object.fromEntries(['planned','cancelled','makeup','actual','independent','participants','present','late','leave','absent','missing'].map(k=>[k,daily.reduce((n,r)=>n+Number((r as any)[k]),0)])),uniqueStudents:new Set(records.flatMap(r=>r.participantUids)).size};
  const state=text(q.state??'',20,'状态');if(state&&!Object.hasOwn(LESSON_STATES,state)&&state!=='exceptions')throw new SmsError(400,'课次状态无效');const rows=lessons.filter(l=>!state||(state==='exceptions'?l.exceptions.length:l.state===state)),page=Number(q.page??1);if(!Number.isSafeInteger(page)||page<1||page>100000)throw new SmsError(400,'页码无效');
  return {period:dates,classes:classes.map(c=>({id:c._id,name:c.name||c._id})),teachers,states,stateLabels:LESSON_STATES,totals,exceptions:lessons.filter(l=>l.exceptions.length).length,total:rows.length,page,pageSize:25,lessons:rows.slice((page-1)*25,page*25),daily,actual:records.map(({participantUids,...c})=>c),canExport:await this.students.authorization.can(actor,'reports.export',ids.length?ids:undefined)};
 }
}
