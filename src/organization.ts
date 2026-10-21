import { randomUUID } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import { StudentService } from './service';
import { SmsError } from './types';
import { object, text } from './validation';

export interface DomainGateway {
  create(id: string, owner: number, name: string, bulletin: string): Promise<unknown>;
  edit(id: string, data: { name: string; bulletin: string }): Promise<unknown>;
  join(id: string, uid: number, joined: boolean): Promise<unknown>;
}
interface ClassDoc {
  _id: string; domainId: string; type: string; academicYear: string; schedule: string;
  location: string; status: 'active' | 'archived'; teacherUids: number[]; memberKinds?: Record<string, 'member' | 'teacher' | 'student'>; version: number;
  updatedAt: Date; updatedBy: number; syncState?: 'pending' | 'failed' | 'ready';
}
interface DomainDoc { _id: string; name?: string; bulletin?: string; owner: number }
export class OrganizationService {
  constructor(private db: Db, private students: StudentService, private host: DomainGateway) {}
  get classes() { return this.db.collection<ClassDoc>('sms_classes'); }
  get domains() { return this.db.collection<DomainDoc>('domain'); }
  async init() {
    // Refuse ambiguous legacy relationships rather than silently choosing a class.
    const duplicate = await this.classes.aggregate([{ $group: { _id: '$domainId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 1 }]).next();
    if (duplicate) throw new Error(`班级与子域需要一对一关联，请先核对重复子域：${duplicate._id}`);
    await this.classes.createIndex({ domainId: 1 }, { unique: true });
    await this.classes.createIndex({ teacherUids: 1 });
    await this.ensureMainMembers();
  }
  async ensureMainMembers(uid?: number) {
    if (uid !== undefined && (!Number.isSafeInteger(uid) || uid <= 0)) return;
    if (!await this.domains.findOne({ _id: 'system' }, { projection: { _id: 1 } })) return;
    const missing = this.db.collection('user').aggregate<{ _id: number }>([
      { $match: { _id: uid ?? { $gt: 0 } } },
      { $lookup: { from: 'domain.user', localField: '_id', foreignField: 'uid', pipeline: [{ $match: { domainId: 'system', join: true } }, { $limit: 1 }], as: 'membership' } },
      { $match: { 'membership.0': { $exists: false } } }, { $project: { _id: 1 } },
    ]);
    for await (const user of missing) await this.host.join('system', user._id, true);
  }
  async metadata(id: string) { return this.classes.findOne({ $or: [{ _id: id }, { domainId: id }] }); }
  async domain(id: string) { const row = await this.domains.findOne({ _id: id }); if (!row) throw new SmsError(404, '班级与子域不存在'); return row; }
  async joined(id: string, uid: number) { return !!await this.db.collection('domain.user').findOne({ domainId: id, uid, join: true }); }
  async access(uid: number, domain: DomainDoc, metadata: ClassDoc | null) {
    const me = await this.students.me(uid);
    const joined = uid > 0 && await this.joined(domain._id, uid);
    const teacher = joined && !!metadata?.teacherUids.includes(uid);
    if (!me.admin && !teacher && !(joined && (me.boundStudentId || domain._id === 'system'))) throw new SmsError(404, '班级与子域不存在或无权查看');
    return { me, staff: me.admin || teacher };
  }
  async allowedDomains(uid: number) {
    const me = await this.students.me(uid); if (me.admin) return null;
    const joined: string[] = await this.db.collection('domain.user').distinct('domainId', { uid, join: true });
    if (me.boundStudentId) return joined;
    const taught = await this.classes.distinct('domainId', { teacherUids: uid });
    return joined.filter(id => id === 'system' || taught.includes(id));
  }
  async domainList(uid: number) {
    const ids = await this.allowedDomains(uid);
    return this.domains.find(ids ? { _id: { $in: ids } } : {}).project({ _id: 1, name: 1 }).sort({ _id: 1 }).toArray();
  }
  async ratingScope(uid: number, currentDomain: string, value: unknown) {
    const selected = text(value ?? '', 64, '班级');
    const classes = uid > 0 ? await this.domainList(uid) : await this.domains.find({ _id: currentDomain }).project({ _id: 1, name: 1 }).toArray();
    if (selected && !classes.some(c => c._id === selected)) throw new SmsError(403, '无权查看该班级排行榜');
    return { domainId: selected || currentDomain, selected, classes, label: currentDomain === 'system' ? '全部班级' : '当前班级' };
  }
  async classList(uid: number, query: unknown, domainValue: unknown, statusValue: unknown, pageValue: unknown) {
    const q = text(query ?? '', 80, '搜索词'); const domainId = text(domainValue ?? '', 64, '子域');
    const status = text(statusValue ?? '', 10, '状态'); const page = this.page(pageValue);
    if (status && !['active', 'archived'].includes(status)) throw new SmsError(400, '状态无效');
    const allowed = await this.allowedDomains(uid); const me = await this.students.me(uid);
    const conditions: Record<string, unknown>[] = [];
    if (allowed) conditions.push({ _id: { $in: allowed } });
    if (domainId) conditions.push({ _id: domainId });
    if (q) conditions.push({ $or: [{ name: { $regex: this.pattern(q), $options: 'i' } }, { _id: { $regex: this.pattern(q), $options: 'i' } }] });
    const [result] = await this.domains.aggregate([
      { $match: conditions.length ? { $and: conditions } : {} },
      { $lookup: { from: 'sms_classes', localField: '_id', foreignField: 'domainId', as: 'metadata' } },
      { $set: { status: { $ifNull: [{ $first: '$metadata.status' }, 'active'] } } },
      ...status ? [{ $match: { status } }] : [],
      { $facet: { count: [{ $count: 'total' }], rows: [{ $sort: { _id: 1 } }, { $skip: (page - 1) * 20 }, { $limit: 20 }, { $project: { _id: 1, name: 1, status: 1, metadata: 1 } }] } },
    ]).toArray();
    const classes = await Promise.all((result?.rows ?? []).map(async (row: Document) => {
      const meta = row.metadata[0] as ClassDoc | undefined;
      const staff = me.admin || (!!meta?.teacherUids.includes(uid) && await this.joined(row._id, uid));
      return { _id: row._id, domainId: row._id, name: row.name || row._id, type: meta?.type || '', academicYear: meta?.academicYear || '', status: row.status, version: meta?.version ?? 0, ...(staff ? { memberCount: await this.db.collection('domain.user').countDocuments({ domainId: row._id, uid: { $gt: 0 }, join: true }) } : {}) };
    }));
    return { total: result?.count[0]?.total ?? 0, page, classes };
  }
  async classDetail(uid: number, id: string) {
    const metadata = await this.metadata(id); const domain = await this.domain(metadata?.domainId || id);
    const { me, staff } = await this.access(uid, domain, metadata);
    const memberships = await this.db.collection('domain.user').find({ domainId: domain._id, uid: { $gt: 0 }, join: true }).project({ uid: 1 }).toArray();
    const uids = memberships.map(m => m.uid as number);
    const teacherUids = (metadata?.teacherUids ?? []).filter(n => uids.includes(n));
    const students = await this.students.students.find({ hydroUid: { $in: staff ? uids : [uid] } }).project({ 'basic.name': 1, 'basic.grade': 1, 'basic.school': 1, hydroUid: 1 }).toArray();
    const teachers = await this.db.collection<{ _id: number; uname: string }>('user').find({ _id: { $in: teacherUids } }).project({ uname: 1 }).toArray();
    const teacherProfiles = await this.db.collection('sms_teachers').find({ hydroUid: { $in: teacherUids } }, { projection: { hydroUid: 1, 'basic.name': 1 } }).toArray();
    return {
      _id: domain._id, domainId: domain._id, name: domain.name || domain._id, description: domain.bulletin || '',
      type: metadata?.type || '', academicYear: metadata?.academicYear || '', schedule: metadata?.schedule || '', location: metadata?.location || '', status: metadata?.status || 'active',
      version: metadata?.version ?? 0, syncState: metadata?.syncState || 'ready', canEdit: me.admin,
      ...(me.admin ? { owner: domain.owner } : {}), ...(staff ? { memberCount: uids.length } : {}),
      students: students.map(s => ({ id: s._id, name: s.basic.name, grade: s.basic.grade, school: s.basic.school, hydroUid: s.hydroUid })),
      teachers: teachers.map(t => ({ uid: t._id, username: t.uname, name: teacherProfiles.find(p => p.hydroUid === t._id)?.basic?.name || t.uname })),
    };
  }
  // A lease serializes plugin operations across workers. An interrupted process
  // releases its lock after two minutes; every host write verifies ownership.
  async locked<T>(id: string, work: (verify: () => Promise<void>) => Promise<T>) {
    const locks = this.db.collection<{ _id: string; token: string; expiresAt: Date }>('sms_org_locks'); const token = randomUUID();
    const expires = () => new Date(Date.now() + 120000);
    try { await locks.findOneAndUpdate({ _id: id, expiresAt: { $lte: new Date() } }, { $set: { token, expiresAt: expires() } }, { upsert: true }); }
    catch (e) { if ((e as { code?: number }).code === 11000) throw new SmsError(409, '班级与子域正在更新，请稍后重试'); throw e; }
    const verify = async () => { const r = await locks.updateOne({ _id: id, token, expiresAt: { $gt: new Date() } }, { $set: { expiresAt: expires() } }); if (!r.matchedCount) throw new SmsError(409, '更新锁已失效，请刷新后重试'); };
    try { return await work(verify); } finally { await locks.deleteOne({ _id: id, token }); }
  }
  async classSave(uid: number, id: string | null, value: unknown) {
    await this.students.requireAdmin(uid); const input = object(value);
    this.fields(input, ['domainId', 'name', 'description', 'type', 'academicYear', 'schedule', 'location', 'status', 'version', 'createDomain']);
    const domainId = text(input.domainId, 64, '子域 ID').toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(domainId)) throw new SmsError(400, '子域 ID 仅允许英文、数字、下划线及短横线');
    const name = text(input.name, 100, '名称'); const description = text(input.description ?? '', 5000, '说明');
    const data = { type: text(input.type ?? '', 80, '班型'), academicYear: text(input.academicYear ?? '', 80, '学年'), schedule: text(input.schedule ?? '', 200, '上课安排'), location: text(input.location ?? '', 200, '地点'), status: input.status as ClassDoc['status'] };
    if (!name || !['active', 'archived'].includes(data.status)) throw new SmsError(400, '请填写名称并选择有效状态');
    if (input.createDomain !== undefined && typeof input.createDomain !== 'boolean') throw new SmsError(400, '创建标识无效');
    const version = input.version ?? 0; if (!Number.isSafeInteger(version) || (version as number) < 0) throw new SmsError(400, '版本无效');
    return this.locked(domainId, async verify => {
      const previous = await this.metadata(id || domainId);
      if (previous && previous.domainId !== domainId) throw new SmsError(400, '不能修改已关联的子域 ID');
      if (id && !previous && id !== domainId) throw new SmsError(404, '班级与子域不存在');
      const domain = await this.domains.findOne({ _id: domainId });
      const recoverCreation = !domain && input.createDomain && version === 0 && previous?.syncState !== 'ready';
      if ((previous?.version ?? 0) !== version && !recoverCreation) throw new SmsError(409, '资料已更新，请重新打开后修改');
      if (input.createDomain && domain) throw new SmsError(409, '子域 ID 已存在，请直接编辑已有班级与子域');
      if (!domain && !input.createDomain) throw new SmsError(404, '子域不存在');
      return this.students.mutation(uid, input.createDomain ? 'classes.create' : 'classes.update', domainId, ['name', 'description', ...Object.keys(data)], async () => {
        const key = previous?._id || domainId;
        await this.classes.updateOne({ _id: key }, { $set: { domainId, ...data, updatedAt: new Date(), updatedBy: uid, syncState: 'pending' }, $setOnInsert: { teacherUids: [] }, $inc: { version: 1 } }, { upsert: true });
        try {
          await verify();
          if (domain) await this.host.edit(domainId, { name, bulletin: description }); else await this.host.create(domainId, uid, name, description);
          await this.classes.updateOne({ _id: key }, { $set: { syncState: 'ready' } });
        } catch (e) { await this.classes.updateOne({ _id: key }, { $set: { syncState: 'failed' } }); throw e; }
        return this.classDetail(uid, domainId);
      });
    });
  }
  async domainSave(uid: number, value: unknown) {
    await this.students.requireAdmin(uid); const input = object(value); this.fields(input, ['action', 'id', 'name', 'bulletin', 'version']);
    if (!['create', 'update'].includes(String(input.action))) throw new SmsError(400, '操作无效');
    const id = text(input.id, 64, '子域 ID').toLowerCase(); const meta = await this.metadata(id);
    // Compatibility endpoint uses the same save path; updates require a revision.
    if (input.action === 'update' && input.version === undefined) throw new SmsError(400, '更新需要版本号');
    return this.classSave(uid, input.action === 'create' ? null : id, { domainId: id, name: input.name, description: input.bulletin, type: meta?.type || '', academicYear: meta?.academicYear || '', schedule: meta?.schedule || '', location: meta?.location || '', status: meta?.status || 'active', version: input.version ?? 0, createDomain: input.action === 'create' });
  }
  async domainMembers(uid: number, id: string, query: unknown, pageValue: unknown) {
    const meta = await this.metadata(id); const domain = await this.domain(meta?.domainId || id); const { me, staff } = await this.access(uid, domain, meta);
    if (domain._id === 'system') await this.ensureMainMembers();
    const q = text(query ?? '', 80, '搜索词'); const page = this.page(pageValue);
    const teachers = meta?.teacherUids ?? [];
    const [result] = await this.db.collection('domain.user').aggregate([
      { $match: { domainId: domain._id, join: true, uid: staff ? { $gt: 0 } : uid } },
      { $lookup: { from: 'user', localField: 'uid', foreignField: '_id', as: 'user' } }, { $unwind: '$user' },
      { $lookup: { from: 'sms_students', localField: 'uid', foreignField: 'hydroUid', pipeline: [{ $project: { 'basic.name': 1 } }], as: 'student' } },
      ...q ? [{ $match: { $or: [{ 'user.uname': { $regex: this.pattern(q), $options: 'i' } }, { 'student.basic.name': { $regex: this.pattern(q), $options: 'i' } }, .../^\d+$/.test(q) ? [{ uid: Number(q) }] : []] } }] : [],
      { $facet: { count: [{ $count: 'total' }], members: [{ $sort: { uid: 1 } }, { $skip: (page - 1) * 20 }, { $limit: 20 }, { $project: { _id: 0, uid: 1, username: '$user.uname', studentName: { $first: '$student.basic.name' }, kind: { $cond: [{ $in: ['$uid', teachers] }, 'teacher', { $cond: [{ $gt: [{ $size: '$student' }, 0] }, 'student', 'member'] }] }, canRemove: { $and: [me.admin, { $ne: ['$uid', domain.owner] }, domain._id !== 'system'] } } }] } },
    ]).toArray();
    return { total: result?.count[0]?.total ?? 0, members: (result?.members ?? []).map((member: Document) => ({ ...member, kind: meta?.memberKinds?.[String(member.uid)] ?? member.kind })), page, pageSize: 20, version: meta?.version ?? 0, canManage: me.admin };
  }
  async domainMembership(uid: number, id: string, value: unknown) {
    await this.students.requireAdmin(uid); const input = object(value); this.fields(input, ['uid', 'joined', 'kind', 'version', 'roleOnly']);
    const target = await this.students.assertUser(input.uid); if (!target || typeof input.joined !== 'boolean') throw new SmsError(400, '请指定有效账号与加入状态');
    const kind = input.kind ?? 'member'; if (!['member', 'teacher', 'student'].includes(String(kind))) throw new SmsError(400, '成员身份无效');
    if (input.roleOnly !== undefined && typeof input.roleOnly !== 'boolean') throw new SmsError(400, '身份修改标识无效');
    if (!Number.isSafeInteger(input.version) || (input.version as number) < 0) throw new SmsError(400, '成员修改需要有效版本号');
    if (input.roleOnly && input.kind === undefined) throw new SmsError(400, '请选择要修改的成员身份');
    const initial = await this.metadata(id); const domainId = initial?.domainId || id;
    if (domainId !== 'system' && kind === 'student' && !await this.students.students.findOne({ hydroUid: target })) throw new SmsError(400, '该账号尚未绑定学生档案，请先创建或绑定学生');
    return this.locked(domainId, async verify => {
      const domain = await this.domain(domainId); const meta = await this.metadata(domainId);
      if ((meta?.version ?? 0) !== input.version) throw new SmsError(409, '成员或资料已更新，请刷新名册后重试');
      if (domainId === 'system' && !input.joined) throw new SmsError(400, '主域所有账号默认加入，不能移除成员');
      if (input.roleOnly && (!input.joined || !await this.joined(domainId, target))) throw new SmsError(400, '只能修改已有成员的身份');
      if (!input.joined && target === domain.owner) throw new SmsError(400, '不能移除班级与子域的所有者');
      return this.students.mutation(uid, input.roleOnly ? 'domains.role' : input.joined ? 'domains.join' : 'domains.leave', `${domainId}/${target}`, ['uid', 'joined', 'kind'], async () => {
        const key = meta?._id || domainId;
        await this.classes.updateOne({ _id: key }, { $set: { domainId, updatedAt: new Date(), updatedBy: uid, syncState: 'pending' }, $setOnInsert: { type: '', academicYear: '', schedule: '', location: '', status: 'active', teacherUids: [] }, $inc: { version: 1 } }, { upsert: true });
        try {
          await verify(); if (!input.roleOnly) await this.host.join(domainId, target, input.joined as boolean);
          const teacherUids = new Set(meta?.teacherUids ?? []); if (input.joined && kind === 'teacher') teacherUids.add(target); else teacherUids.delete(target);
          const memberKinds = { ...meta?.memberKinds }; if (input.joined) memberKinds[String(target)] = kind as 'member' | 'teacher' | 'student'; else delete memberKinds[String(target)];
          await this.classes.updateOne({ _id: key }, { $set: { teacherUids: [...teacherUids], memberKinds, syncState: 'ready' } });
        } catch (e) { await this.classes.updateOne({ _id: key }, { $set: { syncState: 'failed' } }); throw e; }
        return { uid: target, joined: input.joined, version: (meta?.version ?? 0) + 1 };
      });
    });
  }
  page(value: unknown) { const page = Number(value ?? 1); if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new SmsError(400, '页码无效'); return page; }
  pattern(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  fields(input: Record<string, unknown>, keys: string[]) { if (Object.keys(input).some(k => !keys.includes(k))) throw new SmsError(400, '请求包含未知字段'); }
}
