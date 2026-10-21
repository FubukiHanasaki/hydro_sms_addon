/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { createHash, randomUUID } from 'node:crypto';
import { Db } from 'mongodb';
import { OrganizationService } from './organization';
import { StudentService } from './service';
import { RatingService } from './rating';
import { SmsError } from './types';
import { object, positiveInt, text, validDate } from './validation';

export const ATTENDANCE = ['', '到课', '迟到', '请假', '旷课'] as const;
interface Attendance { uid: number; status: string; remark: string }
interface Lesson { id: string; date: string; start: string; end: string; teacherUid: number; location: string; status: 'planned' | 'completed' | 'cancelled'; content: string; attendance: Attendance[]; version: number }
interface Course { _id: string; domainId: string; name: string; description: string; teacherUid: number; location: string; status: 'active' | 'archived'; version: number; updatedAt: Date; updatedBy: number }
interface Schedule { _id: string; domainId: string; courseId: string; from: string; to: string; weekdays: number[]; start: string; end: string; lessons: Lesson[]; version: number; fingerprint: string; updatedAt: Date; updatedBy: number }
const fail = (message: string, status = 400): never => { throw new SmsError(status, message); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function day(value: unknown) { const v = text(value, 10, '日期'); if (!v) return fail('请选择日期'); return validDate(v, '上课'); }
function clock(value: unknown) { const v = text(value, 5, '时间'); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail('时间请填写 HH:mm'); return v; }
function range(from: unknown, to: unknown, limit: number) { const a = day(from), b = day(to); const days = (Date.parse(b) - Date.parse(a)) / 86400000; if (days < 0 || days > limit) fail(`日期范围须在 ${limit + 1} 天以内`); return { from: a, to: b }; }
function version(value: unknown) { if (!Number.isSafeInteger(value) || (value as number) < 0) fail('请提供有效版本'); return value as number; }
function overlap(a: Lesson, b: Lesson) { return a.date === b.date && a.start < b.end && b.start < a.end; }
export class TeachingService {
  constructor(private db: Db, private students: StudentService, private org: OrganizationService, private rating: RatingService) {}
  get courses() { return this.db.collection<Course>('sms_courses'); }
  get schedules() { return this.db.collection<Schedule>('sms_schedules'); }
  async init() { await this.courses.createIndex({ domainId: 1, status: 1 }); await this.schedules.createIndex({ domainId: 1, from: 1, to: 1 }); await this.schedules.createIndex({ courseId: 1 }); }
  async context(actor: number, id: string, write = false, admin = false) {
    const meta = await this.org.metadata(id), domain = await this.org.domain(meta?.domainId || id), access = await this.org.access(actor, domain, meta);
    if (write && (!access.staff || (admin && !access.me.admin))) fail('没有课程管理权限', 403);
    return { ...access, domain, meta };
  }
  async teacher(domainId: string, uid: unknown) {
    const id = positiveInt(uid, '任课教师 UID'), meta = await this.org.metadata(domainId);
    if (!meta?.teacherUids.includes(id) || !await this.org.joined(domainId, id)) fail('任课教师必须是该班级已加入的任课教师');
    return id;
  }
  async saveCourse(actor: number, domainId: string, input: unknown) {
    const b = object(input); this.org.fields(b, ['id', 'version', 'name', 'description', 'teacherUid', 'location', 'status']);
    return this.org.locked('__sms_teaching__', async verify => {
      const ctx = await this.context(actor, domainId, true, true); domainId = ctx.domain._id;
      if (ctx.meta?.status === 'archived') fail('归档班级不能新增或修改课程');
      const id = b.id ? text(b.id, 100, '课程 ID') : randomUUID(), old = await this.courses.findOne({ _id: id, domainId });
      if (b.id && !old) fail('课程不存在', 404);
      if ((old?.version ?? 0) !== version(b.version)) fail('课程已更新，请刷新后重试', 409);
      const name = text(b.name, 100, '课程名称'); if (!name) fail('请填写课程名称');
      if (!['active', 'archived'].includes(String(b.status))) fail('课程状态无效');
      const data = { domainId, name, description: text(b.description ?? '', 3000, '课程说明'), teacherUid: await this.teacher(domainId, b.teacherUid), location: text(b.location ?? '', 160, '地点'), status: b.status as Course['status'], updatedAt: new Date(), updatedBy: actor };
      await verify();
      await this.students.mutation(actor, 'courses.save', id, ['name', 'description', 'teacherUid', 'location', 'status'], async () => {
        if (old) { const r = await this.courses.updateOne({ _id: id, version: old.version }, { $set: data, $inc: { version: 1 } }); if (!r.matchedCount) fail('课程已更新', 409); }
        else await this.courses.insertOne({ _id: id, ...data, version: 1 });
      });
      return this.courses.findOne({ _id: id, domainId });
    });
  }
  async conflict(domainId: string, proposed: Lesson[], ignoreSchedule?: string, ignoreLesson?: string) {
    const active = proposed.filter(l => l.status !== 'cancelled'); if (!active.length) return;
    const dates = active.map(l => l.date).sort();
    const schedules = await this.schedules.find({ from: { $lte: dates.at(-1)! }, to: { $gte: dates[0] } }).toArray();
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      const clash = (b: Lesson, sameClass: boolean) => b.status !== 'cancelled' && overlap(a, b) && (sameClass || a.teacherUid === b.teacherUid || !!a.location && a.location === b.location);
      if (active.slice(0, i).some(b => clash(b, true))) fail('本次排课存在重叠', 409);
      for (const s of schedules) for (const b of s.lessons) {
        if (s._id === ignoreSchedule && (!ignoreLesson || b.id === ignoreLesson)) continue;
        if (clash(b, s.domainId === domainId)) fail(`${a.date} ${a.start}–${a.end} 班级、教师或教室已有课程`, 409);
      }
    }
  }
  async schedule(actor: number, domainId: string, input: unknown) {
    const b = object(input); this.org.fields(b, ['courseId', 'courseVersion', 'from', 'to', 'weekdays', 'start', 'end', 'preview', 'previewToken', 'requestId']);
    return this.org.locked('__sms_teaching__', async verify => {
      const ctx = await this.context(actor, domainId, true, true); domainId = ctx.domain._id;
      if (ctx.meta?.status === 'archived') fail('归档班级不能排课');
      const courseId = text(b.courseId, 100, '课程'), course = await this.courses.findOne({ _id: courseId, domainId });
      if (!course || course.status !== 'active') return fail('请选择开课中的课程');
      if (course.version !== version(b.courseVersion)) fail('课程已更新，请重新选择', 409);
      await this.teacher(domainId, course.teacherUid);
      const r = range(b.from, b.to, 365), start = clock(b.start), end = clock(b.end); if (start >= end) fail('结束时间必须晚于开始时间');
      if (!Array.isArray(b.weekdays) || !b.weekdays.length || b.weekdays.some(n => !Number.isInteger(n) || n < 1 || n > 7)) fail('请选择每周上课日');
      const weekdays = [...new Set(b.weekdays as number[])].sort(); const lessons: Lesson[] = [];
      for (let t = Date.parse(r.from); t <= Date.parse(r.to); t += 86400000) if (weekdays.includes(new Date(t).getUTCDay() || 7)) {
        const date = new Date(t).toISOString().slice(0, 10); lessons.push({ id: date, date, start, end, teacherUid: course.teacherUid, location: course.location, status: 'planned', content: '', attendance: [], version: 1 });
      }
      if (!lessons.length || lessons.length > 104) fail('每批请生成 1–104 节课');
      const requestId = text(b.requestId, 80, '排课请求标识'); if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) fail('排课请求标识无效');
      const fingerprint = hash({ domainId, courseId, courseVersion: course.version, ...r, weekdays, start, end });
      const id = `${domainId}:${requestId}`, previous = await this.schedules.findOne({ _id: id });
      if (previous) { if (previous.fingerprint !== fingerprint) fail('请求标识已用于其他排课', 409); return { saved: true, id, count: previous.lessons.length }; }
      await this.conflict(domainId, lessons);
      const token = hash({ fingerprint, classVersion: ctx.meta?.version ?? 0 });
      if (b.preview === true) return { previewToken: token, count: lessons.length, lessons: lessons.map(({ date, start, end, location }) => ({ date, start, end, location })) };
      if (b.previewToken !== token) fail('排课预览已失效，请重新预览', 409);
      await verify();
      await this.students.mutation(actor, 'schedules.create', id, ['courseId', 'from', 'to', 'weekdays', 'start', 'end'], () => this.schedules.insertOne({ _id: id, domainId, courseId, ...r, weekdays, start, end, lessons, version: 1, fingerprint, updatedAt: new Date(), updatedBy: actor }));
      return { saved: true, id, count: lessons.length };
    });
  }
  async updateLesson(actor: number, domainId: string, scheduleId: string, lessonId: string, input: unknown) {
    const b = object(input); this.org.fields(b, ['version', 'action', 'date', 'start', 'end', 'teacherUid', 'location', 'content', 'attendance']);
    return this.org.locked('__sms_teaching__', async verify => {
      const ctx = await this.context(actor, domainId, true); domainId = ctx.domain._id;
      const s = await this.schedules.findOne({ _id: scheduleId, domainId }); const old = s?.lessons.find(l => l.id === lessonId);
      if (!s || !old) return fail('课次不存在', 404);
      if (old.version !== version(b.version)) fail('课次已更新，请重新打开后保存', 409);
      const next: Lesson = structuredClone(old); next.version++;
      if (b.action === 'attendance') {
        if (old.status === 'cancelled') fail('停课课次不能录入考勤');
        next.content = text(b.content ?? '', 10000, '教学内容');
        if (!Array.isArray(b.attendance) || b.attendance.length > 1000) fail('考勤名单无效');
        const members = await this.org.classDetail(actor, domainId); const allowed = new Set([...members.students.map(s => s.hydroUid), ...old.attendance.map(a => a.uid)]);
        const seen = new Set<number>();
        next.attendance = (b.attendance as unknown[]).map(value => { const a = object(value); this.org.fields(a, ['uid', 'status', 'remark']); const uid = positiveInt(a.uid); if (seen.has(uid) || !allowed.has(uid)) fail('考勤包含重复账号或非本班学生'); seen.add(uid); const status = text(a.status, 10, '考勤'); if (!(ATTENDANCE as readonly string[]).includes(status)) fail('考勤状态无效'); return { uid, status, remark: text(a.remark ?? '', 500, '考勤备注') }; });
        if (old.attendance.some(a => a.status && !seen.has(a.uid))) fail('不能遗漏已有考勤，请保留原名单');
        next.status = 'completed';
      } else {
        if (!ctx.me.admin) fail('排课调整仅限插件管理员', 403);
        if (b.action === 'cancel') { if (old.status === 'completed' || old.attendance.some(a => a.status)) fail('已有教学或考勤记录，不能直接停课'); next.status = 'cancelled'; }
        else if (b.action === 'restore') { if (old.status !== 'cancelled') fail('仅可恢复已停课课次'); next.status = 'planned'; await this.teacher(domainId, next.teacherUid); await this.conflict(domainId, [next], s._id, old.id); }
        else if (b.action === 'adjust') {
          if (old.status === 'completed' || old.attendance.some(a => a.status)) fail('已有教学或考勤记录，不能调课');
          next.date = day(b.date); next.start = clock(b.start); next.end = clock(b.end); if (next.start >= next.end) fail('结束时间必须晚于开始时间');
          next.teacherUid = await this.teacher(domainId, b.teacherUid); next.location = text(b.location ?? '', 160, '地点');
          await this.conflict(domainId, [next], s._id, old.id);
        } else fail('课次操作无效');
      }
      const lessons = s.lessons.map(l => l.id === old.id ? next : l), dates = lessons.map(l => l.date).sort();
      await verify();
      await this.students.mutation(actor, `lessons.${b.action}`, `${s._id}/${old.id}`, ['date', 'time', 'content', 'attendance', 'status'], async () => {
        const r = await this.schedules.updateOne({ _id: s._id, version: s.version }, { $set: { lessons, from: dates[0], to: dates.at(-1)!, updatedAt: new Date(), updatedBy: actor }, $inc: { version: 1 } }); if (!r.matchedCount) fail('课表已更新，请刷新', 409);
      });
      return { saved: true, version: next.version };
    });
  }
  async overview(actor: number, id: string, from?: unknown, to?: unknown) {
    const ctx = await this.context(actor, id), domainId = ctx.domain._id;
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), month = today.slice(0, 7);
    const last = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).toISOString().slice(0, 10);
    const period = range(from || `${month}-01`, to || last, 92);
    const detail = await this.org.classDetail(actor, domainId), courses = await this.courses.find({ domainId }).sort({ name: 1 }).toArray();
    const schedules = await this.schedules.find({ domainId, from: { $lte: period.to }, to: { $gte: period.from } }).toArray();
    const lessons = schedules.flatMap(s => s.lessons.filter(l => l.date >= period.from && l.date <= period.to).map(l => ({ ...l, scheduleId: s._id, courseId: s.courseId, courseName: courses.find(c => c._id === s.courseId)?.name || '课程', attendance: l.attendance.filter(a => ctx.staff || a.uid === actor) }))).sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
    const studentUids = detail.students.map(s => s.hydroUid!).filter(Boolean), heads = await this.rating.head();
    const summaries = await this.rating.summaries.find({ generation: heads.generation, uid: { $in: studentUids } }).toArray();
    const at = { $gte: new Date(`${period.from}T00:00:00+08:00`).toISOString(), $lte: new Date(`${period.to}T23:59:59.999+08:00`).toISOString() };
    const changes = await this.rating.changes.find({ generation: heads.generation, uid: { $in: studentUids }, at }).sort({ at: 1, order: 1 }).toArray();
    const baseline = await this.rating.changes.aggregate<{ _id: number; after: number }>([
      { $match: { generation: heads.generation, uid: { $in: studentUids }, at: { $lt: at.$gte } } },
      { $sort: { at: -1, order: -1 } }, { $group: { _id: '$uid', after: { $first: '$after' } } },
    ]).toArray();
    const states = new Map(baseline.map(r => [r._id, r.after]));
    const timeline: { at: string; rating: number }[] = [];
    const average = () => states.size ? Math.round([...states.values()].reduce((a, b) => a + b, 0) / states.size * 100) / 100 : 0;
    if (states.size) timeline.push({ at: at.$gte, rating: average() });
    for (let i = 0; i < changes.length; i++) { const c = changes[i]; states.set(c.uid, c.after); if (changes[i + 1]?.at !== c.at) timeline.push({ at: c.at, rating: average() }); }
    const sources = await this.rating.sources.find({ generation: heads.generation, kind: 'contest', at, $or: [{ domainId }, { domainId: 'system', 'participants.uid': { $in: studentUids } }] }).toArray();
    const trend = sources.map(source => { const deltas = changes.filter(c => c.source === source.key && c.kind === 'contest').map(c => c.delta).sort((a, b) => a - b), n = deltas.length; return { title: source.title, at: source.at, contestId: source.contestId, domainId: source.domainId, count: n, average: n ? Math.round(deltas.reduce((a, b) => a + b, 0) / n * 100) / 100 : 0, median: n ? (deltas[Math.floor((n - 1) / 2)] + deltas[Math.floor(n / 2)]) / 2 : 0, max: n ? deltas.at(-1) : null, min: n ? deltas[0] : null }; });
    // Only list native contests from this class domain; never expose another domain's hidden contests.
    const docs = ctx.staff ? await this.db.collection('document').find({ docType: 30, domainId, rule: { $in: ['oi', 'ioi', 'acm', 'strictioi'] }, beginAt: { $lte: new Date(`${period.to}T23:59:59+08:00`) }, endAt: { $gte: new Date(`${period.from}T00:00:00+08:00`) } }).sort({ beginAt: -1 }).limit(200).project({ docId: 1, title: 1, beginAt: 1, endAt: 1, rule: 1 }).toArray() : [];
    const counts = { recorded: 0, present: 0, late: 0, leave: 0, absent: 0, pending: 0 };
    for (const l of lessons.filter(l => l.status !== 'cancelled')) for (const a of l.attendance) { const key = ({ '到课': 'present', '迟到': 'late', '请假': 'leave', '旷课': 'absent', '': 'pending' } as const)[a.status as typeof ATTENDANCE[number]]; counts[key]++; if (a.status) counts.recorded++; }
    const attendanceStudents = detail.students.map(s => { const rows = lessons.filter(l => l.status !== 'cancelled').flatMap(l => l.attendance.filter(a => a.uid === s.hydroUid)); return { uid: s.hydroUid, name: s.name, present: rows.filter(a => a.status === '到课').length, late: rows.filter(a => a.status === '迟到').length, leave: rows.filter(a => a.status === '请假').length, absent: rows.filter(a => a.status === '旷课').length, recorded: rows.filter(a => a.status).length }; });
    const board = detail.students.map(s => { const summary = summaries.find(r => r.uid === s.hydroUid), history = changes.filter(c => c.uid === s.hydroUid); return { uid: s.hydroUid, name: s.name, ...this.rating.present(summary ?? null), periodDelta: Math.round(history.reduce((n, c) => n + c.delta, 0) * 100) / 100 }; }).sort((a, b) => b.rating - a.rating);
    return { class: detail, period, canPlan: ctx.me.admin, canTeach: ctx.staff, courses: courses.map(({ updatedBy, ...c }) => c), lessons, attendance: { ...counts, rate: counts.recorded ? Math.round((counts.present + counts.late) / counts.recorded * 10000) / 100 : null, students: attendanceStudents }, rating: { rated: summaries.length, average: summaries.length ? Math.round(summaries.reduce((n, s) => n + s.rating, 0) / summaries.length * 100) / 100 : 0, board, trend, timeline }, contests: docs.map(d => ({ id: String(d.docId), title: d.title, beginAt: d.beginAt, endAt: d.endAt, rule: d.rule, settled: sources.some(s => s.contestId === String(d.docId) && s.domainId === domainId), url: `/d/${encodeURIComponent(domainId)}/contest/${String(d.docId)}` })) };
  }
}
