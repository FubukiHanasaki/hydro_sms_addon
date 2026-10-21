/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { SmsError } from './types';
export async function studentLock<T>(db: Db, work: (verify: () => Promise<void>) => Promise<T>): Promise<T> {
  const locks = db.collection<{ _id: string; token: string; expiresAt: Date }>('sms_batch_locks');
  const token = randomUUID(), _id = 'students';
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await locks.updateOne({ _id, expiresAt: { $lte: new Date() } }, { $set: { token, expiresAt: new Date(Date.now() + 120000) } }, { upsert: true }); break; }
    catch (e) {
      if ((e as {code?:number}).code !== 11000) throw e;
      if (Date.now() >= deadline) throw new SmsError(409, '学生资料正在处理，请稍后重试');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const verify = async () => { const r = await locks.updateOne({ _id, token, expiresAt: { $gt: new Date() } }, { $set: { expiresAt: new Date(Date.now() + 120000) } }); if (!r.matchedCount) throw new SmsError(409, '操作锁已失效，请重试'); };
  try { await verify(); return await work(verify); } finally { await locks.deleteOne({ _id, token }); }
}
export async function requireNoStudentBatch(db: Db) {
  if (await db.collection('sms_student_imports').findOne({status:'running'})) throw new SmsError(409, '学生导入尚未完成，请先从导入记录继续处理');
  if (await db.collection('sms_bulk_jobs').findOne({ kind: { $in: ['promotion', 'provision'] }, status: { $in: ['running', 'undoing'] } })) throw new SmsError(409, '有未完成的批量操作，请先从批量操作记录继续处理');
}
