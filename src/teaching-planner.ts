import type { ExamService } from './exams';
import { readFilter } from './access';
/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { createHash, randomUUID } from 'node:crypto';
import { Db, ObjectId } from 'mongodb';
import { OrganizationService } from './organization';
import { StudentService } from './service';
import { SmsError } from './types';
import { object, text, positiveInt, validDate } from './validation';
export const ATTENDANCE = ['', '到课', '迟到', '请假', '旷课'];
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (message: string, status = 400): never => { throw new SmsError(status, message); };
export function date(value: unknown) { const s = text(value, 10, '日期'); if (!s) return fail('请选择日期'); return validDate(s, '上课'); }
function time(value: unknown) { const s = text(value, 5, '时间'); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) fail('时间须为 HH:mm'); return s; }
export function period(from: unknown, to: unknown, max = 92) { const a = date(from), b = date(to); if (Date.parse(b) < Date.parse(a) || Date.parse(b) - Date.parse(a) > max * 86400000) fail(`查询或排课范围不能超过 ${max + 1} 天`); return { from: a, to: b }; }
const revision = (n: unknown) => { if (!Number.isSafeInteger(n) || (n as number) < 0) return fail('版本无效'); return n as number; };
interface Slot { id: string; weekday: number; start: string; end: string }
export interface PlanData { from: string; to: string; title: string; teacherUid: number; location: string; color: string; status: 'active' | 'draft' | 'paused'; slots: Slot[]; remark: string; makeupFor: string }
export interface Plan { batchId?: string; _id: string; domainId: string; version: number; revisions: PlanData[]; fingerprint?: string; updatedBy: number; updatedAt: Date }
interface Row { uid: number; status: string; remark: string }
export interface Lesson { id: string; planId: string; domainId: string; originalDate: string; date: string; start: string; end: string; title: string; teacherUid: number; location: string; color: string; status: 'planned' | 'draft' | 'cancelled' | 'completed'; version: string; makeupFor: string; courseId?: string }
interface Adjustment { _id: string; domainId: string; lesson: Lesson; version: number }
export interface Actual { _id: string; domainId: string; date: string; start: string; end: string; title: string; teacherUid: number; location: string; content: string; remark: string; examId: string; attendance: Row[]; lessonId?: string; planned?: Lesson; version: number; updatedBy: number; updatedAt: Date; requestHash?: string }
export class TeachingPlanner {
 constructor(private db: Db, private students: StudentService, private org: OrganizationService, private examCatalog?: ExamService) {}
 get plans() { return this.db.collection<Plan>('sms_teaching_plans'); }
 get records() { return this.db.collection<Actual>('sms_teaching_records'); }
 get adjustments() { return this.db.collection<Adjustment>('sms_teaching_adjustments'); }
 async init() {
  await this.plans.createIndex({ batchId: 1 });await this.plans.createIndex({ domainId: 1 }); await this.records.createIndex({ domainId: 1, date: -1 });
  await this.records.createIndex({ domainId: 1, lessonId: 1 }, { unique: true, partialFilterExpression: { lessonId: { $type: 'string' } } });
  await this.adjustments.createIndex({ domainId: 1 });
  // Preserve records from the first prototype without reinterpreting a catalog as actual teaching.
  const legacy = await this.db.collection('sms_schedules').find({}).toArray();
  for (const s of legacy) {
   const course = await this.db.collection('sms_courses').findOne({ _id: s.courseId });
   const id = `legacy:${s._id}`; if (await this.plans.findOne({ _id: id })) continue;
   const slots = (s.weekdays as number[]).map(weekday => ({ id: `day${weekday}`, weekday, start: s.start, end: s.end }));
   const p: PlanData = { from: s.from, to: s.to, slots, title: course?.name || '原排课', teacherUid: course?.teacherUid || s.lessons[0]?.teacherUid, location: course?.location || '', color: 'blue', status: 'active', remark: '', makeupFor: '' };
   for (const l of s.lessons) {
    const originalDate = l.id.slice(0, 10), weekday = new Date(originalDate).getUTCDay() || 7;
    const lesson: Lesson = { id: `${id}:day${weekday}@${originalDate}`, planId: id, domainId: s.domainId, originalDate, date: l.date, start: l.start, end: l.end, title: p.title, teacherUid: l.teacherUid, location: l.location, color: 'blue', status: l.status, version: '', makeupFor: '' };
    await this.adjustments.updateOne({ _id: lesson.id }, { $setOnInsert: { domainId: s.domainId, lesson, version: l.version || 1 } }, { upsert: true });
    if (l.status === 'completed') await this.records.updateOne({ _id: lesson.id }, { $setOnInsert: { domainId: s.domainId, ...l, title: p.title, remark: '', examId: '', lessonId: lesson.id, planned: lesson, updatedBy: s.updatedBy, updatedAt: s.updatedAt } }, { upsert: true });
   }
   await this.plans.insertOne({ _id: id, domainId: s.domainId, version: 1, revisions: [p], updatedBy: s.updatedBy, updatedAt: s.updatedAt });
  }
 }
 async context(actor: number, domainId: string, write = false, admin = false) {
  const meta = await this.org.metadata(domainId), domain = await this.org.domain(meta?.domainId || domainId), ctx = await this.org.access(actor, domain, meta);
  if (write && !ctx.staff && !await this.students.authorization.can(actor,admin?'schedules.create':'courses.create',[domain._id])) fail('没有对应教学管理权限', 403);
  return { ...ctx, domain, meta };
 }
 async teacher(domainId: string, value: unknown) { const uid = positiveInt(value, '教师 UID'); if (!(await this.org.metadata(domainId))?.teacherUids.includes(uid) || !await this.org.joined(domainId, uid)) fail('请选择本班当前任课教师'); return uid; }
 async classes(actor: number) { const classes = await this.org.domainList(actor); return Promise.all(classes.map(async c => { const ctx = await this.context(actor, c._id); return { id: c._id, name: c.name || c._id, canTeach:await this.students.authorization.can(actor,'courses.create',[c._id])||await this.students.authorization.can(actor,'courses.update',[c._id]) }; })); }
 build(p: Plan, from: string, to: string): Lesson[] {
  const out: Lesson[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) {
   const day = new Date(t).toISOString().slice(0, 10), r = p.revisions.filter(r => r.from <= day).at(-1); if (!r || day > r.to) continue;
   for (const slot of r.slots.filter(s => s.weekday === (new Date(t).getUTCDay() || 7))) out.push({ id: `${p._id}:${slot.id}@${day}`, planId: p._id, domainId: p.domainId, originalDate: day, date: day, start: slot.start, end: slot.end, title: r.title, teacherUid: r.teacherUid, location: r.location, color: r.color, status: r.status === 'active' ? 'planned' : r.status === 'draft' ? 'draft' : 'cancelled', version: digest([p._id, p.version, slot.id, day]), makeupFor: r.makeupFor });
  } return out;
 }
 async instances(domainId: string | null, from: string, to: string) {
  const filter = domainId ? { domainId } : {}, plans = await this.publishedPlans(filter), overrides = await this.adjustments.find(filter).toArray();
  const map = new Map(plans.flatMap(p => this.build(p, from, to)).map(l => [l.id, l]));
  for (const a of overrides) { if (a.lesson.date >= from && a.lesson.date <= to) map.set(a._id, { ...a.lesson, version: digest([a._id, a.version, a.lesson, plans.find(p => p._id === a.lesson.planId)?.version]) }); else map.delete(a._id); }
  const records = await this.records.find(filter).toArray();
  for (const c of records) if (c.planned) { map.delete(c.lessonId!); if (c.planned.date >= from && c.planned.date <= to) map.set(c.lessonId!, { ...c.planned, status: 'completed', courseId: c._id, version: digest([c._id, c.version, c.planned]) }); }
  return [...map.values()].sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
 }
 async resolve(domainId: string, id: string) {
  const record = await this.records.findOne({ domainId, lessonId: id }); if (record?.planned) return { ...record.planned, status: 'completed' as const, courseId: record._id, version: digest([record._id, record.version, record.planned]) };
  const match = /^(.*)@([\d-]{10})$/.exec(id); if (!match) return fail('课次不存在', 404);
  const day = date(match[2]);
  const lessons = await this.instances(domainId, day, day); const item = lessons.find(l => l.id === id);
  if (item) return item;
  const moved = await this.adjustments.findOne({ _id: id, domainId }); if (!moved) return fail('课次不存在', 404);
  return (await this.instances(domainId, moved.lesson.date, moved.lesson.date)).find(l => l.id === id) || fail('课次不存在', 404);
 }
 async occupancy(from:string,to:string){
  const lessons=await this.instances(null,from,to),records=await this.records.find({date:{$gte:from,$lte:to}}).toArray();
  for(const c of records){if(c.planned&&c.date===c.planned.date&&c.start===c.planned.start&&c.end===c.planned.end&&c.teacherUid===c.planned.teacherUid&&c.location===c.planned.location)continue;
   lessons.push({id:`actual:${c._id}`,planId:`actual:${c._id}`,domainId:c.domainId,originalDate:c.date,date:c.date,start:c.start,end:c.end,title:c.title,teacherUid:c.teacherUid,location:c.location,color:'blue',status:'completed',version:digest([c._id,c.version]),makeupFor:'',courseId:c._id});
  }return lessons;
 }
 async conflicts(proposed: Lesson[], excludePlan?: string, excludeLesson?: string) {
  const active = proposed.filter(l => l.status === 'planned' || l.status === 'completed'); if (!active.length) return;
  const dates = active.map(l => l.date).sort(), old = await this.occupancy(dates[0], dates.at(-1)!);
  const overlap = (a: Lesson, b: Lesson) => a.date === b.date && a.start < b.end && b.start < a.end && (a.domainId === b.domainId || a.teacherUid === b.teacherUid || !!a.location && a.location === b.location);
  for (let i = 0; i < active.length; i++) { const a = active[i]; if (active.slice(0, i).some(b => overlap(a, b)) || old.some(b => b.id !== excludeLesson && (b.planId !== excludePlan || b.status === 'completed') && ['planned', 'completed'].includes(b.status) && overlap(a, b))) fail(`${a.date} ${a.start}–${a.end} 班级、教师或教室冲突`, 409); }
 }
 async publishedPlans(filter: Record<string,unknown> = {}) {
  const committed = await this.db.collection('sms_schedule_batches').find({status:'committed'},{projection:{_id:1}}).toArray();
  return this.plans.find({$and:[filter,{$or:[{batchId:{$exists:false}},{batchId:{$in:committed.map(j=>String(j._id))}}]}]}).toArray();
 }
 async normalizePlan(actor:number,domainId:string,b:Record<string,unknown>,old?:Plan|null) {
  const ctx=await this.context(actor,domainId);domainId=ctx.domain._id;await this.students.requireAction(actor,old?'schedules.update':'schedules.create',[domainId]);await this.students.requireAction(actor,'schedules.read',[domainId]);if(ctx.meta?.status==='archived')fail('归档班级不能排课');
   const r = period(b.from, b.to, 730), title = text(b.title, 100, '排课名称'); if (!title) fail('请填写排课名称');
   if (old && r.from < old.revisions.at(-1)!.from) fail('生效日期不能早于最近一次排课修改');
   if (!['active','draft','paused'].includes(String(b.status))) fail('排课状态无效');
   if (!Array.isArray(b.slots) || !b.slots.length || b.slots.length > 14) return fail('每个排课请设置 1–14 个每周时段');
   const slots: Slot[] = b.slots.map(v => { const s = object(v); this.org.fields(s, ['id','weekday','start','end']); const weekday = positiveInt(s.weekday, '星期'); if (weekday > 7) fail('星期无效'); const start = time(s.start), end = time(s.end); if (start >= end) fail('结束时间必须晚于开始时间'); return { id: s.id ? text(s.id, 80, '时段 ID') : randomUUID(), weekday, start, end }; });
   if (new Set(slots.map(s => s.id)).size !== slots.length) fail('时段 ID 不能重复');
   for (let i=0;i<slots.length;i++) if (slots.slice(0,i).some(s=>s.weekday===slots[i].weekday && s.start<slots[i].end && slots[i].start<s.end)) fail('每周时段不能重叠');
   const makeupFor = text(b.makeupFor ?? '', 200, '补课来源'); if (makeupFor) await this.resolve(domainId, makeupFor);
   const data: PlanData = { ...r, title, teacherUid: await this.teacher(domainId,b.teacherUid), location:text(b.location??'',160,'地点'), color:['blue','cyan','violet','amber','rose','green'].includes(String(b.color))?String(b.color):'blue', status:b.status as PlanData['status'], slots, remark:text(b.remark??'',1000,'排课备注'), makeupFor };
  return {ctx,data};
 }
 async savePlan(actor: number, domainId: string, value: unknown) {
  const b = object(value); this.org.fields(b, ['id','version','title','teacherUid','location','color','status','from','to','slots','remark','makeupFor','requestId','preview','previewToken']);
  return this.org.locked('__sms_teaching__', async verify => {
   const ctx = await this.context(actor, domainId); domainId = ctx.domain._id; await this.students.requireAction(actor,b.id?'schedules.update':'schedules.create',[domainId]); if (ctx.meta?.status === 'archived') fail('归档班级不能排课');
   const requestId = text(b.requestId, 80, '请求标识'); if (!/^[\w-]{8,80}$/.test(requestId)) fail('请求标识无效');
   const id = b.id ? text(b.id, 160, '排课 ID') : `plan:${domainId}:${requestId}`, old = (await this.publishedPlans({ _id: id, domainId }))[0];
   const inputHash = digest({ ...b, preview: undefined, previewToken: undefined });
   if (!b.id && old) { if (old.fingerprint !== inputHash) fail('请求标识已使用', 409); return { saved: true, id }; }
   if (b.id && !old) return fail('排课不存在', 404); if ((old?.version ?? 0) !== revision(b.version)) fail('排课已更新，请刷新', 409);
   const { data } = await this.normalizePlan(actor,domainId,b,old);
   const candidate: Plan = { _id:id, domainId, version:(old?.version??0)+1, revisions:[...(old?.revisions.filter(r=>r.from<data.from)??[]),data], fingerprint:inputHash,updatedBy:actor,updatedAt:new Date() };
   const lessons = this.build(candidate,data.from,data.to);
   // Completed teaching snapshots survive plan changes and do not get regenerated.
   const frozen = new Set((await this.records.find({ domainId, lessonId: { $exists:true } }).toArray()).map(r=>r.lessonId));
   await this.conflicts(lessons.filter(l=>!frozen.has(l.id)),id);
   const token = digest([inputHash,ctx.meta?.version??0]);
   if (b.preview===true) return { previewToken:token,count:lessons.length,lessons:lessons.slice(0,12).map(l=>({date:l.date,start:l.start,end:l.end,title:l.title})) };
   if (b.previewToken!==token) fail('请重新预览排课',409); await verify();
   await this.students.mutation(actor,'schedules.save',id,['title','teacherUid','slots','status','from','to'],async()=>{ if(old){const result=await this.plans.replaceOne({_id:id,version:old.version},candidate);if(!result.matchedCount)fail('排课已变化',409);}else await this.plans.insertOne(candidate); });
   return { saved:true,id };
  });
 }
 async saveCourse(actor: number,domainId: string,value: unknown) {
  const b=object(value);this.org.fields(b,['id','version','requestId','date','start','end','title','teacherUid','location','content','remark','examId','attendance','lessonId','lessonVersion']);
  return this.org.locked('__sms_teaching__',async verify=>{
   const ctx=await this.context(actor,domainId);domainId=ctx.domain._id;await this.students.requireAction(actor,b.id?'courses.update':'courses.create',[domainId]);await this.students.requireAction(actor,'courses.read',[domainId]);
   const request=text(b.requestId,80,'请求标识');if(!/^[\w-]{8,80}$/.test(request))fail('请求标识无效');
   const id=b.id?text(b.id,200,'课程 ID'):`record:${domainId}:${request}`,old=await this.records.findOne({_id:id,domainId});
   if(b.id&&!old)return fail('实际课程不存在',404);
   if(!b.id&&old){if(old.requestHash!==digest(b))fail('请求标识已用于其他实际课程',409);return {saved:true,id,version:old.version};}
   if((old?.version??0)!==revision(b.version))fail('实际课程已更新，请重新打开',409);
   const lessonId=text(b.lessonId??old?.lessonId??'',200,'计划课次'),lesson=lessonId?await this.resolve(domainId,lessonId):undefined;
   if(lesson && (!old || old.lessonId!==lessonId) && lesson.version!==b.lessonVersion)fail('排课已变化，请重新打开',409);
   if(lesson && ['cancelled','draft'].includes(lesson.status))fail('停课或草稿不能登记实际课程');
   if(old?.lessonId&&lessonId!==old.lessonId)fail('不能改写已有课程的排课关联');
   if(lessonId && await this.records.findOne({domainId,lessonId,_id:{$ne:id}}))fail('该课次已经登记实际课程',409);
   const dateValue=date(b.date),start=time(b.start),end=time(b.end);if(start>=end)fail('结束时间必须晚于开始时间');
   const title=text(b.title,100,'课程内容标题');if(!title)fail('请填写课程名称');
   const teacherUid=old?.teacherUid===b.teacherUid?positiveInt(b.teacherUid,'教师 UID'):await this.teacher(domainId,b.teacherUid),detail=await this.org.classDetail(actor,domainId),allowed=new Set([...detail.students.map(s=>s.hydroUid),...(old?.attendance.map(a=>a.uid)??[])]);
   if(!Array.isArray(b.attendance)||b.attendance.length>1000)return fail('考勤名单无效');
   const external=await this.students.authorization.can(actor,'courses.roster',[domainId]);if(external){const policy=await this.students.studentPolicy(actor),filter=readFilter(policy,actor);const extra=await this.students.students.find(filter,{projection:{hydroUid:1}}).toArray();extra.forEach(s=>{if(s.hydroUid)allowed.add(s.hydroUid);});}
   const seen=new Set<number>(),attendance=b.attendance.map(v=>{const a=object(v);this.org.fields(a,['uid','status','remark']);const uid=positiveInt(a.uid);if(seen.has(uid)||!allowed.has(uid))fail('名单重复或学生不属于本班');seen.add(uid);const status=text(a.status,10,'考勤');if(!ATTENDANCE.includes(status))fail('考勤状态无效');return {uid,status,remark:text(a.remark??'',500,'考勤备注')};});
   if(old?.attendance.some(a=>a.status&&!seen.has(a.uid)))fail('不能遗漏已有考勤记录');
   const examId=text(b.examId??'',24,'模拟赛');if(examId){if(!ObjectId.isValid(examId))fail('模拟赛 ID 无效');const associated=this.examCatalog&&await this.examCatalog.exams.findOne({contestId:examId,classIds:domainId,archived:false});if(associated)await this.examCatalog!.model(actor,associated.domainId,examId);else if(!await this.db.collection('document').findOne({domainId,docType:30,docId:new ObjectId(examId)}))fail('关联模拟赛不属于当前班级');}
   const row: Actual={_id:id,domainId,date:dateValue,start,end,title,teacherUid,location:text(b.location??'',160,'地点'),content:text(b.content??'',10000,'教学内容'),remark:text(b.remark??'',2000,'课程备注'),examId,attendance,...lesson?{lessonId,planned:old?.planned??lesson}:{},version:(old?.version??0)+1,updatedAt:new Date(),updatedBy:actor,requestHash:digest(b)};
   await verify();await this.students.requireAction(actor,old?'courses.update':'courses.create',[domainId]);await this.students.mutation(actor,'courses.record',id,['date','title','teacherUid','content','attendance','examId'],async()=>{if(old){const r=await this.records.replaceOne({_id:id,version:old.version},row);if(!r.matchedCount)fail('课程已更新',409);}else await this.records.insertOne(row);});
   return {saved:true,id,version:row.version};
  });
 }
 async changeLesson(actor:number,domainId:string,id:string,value:unknown){
  const b=object(value);this.org.fields(b,['version','action','date','start','end','teacherUid','location','reason','courseId','courseVersion','previewToken']);
  return this.org.locked('__sms_teaching__',async verify=>{
   const ctx=await this.context(actor,domainId);domainId=ctx.domain._id;await this.students.requireAction(actor,['link','linkPreview'].includes(String(b.action))?'courses.link':'schedules.adjust',[domainId]);const lesson=await this.resolve(domainId,id);if(lesson.version!==b.version)fail('课次已更新，请重新打开',409);
   if(b.action==='linkPreview'||b.action==='link'){await this.students.requireAction(actor,'courses.update',[domainId]);await this.students.requireAction(actor,'courses.read',[domainId]);await this.students.requireAction(actor,'schedules.read',[domainId]);
    const c=await this.records.findOne({_id:text(b.courseId,200,'实际课程'),domainId});if(!c)return fail('实际课程不存在',404);if(c.version!==b.courseVersion)fail('实际课程已更新',409);
    if(['cancelled','draft'].includes(lesson.status))fail('该计划课次不能关联实际课程');
    if(c.lessonId&&c.lessonId!==id||await this.records.findOne({domainId,lessonId:id,_id:{$ne:c._id}}))fail('课程或计划课次已经关联',409);
    const token=digest([lesson,c]);if(b.action==='linkPreview')return {previewToken:token,title:c.title,date:c.date,attendanceCount:c.attendance.filter(a=>a.status).length};
    if(b.previewToken!==token)fail('关联预览已变化',409);await verify();await this.students.mutation(actor,'courses.link',c._id,['lessonId'],async()=>{const r=await this.records.updateOne({_id:c._id,version:c.version},{$set:{lessonId:id,planned:lesson,updatedBy:actor,updatedAt:new Date()},$inc:{version:1}});if(!r.matchedCount)fail('课程已更新',409);});return {saved:true};
   }
   if(lesson.status==='completed')fail('已有实际课程，不能直接改动计划课次');
   const next={...lesson};
   if(b.action==='cancel')next.status='cancelled';else if(b.action==='restore'){if(lesson.status!=='cancelled')fail('仅能恢复停课课次');next.status='planned';}
   else if(b.action==='adjust'){next.date=date(b.date);next.start=time(b.start);next.end=time(b.end);if(next.start>=next.end)fail('结束时间必须晚于开始时间');next.teacherUid=await this.teacher(domainId,b.teacherUid);next.location=text(b.location??'',160,'地点');}else fail('操作无效');
   await this.conflicts([next],undefined,id);const old=await this.adjustments.findOne({_id:id,domainId});await verify();
   await this.students.mutation(actor,`lessons.${b.action}`,id,['date','start','end','status','reason'],()=>this.adjustments.updateOne({_id:id},{$set:{domainId,lesson:next,reason:text(b.reason??'',500,'调整原因')},$inc:{version:1}},{upsert:true}));return {saved:true,previousVersion:old?.version??0};
  });
 }
}
