import { studentLock, requireNoStudentBatch } from './student-lock';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { activeGrant, allows, canRead, isAdmin, readFilter, visibleStudent } from './access';
import { Policy, SmsError, Student, basicView } from './types';
import { object, positiveInt, text, validateBasic, validateGrant, validateSensitive } from './validation';
import type { AccountGateway, CreatedAccount } from './accounts';

export class StudentService {
  constructor(private db: Db, private accounts?: AccountGateway) {}
  get students() { return this.db.collection<Student>('sms_students'); }
  get policies() { return this.db.collection<Policy>('sms_policy'); }
  async init() {
    await this.students.createIndex({ hydroUid: 1 }, { unique: true, partialFilterExpression: { hydroUid: { $type: 'number' } } });
    await this.students.createIndex({ updatedAt: -1, _id: 1 });
    await this.db.collection('sms_audit').createIndex({ at: -1 });
  }
  async policy(): Promise<Policy> {
    return await this.policies.findOne({ _id: 'global' }) ?? { _id: 'global', admins: [], grants: [], revision: 0 };
  }
  async requireAdmin(uid: number) {
    const policy = await this.policy();
    if (!isAdmin(policy, uid)) throw new SmsError(403, '需要插件管理员授权');
    return policy;
  }
  async audit(uid: number, action: string, target: string, fields: string[] = []) {
    return this.db.collection('sms_audit').insertOne({ uid, action, target, fields, at: new Date() });
  }
  async mutation<T>(uid: number, action: string, target: string, fields: string[], work: () => Promise<T>) {
    // Write the intent first. An interrupted operation remains visible for reconciliation.
    const audit = this.db.collection('sms_audit');
    const { insertedId } = await audit.insertOne({ uid, action, target, fields, at: new Date(), outcome: 'pending' });
    let applied = false;
    try {
      const result = await work();
      applied = true;
      await audit.updateOne({ _id: insertedId }, { $set: { outcome: 'success', finishedAt: new Date() } });
      return result;
    } catch (error) {
      // A failed audit finalization must remain pending rather than falsely
      // reporting that an already committed mutation failed.
      if (!applied) await audit.updateOne({ _id: insertedId }, { $set: { outcome: 'failed', finishedAt: new Date() } });
      if ((error as { code?: number }).code === 11000) throw new SmsError(409, 'Hydro UID 已被其他档案使用');
      throw error;
    }
  }
  async me(uid: number) {
    const policy = await this.policy();
    return {
      uid, admin: isAdmin(policy, uid), initialized: policy.admins.length > 0,
      grants: activeGrant(policy, uid),
      boundStudentId: (await this.students.findOne({ hydroUid: uid }, { projection: { _id: 1 } }))?._id ?? null,
    };
  }
  async filterOptions(uid: number) {
    const policy = await this.policy();
    const [options] = await this.students.aggregate<{
      grades: { _id: string }[]; schools: { _id: string }[]; domains: { id: string; name?: string }[];
    }>([
      { $match: readFilter(policy, uid) },
      { $project: { 'basic.grade': 1, 'basic.school': 1, hydroUid: 1 } },
      { $facet: {
        grades: [{ $group: { _id: '$basic.grade' } }, { $match: { _id: { $type: 'string', $ne: '' } } }],
        schools: [{ $group: { _id: '$basic.school' } }, { $match: { _id: { $type: 'string', $ne: '' } } }],
        domains: [
          { $match: { hydroUid: { $type: 'number' } } },
          { $lookup: { from: 'domain.user', localField: 'hydroUid', foreignField: 'uid', as: 'membership' } },
          { $unwind: '$membership' },
          { $match: { 'membership.join': true } },
          { $group: { _id: '$membership.domainId' } },
          { $lookup: { from: 'domain', localField: '_id', foreignField: '_id', as: 'domain' } },
          { $unwind: '$domain' },
          { $project: { _id: 0, id: '$domain._id', name: '$domain.name' } },
        ],
      } },
    ]).toArray();
    const compare = new Intl.Collator('zh-CN', { numeric: true }).compare;
    const gradeOrder = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '高一', '高二', '高三', '已毕业'];
    const rank = (grade: string) => gradeOrder.includes(grade) ? gradeOrder.indexOf(grade) : gradeOrder.length;
    return {
      grades: (options?.grades ?? []).map((g) => g._id).sort((a, b) => rank(a) - rank(b) || compare(a, b)),
      schools: (options?.schools ?? []).map((s) => s._id).sort(compare),
      domains: (options?.domains ?? []).map((d) => ({ id: d.id, name: d.name || d.id })).sort((a, b) => compare(a.name, b.name)),
    };
  }
  async list(uid: number, query: unknown, pageValue: unknown, statusValue: unknown, extra: { grade?: unknown; school?: unknown; domainId?: unknown } = {}) {
    const policy = await this.policy();
    const page = Number(pageValue ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new SmsError(400, '页码无效');
    const q = text(query ?? '', 80, '搜索词');
    const status = text(statusValue ?? '', 10, '状态');
    const grade = text(extra.grade ?? '', 160, '年级');
    const school = text(extra.school ?? '', 160, '学校');
    const domainId = text(extra.domainId ?? '', 160, '子域');
    if (status && !['在校', '休学', '离校'].includes(status)) throw new SmsError(400, '状态无效');
    const and: Record<string, unknown>[] = [readFilter(policy, uid)];
    if (q) {
      const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      and.push({ 'basic.name': { $regex: pattern, $options: 'i' } });
    }
    if (status) and.push({ 'basic.status': status });
    if (grade) and.push({ 'basic.grade': grade });
    if (school) and.push({ 'basic.school': school });
    if (domainId && !await this.db.collection<{ _id: string }>('domain').findOne({ _id: domainId }, { projection: { _id: 1 } })) {
      return { total: 0, page, pageSize: 20, students: [] };
    }
    const [result] = await this.students.aggregate<{ count: { total: number }[]; students: Student[] }>([
      { $match: { $and: and } },
      ...domainId ? [
        { $match: { hydroUid: { $type: 'number', $gt: 0 } } },
        { $lookup: {
          from: 'domain.user', let: { uid: '$hydroUid' }, as: 'smsMembership',
          pipeline: [{ $match: { domainId, join: true, $expr: { $eq: ['$uid', '$$uid'] } } }, { $limit: 1 }],
        } },
        { $match: { 'smsMembership.0': { $exists: true } } },
      ] : [],
      { $facet: {
        count: [{ $count: 'total' }],
        students: [
          { $sort: { updatedAt: -1, _id: 1 } }, { $skip: (page - 1) * 20 }, { $limit: 20 },
          { $project: { basic: 1, hydroUid: 1, version: 1, updatedAt: 1 } },
        ],
      } },
    ]).toArray();
    const total = result?.count[0]?.total ?? 0;
    const rows = result?.students ?? [];
    // Lists never contain contact details or internal notes, including for administrators.
    return { total, page, pageSize: 20, students: rows.map((s) => ({ id: s._id, ...basicView(s.basic), hydroUid: s.hydroUid ?? null, version: s.version })) };
  }
  async detail(uid: number, id: string) {
    const policy = await this.policy();
    const student = await this.students.findOne({ _id: id });
    if (!student || !canRead(policy, uid, student)) throw new SmsError(404, '学生档案不存在或无权查看');
    const view = visibleStudent(policy, uid, student)!;
    if (view.sensitive) await this.audit(uid, 'students.sensitive.read', id);
    return view;
  }
  async byHydroUid(uid: number, targetUid: number) {
    const student = await this.students.findOne({ hydroUid: targetUid });
    if (!student) return null;
    const view = visibleStudent(await this.policy(), uid, student);
    if (view?.sensitive) await this.audit(uid, 'students.sensitive.profile', student._id);
    return view;
  }
  async assertUser(uid: unknown) {
    if (uid === null) return undefined;
    const value = positiveInt(uid);
    if (!await this.db.collection('user').findOne({ _id: value as never }, { projection: { _id: 1 } })) throw new SmsError(400, '该 Hydro UID 不存在');
    return value;
  }
  async create(uid: number, value: unknown) {
    return studentLock(this.db, async () => { await requireNoStudentBatch(this.db); return this.createUnlocked(uid, value); });
  }
  private async createUnlocked(uid: number, value: unknown) {
    await this.requireAdmin(uid);
    const input = object(value);
    this.checkFields(input, ['basic', 'sensitive', 'internalNote', 'hydroUid', 'requestId']);
    const now = new Date();
    const student: Student = {
      _id: randomUUID(), basic: validateBasic(input.basic), sensitive: validateSensitive(input.sensitive ?? {}),
      internalNote: text(input.internalNote ?? '', 3000, '内部备注'),
      version: 1, createdAt: now, updatedAt: now, createdBy: uid, updatedBy: uid,
    };
    let generatedAccount: CreatedAccount | undefined;
    if (input.hydroUid !== undefined && input.hydroUid !== null) student.hydroUid = await this.assertUser(input.hydroUid);
    else {
      if (!this.accounts) throw new SmsError(503, '自动建号服务不可用');
      const requestId = text(input.requestId, 36, '请求标识');
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId)) throw new SmsError(400, '新建学生需要有效的请求标识');
      student._id = createHash('sha256').update(`${uid}:${requestId}`).digest('hex').slice(0, 32);
      const fingerprint = createHash('sha256').update(JSON.stringify({ basic: student.basic, sensitive: student.sensitive, internalNote: student.internalNote })).digest('hex');
      const jobs = this.db.collection<{ _id: string; actor: number; fingerprint: string; state: string; hydroUid?: number }>('sms_account_jobs');
      try { await jobs.updateOne({ _id: student._id }, { $setOnInsert: { actor: uid, fingerprint, state: 'pending' } }, { upsert: true }); }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
      const job = await jobs.findOne({ _id: student._id });
      if (job?.fingerprint !== fingerprint) throw new SmsError(409, '此请求已经用于其他资料，请重新打开新建窗口');
      const current = await this.students.findOne({ _id: student._id });
      if (current) {
        await jobs.updateOne({ _id: student._id }, { $set: { state: 'completed' } });
        const user = await this.db.collection<{ _id: number; uname: string }>('user').findOne({ _id: current.hydroUid });
        return { ...await this.detail(uid, current._id), generatedAccount: { uid: current.hydroUid, username: user?.uname } };
      }
      generatedAccount = await this.accounts.provision(student.basic.name, student._id);
      student.hydroUid = generatedAccount.uid;
      await jobs.updateOne({ _id: student._id }, { $set: { hydroUid: student.hydroUid, state: 'account_ready' } });
    }
    await this.mutation(uid, 'students.create', student._id, Object.keys(input).filter((key) => key !== 'requestId'), async () => {
      try { await this.students.insertOne(student); }
      catch (error) {
        if (!generatedAccount || (error as { code?: number }).code !== 11000 || !await this.students.findOne({ _id: student._id, hydroUid: generatedAccount.uid })) throw error;
      }
    });
    if (generatedAccount) await this.db.collection('sms_account_jobs').updateOne({ _id: student._id as never }, { $set: { state: 'completed' } });
    return { ...await this.detail(uid, student._id), ...(generatedAccount ? { generatedAccount } : {}) };
  }
  async searchUsers(uid: number, query: unknown, studentId: unknown) {
    const policy = await this.policy();
    if (!isAdmin(policy, uid)) {
      const id = text(studentId ?? '', 64, '学生 ID');
      const student = await this.students.findOne({ _id: id });
      if (!student || !canRead(policy, uid, student) || !allows(policy, uid, 'students.bind', id)) throw new SmsError(403, '没有账号绑定权限');
    }
    const q = text(query ?? '', 60, '账号搜索词');
    if (!q) return [];
    const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const users = await this.db.collection<{ _id: number; uname: string; unameLower: string }>('user').find({
      _id: { $gt: 0 }, $or: [{ unameLower: { $regex: pattern, $options: 'i' } }, .../^\d+$/.test(q) ? [{ _id: Number(q) }] : []],
    }, { projection: { _id: 1, uname: 1 } }).sort({ _id: 1 }).limit(10).toArray();
    const bound = await this.students.find({ hydroUid: { $in: users.map((user) => user._id) } }, { projection: { _id: 1, hydroUid: 1 } }).toArray();
    return users.map((user) => ({ uid: user._id, username: user.uname, available: !bound.some((s) => s.hydroUid === user._id && s._id !== studentId) }));
  }
  checkFields(input: Record<string, unknown>, fields: string[]) {
    if (Object.keys(input).some((key) => !fields.includes(key))) throw new SmsError(400, '请求包含未知字段');
  }
  async update(uid: number, id: string, value: unknown) {
    return studentLock(this.db, async () => { await requireNoStudentBatch(this.db); return this.updateUnlocked(uid, id, value); });
  }
  private async updateUnlocked(uid: number, id: string, value: unknown) {
    const input = object(value);
    this.checkFields(input, ['version', 'basic', 'sensitive', 'internalNote', 'hydroUid']);
    const version = positiveInt(input.version, '资料版本');
    const policy = await this.policy();
    const student = await this.students.findOne({ _id: id });
    if (!student || !canRead(policy, uid, student)) throw new SmsError(404, '学生档案不存在或无权查看');
    const $set: Partial<Student> = { updatedAt: new Date(), updatedBy: uid };
    const $unset: Record<string, ''> = {};
    if ('basic' in input || 'sensitive' in input || 'internalNote' in input) {
      if (!allows(policy, uid, 'students.write', id)) throw new SmsError(403, '没有资料编辑权限');
      if ('basic' in input) $set.basic = validateBasic(input.basic);
      if ('sensitive' in input || 'internalNote' in input) {
        if (!allows(policy, uid, 'students.sensitive', id)) throw new SmsError(403, '没有敏感资料管理权限');
        if ('sensitive' in input) $set.sensitive = validateSensitive(input.sensitive);
        if ('internalNote' in input) {
          if (student.hydroUid === uid) throw new SmsError(403, '不能访问本人内部备注');
          $set.internalNote = text(input.internalNote, 3000, '内部备注');
        }
      }
    }
    if ('hydroUid' in input) {
      if (!allows(policy, uid, 'students.bind', id)) throw new SmsError(403, '没有账号绑定权限');
      const target = await this.assertUser(input.hydroUid);
      if (target === undefined) $unset.hydroUid = '';
      else $set.hydroUid = target;
    }
    if (Object.keys(input).length === 1) throw new SmsError(400, '没有待保存的修改');
    await this.mutation(uid, 'students.update', id, Object.keys(input).filter((k) => k !== 'version'), async () => {
      const result = await this.students.updateOne({ _id: id, version }, { $set, $inc: { version: 1, ...($set.basic && ($set.basic.grade !== student.basic.grade || $set.basic.status !== student.basic.status) ? { gradeRevision: 1 } : {}) }, ...Object.keys($unset).length ? { $unset } : {} });
      if (!result.matchedCount) throw new SmsError(409, '资料已被其他人修改，请重新打开后编辑');
    });
    return this.detail(uid, id);
  }
  async permissions(uid: number) {
    const policy = await this.requireAdmin(uid);
    return { ...policy, permissionNames: ['students.read', 'students.sensitive', 'students.write', 'students.bind'] };
  }
  async setGrant(uid: number, value: unknown) {
    const policy = await this.requireAdmin(uid);
    const input = object(value);
    this.checkFields(input, ['action', 'revision', 'uid', 'permissions', 'studentIds', 'expiresAt']);
    const revision = positiveInt(input.revision, '授权版本');
    if (revision !== policy.revision) throw new SmsError(409, '授权已变化，请刷新');
    const targetUid = positiveInt(input.uid);
    await this.assertUser(targetUid);
    if (policy.admins.includes(targetUid)) throw new SmsError(400, '插件管理员由服务器 CLI 管理，无需追加授权');
    const grants = policy.grants.filter((g) => g.uid !== targetUid);
    if (input.action === 'save') {
      const grant = validateGrant(input);
      if (grant.studentIds !== 'all' && await this.students.countDocuments({ _id: { $in: grant.studentIds } }) !== grant.studentIds.length) throw new SmsError(400, '授权范围包含不存在的学生');
      grants.push(grant);
    } else if (input.action !== 'revoke') throw new SmsError(400, '授权操作无效');
    await this.mutation(uid, `permissions.${input.action}`, String(targetUid), ['permissions', 'studentIds', 'expiresAt'], async () => {
      const result = await this.policies.updateOne({ _id: 'global', revision, admins: uid }, { $set: { grants }, $inc: { revision: 1 } });
      if (!result.matchedCount) throw new SmsError(409, '授权已变化，请刷新');
    });
    return this.permissions(uid);
  }
  async auditList(uid: number) {
    await this.requireAdmin(uid);
    return this.db.collection('sms_audit').find({}, { projection: { uid: 1, action: 1, target: 1, fields: 1, at: 1, outcome: 1 } }).sort({ at: -1 }).limit(100).toArray();
  }
}
