import { randomUUID } from 'node:crypto';
import type { Db, Filter } from 'mongodb';
import { StudentService } from './service';
import { SmsError, Student } from './types';
import { object, positiveInt, text } from './validation';

export interface DomainGateway {
  create(id: string, owner: number, name: string, bulletin: string): Promise<unknown>;
  edit(id: string, data: { name: string; bulletin: string }): Promise<unknown>;
  join(id: string, uid: number, joined: boolean): Promise<unknown>;
}
interface ClassDoc {
  _id: string; domainId: string; name: string; type: string; academicYear: string;
  schedule: string; location: string; description: string; status: 'active' | 'archived';
  teacherUids: number[]; studentIds: string[]; version: number;
  createdAt: Date; updatedAt: Date; updatedBy: number;
}
interface DomainDoc { _id: string; name?: string; bulletin?: string; owner: number }
export class OrganizationService {
  constructor(private db: Db, private students: StudentService, private host: DomainGateway) {}
  get classes() { return this.db.collection<ClassDoc>('sms_classes'); }
  get domains() { return this.db.collection<DomainDoc>('domain'); }
  async init() { await this.classes.createIndex({ domainId: 1, updatedAt: -1 }); await this.classes.createIndex({ teacherUids: 1 }); await this.classes.createIndex({ studentIds: 1 }); }
  async scope(uid: number) {
    const me = await this.students.me(uid);
    return { me, filter: me.admin ? {} : { $or: [{ teacherUids: uid }, { studentIds: me.boundStudentId ?? '' }] } };
  }
  async domainList(uid: number) {
    const { me, filter } = await this.scope(uid);
    const ids = me.admin ? null : [...new Set([
      ...await this.classes.distinct('domainId', filter),
      ...await this.db.collection('domain.user').distinct('domainId', { uid, join: true }),
    ])];
    return this.domains.find(ids ? { _id: { $in: ids } } : {}).project({ _id: 1, name: 1, ...(me.admin ? { bulletin: 1, owner: 1 } : {}) }).sort({ _id: 1 }).toArray();
  }
  async domainSave(uid: number, value: unknown) {
    await this.students.requireAdmin(uid);
    const input = object(value); this.fields(input, ['action', 'id', 'name', 'bulletin']);
    const id = text(input.id, 64, '子域 ID').toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new SmsError(400, '子域 ID 仅允许英文、数字、下划线及短横线');
    if (!['create', 'update'].includes(String(input.action))) throw new SmsError(400, '子域操作无效');
    const name = text(input.name, 100, '子域名称'); const bulletin = text(input.bulletin ?? '', 5000, '子域公告');
    if (!name) throw new SmsError(400, '子域名称不能为空');
    const exists = await this.domains.findOne({ _id: id });
    if (input.action === 'create' && exists) throw new SmsError(409, '子域 ID 已存在');
    if (input.action === 'update' && !exists) throw new SmsError(404, '子域不存在');
    return this.students.mutation(uid, `domains.${input.action}`, id, ['name', 'bulletin'], async () => {
      try { if (input.action === 'create') await this.host.create(id, uid, name, bulletin); else await this.host.edit(id, { name, bulletin }); }
      catch (e) { if ((e as { code?: number }).code === 11000) throw new SmsError(409, '子域 ID 已存在'); throw e; }
      return { id };
    });
  }
  async domainMembers(uid: number, id: string, query: unknown, pageValue: unknown) {
    await this.students.requireAdmin(uid); await this.domain(id);
    const q = text(query ?? '', 80, '搜索词'); const page = Number(pageValue ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new SmsError(400, '页码无效');
    const match = q ? { $or: [{ 'user.uname': { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, .../^\d+$/.test(q) ? [{ uid: Number(q) }] : []] } : {};
    const [result] = await this.db.collection('domain.user').aggregate([
      { $match: { domainId: id, join: true } },
      { $lookup: { from: 'user', localField: 'uid', foreignField: '_id', as: 'user' } }, { $unwind: '$user' }, { $match: match },
      { $facet: { count: [{ $count: 'total' }], members: [{ $sort: { uid: 1 } }, { $skip: (page - 1) * 20 }, { $limit: 20 }, { $project: { _id: 0, uid: 1, role: 1, username: '$user.uname' } }] } },
    ]).toArray();
    return { total: result?.count[0]?.total ?? 0, members: result?.members ?? [], page };
  }
  async domainMembership(uid: number, id: string, value: unknown) {
    await this.students.requireAdmin(uid); const domain = await this.domain(id);
    const input = object(value); this.fields(input, ['uid', 'joined']);
    const target = await this.students.assertUser(input.uid);
    if (!target || typeof input.joined !== 'boolean') throw new SmsError(400, '请指定有效账号与加入状态');
    if (!input.joined && target === domain.owner) throw new SmsError(400, '不能移除子域所有者');
    return this.students.mutation(uid, input.joined ? 'domains.join' : 'domains.leave', id, ['uid', 'joined'], async () => {
      await this.host.join(id, target, input.joined as boolean); return { uid: target, joined: input.joined };
    });
  }
  async domain(id: string) { const row = await this.domains.findOne({ _id: id }); if (!row) throw new SmsError(404, '子域不存在'); return row; }
  async classList(uid: number, query: unknown, domainValue: unknown, statusValue: unknown, pageValue: unknown) {
    const { me, filter } = await this.scope(uid);
    const q = text(query ?? '', 80, '搜索词'); const domainId = text(domainValue ?? '', 64, '子域');
    const status = text(statusValue ?? '', 10, '班级状态'); const page = Number(pageValue ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new SmsError(400, '页码无效');
    if (status && !['active', 'archived'].includes(status)) throw new SmsError(400, '班级状态无效');
    const where: Filter<ClassDoc> = { $and: [filter, ...(domainId ? [{ domainId }] : []), ...(status ? [{ status: status as ClassDoc['status'] }] : []), ...(q ? [{ name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }] : [])] };
    const [total, rows] = await Promise.all([this.classes.countDocuments(where), this.classes.find(where).sort({ updatedAt: -1, _id: 1 }).skip((page - 1) * 20).limit(20).toArray()]);
    return { total, page, classes: rows.map((r) => this.classView(r, me.admin || r.teacherUids.includes(uid))) };
  }
  classView(row: ClassDoc, staff: boolean) {
    const { studentIds, teacherUids, ...rest } = row;
    return { ...rest, teacherUids, ...(staff ? { studentIds, studentCount: studentIds.length } : {}) };
  }
  async classDetail(uid: number, id: string) {
    const { me, filter } = await this.scope(uid);
    const row = await this.classes.findOne({ $and: [{ _id: id }, filter] });
    if (!row) throw new SmsError(404, '班级不存在或无权查看');
    const staff = me.admin || row.teacherUids.includes(uid);
    const members = await this.db.collection<Student>('sms_students').find({ _id: { $in: staff ? row.studentIds : [me.boundStudentId ?? ''] } }).project({ 'basic.name': 1, 'basic.grade': 1, 'basic.school': 1, hydroUid: 1 }).toArray();
    const teachers = await this.db.collection<{ _id: number; uname: string }>('user').find({ _id: { $in: row.teacherUids } }).project({ uname: 1 }).toArray();
    return { ...this.classView(row, staff), canEdit: me.admin, students: members.map(s => ({ id: s._id, name: s.basic.name, grade: s.basic.grade, school: s.basic.school, hydroUid: s.hydroUid ?? null })), teachers: teachers.map(t => ({ uid: t._id, username: t.uname })) };
  }
  async classSave(uid: number, id: string | null, value: unknown) {
    await this.students.requireAdmin(uid); const input = object(value);
    this.fields(input, ['domainId', 'name', 'type', 'academicYear', 'schedule', 'location', 'description', 'status', 'teacherUids', 'studentIds', 'version']);
    const data = { domainId: text(input.domainId, 64, '子域'), name: text(input.name, 100, '班级名称'), type: text(input.type ?? '', 80, '班型'), academicYear: text(input.academicYear ?? '', 80, '学年'), schedule: text(input.schedule ?? '', 200, '上课安排'), location: text(input.location ?? '', 200, '上课地点'), description: text(input.description ?? '', 2000, '班级说明'), status: input.status as ClassDoc['status'], teacherUids: this.ids(input.teacherUids, true) as number[], studentIds: this.ids(input.studentIds, false) as string[] };
    if (!data.name || !['active', 'archived'].includes(data.status)) throw new SmsError(400, '请填写班级名称并选择有效状态');
    await this.domain(data.domainId);
    if (await this.students.students.countDocuments({ _id: { $in: data.studentIds } }) !== data.studentIds.length) throw new SmsError(400, '部分学生档案不存在');
    if (await this.db.collection('user').countDocuments({ _id: { $in: data.teacherUids } as never }) !== data.teacherUids.length) throw new SmsError(400, '部分教师账号不存在');
    const now = new Date(); const key = id ?? randomUUID();
    return this.students.mutation(uid, id ? 'classes.update' : 'classes.create', key, Object.keys(data), async () => {
      if (!id) await this.classes.insertOne({ _id: key, ...data, version: 1, createdAt: now, updatedAt: now, updatedBy: uid });
      else {
        const version = positiveInt(input.version, '版本');
        const result = await this.classes.updateOne({ _id: id, version }, { $set: { ...data, updatedAt: now, updatedBy: uid }, $inc: { version: 1 } });
        if (!result.matchedCount) throw new SmsError(409, '班级已变更或不存在，请重新打开后修改');
      }
      return this.classDetail(uid, key);
    });
  }
  ids(value: unknown, numeric: boolean) {
    if (!Array.isArray(value) || value.length > 1000) throw new SmsError(400, '成员列表无效或超过 1000 人');
    return [...new Set(value.map(v => numeric ? positiveInt(v, '教师 UID') : text(v, 64, '学生 ID')))];
  }
  fields(input: Record<string, unknown>, keys: string[]) { if (Object.keys(input).some(k => !keys.includes(k))) throw new SmsError(400, '请求包含未知字段'); }
}
