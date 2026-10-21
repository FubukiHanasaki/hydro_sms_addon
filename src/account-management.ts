import { randomUUID } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import { StudentService } from './service';
import { SmsError } from './types';
import { object, positiveInt, text } from './validation';

interface UserDoc { _id: number; uname: string; unameLower: string; mailLower?: string; priv: number }
interface AccountState { _id: number; version: number; pendingOperation?: string; completedOperation?: string }
export interface UserGateway {
  create(mail: string, username: string, password: string): Promise<number>;
  rename(uid: number, username: string): Promise<unknown>;
  password(uid: number, password: string): Promise<unknown>;
  privileges(uid: number, priv: number): Promise<unknown>;
  revoke(uid: number): Promise<unknown>;
  normalizeUsername(value: string): string;
  profilePrivilege: number; defaultPrivileges: number;
}
export class AccountManagement {
  constructor(private db: Db, private students: StudentService, private host: UserGateway) {}
  get users() { return this.db.collection<UserDoc>('user'); }
  get states() { return this.db.collection<AccountState>('sms_account_state'); }
  async init() { await this.states.createIndex({ _id: 1 }); }
  protected(user: UserDoc, admins: number[]) { return user._id <= 1 || admins.includes(user._id) || !!(user.priv & ~this.host.defaultPrivileges); }
  async list(uid: number, query: unknown, enabledValue: unknown, pageValue: unknown) {
    const policy = await this.students.requireAction(uid,'accounts.read');
    const q = text(query ?? '', 80, '搜索词'); const enabled = text(enabledValue ?? '', 10, '账号状态'); const page = Number(pageValue ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new SmsError(400, '页码无效');
    if (!['', 'enabled', 'disabled'].includes(enabled)) throw new SmsError(400, '账号状态无效');
    const [result] = await this.users.aggregate([
      { $match: { _id: { $gt: 0 } } },
      { $lookup: { from: 'sms_students', localField: '_id', foreignField: 'hydroUid', pipeline: [{ $project: { 'basic.name': 1 } }], as: 'student' } },
      ...q ? [{ $match: { $or: [{ uname: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { 'student.basic.name': { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, .../^\d+$/.test(q) ? [{ _id: Number(q) }] : []] } }] : [],
      ...enabled ? [{ $match: { priv: { [enabled === 'enabled' ? '$bitsAllSet' : '$bitsAllClear']: this.host.profilePrivilege } } }] : [],
      { $lookup: { from: 'sms_account_state', localField: '_id', foreignField: '_id', as: 'state' } },
      { $facet: { count: [{ $count: 'total' }], rows: [{ $sort: { _id: 1 } }, { $skip: (page - 1) * 20 }, { $limit: 20 }, { $project: { _id: 1, uname: 1, priv: 1, studentName: { $first: '$student.basic.name' }, studentId: { $first: '$student._id' }, version: { $ifNull: [{ $first: '$state.version' }, 0] } } }] } },
    ]).toArray();
    return { total: result?.count[0]?.total ?? 0, page, accounts: (result?.rows ?? []).map((user: Document) => ({ uid: user._id, username: user.uname, enabled: !!(user.priv & this.host.profilePrivilege), protected: this.protected(user as UserDoc, policy.admins), studentName: user.studentName || null, studentId: user.studentId || null, version: user.version })) };
  }
  username(value: unknown) { const raw = text(value, 100, '用户名'); try { return this.host.normalizeUsername(raw); } catch { throw new SmsError(400, '用户名须符合 Hydro 格式：3–31 个字符或两个汉字'); } }
  password(value: unknown) { if (typeof value !== 'string' || !/^.{6,255}$/.test(value)) throw new SmsError(400, '密码须为 6–255 个字符'); return value; }
  async create(uid: number, value: unknown) {
    await this.students.requireAction(uid,'accounts.create'); const input = object(value); this.fields(input, ['username', 'password', 'requestId']);
    const username = this.username(input.username); const password = this.password(input.password); const requestId = text(input.requestId, 36, '请求标识');
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId)) throw new SmsError(400, '创建账号需要有效请求标识');
    const mail = `sms-admin-${uid}-${requestId.toLowerCase()}@accounts.invalid`;
    const recover = async () => {
      const existing = await this.users.findOne({ mailLower: mail }, { projection: { uname: 1 } });
      if (existing && existing.uname !== username) throw new SmsError(409, '该请求已用于其他账号，请重新打开创建窗口');
      return existing ? { uid: existing._id, username: existing.uname } : null;
    };
    const existing = await recover(); if (existing) return existing;
    return this.students.mutation(uid, 'accounts.create', requestId, ['username'], async () => {
      try { return { uid: await this.host.create(mail, username, password), username }; }
      catch (e) { const account = await recover(); if (account) return account; if ((e as { code?: number }).code === 11000 || (e as Error).name === 'UserAlreadyExistError') throw new SmsError(409, '用户名已被使用'); throw e; }
    });
  }
  async update(uid: number, targetValue: unknown, value: unknown, operationKey?: string) {
    const target = positiveInt(Number(targetValue)); const input = object(value);
    this.fields(input, ['action', 'username', 'password', 'enabled', 'version']);
    await this.students.requireAction(uid,`accounts.${String(input.action)}`);
    if (!['rename', 'password', 'status'].includes(String(input.action))) throw new SmsError(400, '账号操作无效');
    if (!Number.isSafeInteger(input.version) || (input.version as number) < 0) throw new SmsError(400, '请刷新后取得有效版本');
    const username = input.action === 'rename' ? this.username(input.username) : undefined;
    const password = input.action === 'password' ? this.password(input.password) : undefined;
    if (input.action === 'status' && typeof input.enabled !== 'boolean') throw new SmsError(400, '启用状态无效');
    const locks = this.db.collection<{ _id: number; token: string; expiresAt: Date }>('sms_account_locks'); const token = randomUUID();
    try { await locks.findOneAndUpdate({ _id: target, expiresAt: { $lte: new Date() } }, { $set: { token, expiresAt: new Date(Date.now() + 120000) } }, { upsert: true }); }
    catch (e) { if ((e as { code?: number }).code === 11000) throw new SmsError(409, '账号正在修改，请稍后重试'); throw e; }
    try {
      const policy = await this.students.requireAction(uid,`accounts.${String(input.action)}`); const user = await this.users.findOne({ _id: target });
      if (!user) throw new SmsError(404, '账号不存在');
      if (this.protected(user, policy.admins)) throw new SmsError(403, '内置、插件管理员或带额外 Hydro 权限的账号为受保护账号');
      const state = await this.states.findOne({ _id: target });
      if (operationKey && state?.completedOperation === operationKey) return { uid: target, version: state.version };
      if (state?.pendingOperation && state.pendingOperation !== operationKey) throw new SmsError(409, '该账号有未完成的批量重置，请先继续原批次');
      const resuming = !!operationKey && state?.pendingOperation === operationKey;
      if (!resuming && (state?.version ?? 0) !== input.version) throw new SmsError(409, '账号已被修改，请刷新后重试');
      return await this.students.mutation(uid, `accounts.${input.action}`, String(target), [String(input.action === 'status' ? 'enabled' : input.action === 'password' ? 'password' : 'username')], async () => {
        // Reserve the revision before host writes so failed requests cannot be
        // replayed on a stale account snapshot. No passwords enter plugin data.
        if (!resuming) await this.states.updateOne({ _id: target }, { $inc: { version: 1 }, ...(operationKey ? { $set: { pendingOperation: operationKey } } : {}) }, { upsert: true });
        try {
          if (username !== undefined) await this.host.rename(target, username);
          else if (password !== undefined) { await this.host.password(target, password); await this.host.revoke(target); }
          else { await this.host.privileges(target, input.enabled ? user.priv | this.host.profilePrivilege : user.priv & ~this.host.profilePrivilege); if (!input.enabled) await this.host.revoke(target); }
        } catch (e) { if ((e as { code?: number }).code === 11000 || (e as Error).name === 'UserAlreadyExistError') throw new SmsError(409, '用户名已被使用'); throw e; }
        if (operationKey) await this.states.updateOne({ _id: target, pendingOperation: operationKey }, { $set: { completedOperation: operationKey }, $unset: { pendingOperation: '' } });
        return { uid: target, version: (state?.version ?? 0) + (resuming ? 0 : 1) };
      });
    } finally { await locks.deleteOne({ _id: target, token }); }
  }
  fields(input: Record<string, unknown>, allowed: string[]) { if (Object.keys(input).some(key => !allowed.includes(key))) throw new SmsError(400, '请求包含未知字段'); }
}
