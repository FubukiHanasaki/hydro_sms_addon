/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { Db } from 'mongodb';
import { OrganizationService } from './organization';
import { StudentService } from './service';
import { RatingService } from './rating';
import { TeachingPlanner, ATTENDANCE, period as range } from './teaching-planner';
export { ATTENDANCE } from './teaching-planner';
export class TeachingService extends TeachingPlanner {
  constructor(private store: Db, private studentService: StudentService, private organization: OrganizationService, private rating: RatingService) { super(store, studentService, organization); }
  async overview(actor: number, id: string, from?: unknown, to?: unknown) {
    const ctx = await this.context(actor, id), domainId = ctx.domain._id;
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), month = today.slice(0, 7);
    const last = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).toISOString().slice(0, 10);
    const period = range(from || `${month}-01`, to || last, 92);
    const detail = await this.organization.classDetail(actor, domainId);
    const plans = await this.plans.find({ domainId }).toArray();
    const rawCourses = await this.records.find({ domainId, date: { $gte: period.from, $lte: period.to } }).sort({ date: -1, start: -1 }).toArray();
    const courses = rawCourses.map(({ updatedBy, requestHash, ...c }) => ({ ...c, attendance: c.attendance.filter(a => ctx.staff || a.uid === actor) }));
    const lessons = await this.instances(domainId, period.from, period.to);
    const linkedIds = lessons.map(l => l.courseId).filter((id): id is string => !!id && !courses.some(c => c._id === id));
    const linkedCourses = (await this.records.find({ domainId, _id: { $in: linkedIds } }).toArray()).map(({ updatedBy, requestHash, ...c }) => ({ ...c, attendance: c.attendance.filter(a => ctx.staff || a.uid === actor) }));
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
    const docs = ctx.staff ? await this.store.collection('document').find({ docType: 30, domainId, rule: { $in: ['oi', 'ioi', 'acm', 'strictioi'] }, beginAt: { $lte: new Date(`${period.to}T23:59:59+08:00`) }, endAt: { $gte: new Date(`${period.from}T00:00:00+08:00`) } }).sort({ beginAt: -1 }).limit(200).project({ docId: 1, title: 1, beginAt: 1, endAt: 1, rule: 1 }).toArray() : [];
    const counts = { recorded: 0, present: 0, late: 0, leave: 0, absent: 0, pending: 0 };
    for (const c of courses) for (const a of c.attendance) { const key = ({ '到课': 'present', '迟到': 'late', '请假': 'leave', '旷课': 'absent', '': 'pending' } as const)[a.status as typeof ATTENDANCE[number]]; if (key) counts[key]++; if (a.status) counts.recorded++; }
    const attendanceStudents = detail.students.map(s => { const rows = courses.flatMap(c => c.attendance.filter(a => a.uid === s.hydroUid)); return { uid: s.hydroUid, name: s.name, present: rows.filter(a => a.status === '到课').length, late: rows.filter(a => a.status === '迟到').length, leave: rows.filter(a => a.status === '请假').length, absent: rows.filter(a => a.status === '旷课').length, recorded: rows.filter(a => a.status).length }; });
    const board = detail.students.map(s => { const summary = summaries.find(r => r.uid === s.hydroUid), history = changes.filter(c => c.uid === s.hydroUid); return { uid: s.hydroUid, name: s.name, ...this.rating.present(summary ?? null), periodDelta: Math.round(history.reduce((n, c) => n + c.delta, 0) * 100) / 100 }; }).sort((a, b) => b.rating - a.rating);
    return { class: detail, period, canPlan: ctx.me.admin, canTeach: ctx.staff, courses, linkedCourses, plans: plans.map(p => ({ id: p._id, version: p.version, ...p.revisions.at(-1)! })), lessons, attendance: { ...counts, rate: counts.recorded ? Math.round((counts.present + counts.late) / counts.recorded * 10000) / 100 : null, students: attendanceStudents }, rating: { rated: summaries.length, average: summaries.length ? Math.round(summaries.reduce((n, s) => n + s.rating, 0) / summaries.length * 100) / 100 : 0, board, trend, timeline }, contests: docs.map(d => ({ id: String(d.docId), title: d.title, beginAt: d.beginAt, endAt: d.endAt, rule: d.rule, settled: sources.some(s => s.contestId === String(d.docId) && s.domainId === domainId), url: `/d/${encodeURIComponent(domainId)}/contest/${String(d.docId)}` })) };
  }
}
