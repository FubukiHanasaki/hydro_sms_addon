import { pinyin } from 'pinyin-pro';
import type { Db } from 'mongodb';
import { SmsError } from './types';

export function usernameBase(name: string) {
  const value = pinyin(name, { toneType: 'none', type: 'array', mode: 'surname', surname: 'head' }).join('')
    .toLowerCase().replace(/ü/g, 'v').replace(/[^a-z0-9]/g, '');
  if (!value) throw new SmsError(400, '姓名无法生成拼音账号，请选择已有 Hydro UID');
  return value.length < 3 ? `${value}01` : value.slice(0, 27);
}
export interface CreatedAccount { uid: number; username: string }
export interface AccountGateway { provision(name: string, requestKey: string): Promise<CreatedAccount> }
export class HydroAccounts implements AccountGateway {
  constructor(private db: Db, private createUser: (mail: string, username: string, password: string) => Promise<number>) {}
  async provision(name: string, requestKey: string): Promise<CreatedAccount> {
    const users = this.db.collection<{ _id: number; uname: string; unameLower: string; mailLower: string }>('user');
    // A stable internal email lets a retried/parallel request recover the same
    // account if Hydro committed it before the student record was written.
    const mail = `sms-${requestKey}@accounts.invalid`;
    const recover = async () => {
      const user = await users.findOne({ mailLower: mail });
      if (user) await this.db.collection('domain.user').updateOne({ uid: user._id, domainId: 'system' }, { $set: { join: true } }, { upsert: true });
      return user ? { uid: user._id, username: user.uname } : null;
    };
    const existing = await recover();
    if (existing) return existing;
    const base = usernameBase(name);
    for (let suffix = 0; suffix < 10000; suffix++) {
      const username = suffix ? `${base}${suffix}` : base;
      if (await users.findOne({ unameLower: username }, { projection: { _id: 1 } })) continue;
      try {
        return { uid: await this.createUser(mail, username, username), username };
      } catch (error) {
        const account = await recover();
        if (account) return account;
        if ((error as { name?: string }).name !== 'UserAlreadyExistError' && (error as { code?: number }).code !== 11000) throw error;
      }
    }
    throw new SmsError(409, '同名账号过多，请选择已有 Hydro UID');
  }
}
