import { inferImportHeaders } from './import-headers';
/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { OrganizationService } from './organization';
import { StudentService } from './service';
import { parseTableFile } from './student-import-file';
import { SmsError } from './types';

interface MemberRow { row: number; uid: number | null; username: string; name: string; kind: 'student' | 'member'; status: 'add' | 'existing' | 'invalid'; errors: string[] }
interface MemberBatch { _id: string; actor: number; domainId: string; version: number; rows: MemberRow[]; state: 'preview' | 'applying' | 'complete' | 'failed'; added: number; skipped?: number; expiresAt: Date }
export class MemberImportService {
  constructor(private db: Db, private students: StudentService, private organization: OrganizationService) {}
  get batches() { return this.db.collection<MemberBatch>('sms_member_imports'); }
  async init() { await this.batches.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); }
  async scope(actor: number, id: string) {
    const domainId = (await this.organization.metadata(id))?.domainId || id;
    await this.students.requireAction(actor, 'classes.members', [domainId]);
    await this.organization.domain(domainId);
    return domainId;
  }
  async preview(actor: number, id: string, value: unknown) {
    const domainId = await this.scope(actor, id);
    if (await this.batches.countDocuments({ actor, state: 'preview', expiresAt: { $gt: new Date() } }) >= 5) throw new SmsError(429, '待确认预览过多，请先取消已有预览');
    if (!value || typeof value !== 'object' || !/\.(xlsx|csv)$/i.test(String((value as Record<string, unknown>).filename ?? ''))) throw new SmsError(400, '请选择 XLSX 或 CSV 文件');
    const file = await parseTableFile(value);
    const { mapping } = inferImportHeaders(file.headers, { hydroUid: ['UID', 'Hydro UID', 'hydro_uid'] });
    if (mapping.hydroUid === undefined) throw new SmsError(400, '无法唯一识别 UID 列，请保留一列 UID、Hydro UID 或 OJ UID，避免重复或含义不明的表头');
    if (file.rows.length > 200) throw new SmsError(400, '每次最多导入 200 名成员');
    const version = (await this.organization.metadata(domainId))?.version ?? 0;
    const rows: MemberRow[] = []; const seen = new Set<number>();
    for (const row of file.rows) {
      const raw = row.values[mapping.hydroUid] || ''; const target = /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
      const errors = [...row.errors];
      if (target === null) errors.push('UID 必须是正整数');
      else if (seen.has(target)) errors.push('文件中 UID 重复');
      if (target !== null) seen.add(target);
      const user = target === null ? null : await this.db.collection<{ _id: number; uname: string }>('user').findOne({ _id: target }, { projection: { uname: 1 } });
      if (target !== null && !user) errors.push('Hydro 账号不存在');
      const student = user ? await this.students.students.findOne({ hydroUid: target! }, { projection: { 'basic.name': 1 } }) : null;
      const existing = user && await this.organization.joined(domainId, target!);
      rows.push({ row: row.row, uid: target, username: user?.uname || '', name: student?.basic?.name || '', kind: student ? 'student' : 'member', status: errors.length ? 'invalid' : existing ? 'existing' : 'add', errors });
    }
    // Bind the preview to the roster version observed before reading its rows.
    // A second read below rejects mutations during the scan.
    if (((await this.organization.metadata(domainId))?.version ?? 0) !== version) throw new SmsError(409, '名册已更新，请重新预览');
    const batch: MemberBatch = { _id: randomUUID(), actor, domainId, version, rows, state: 'preview', added: 0, expiresAt: new Date(Date.now() + 3600000) };
    await this.scope(actor, domainId);
    await this.batches.insertOne(batch);
    return batch;
  }
  async cancel(actor: number, id: string, batchId: string) {
    const domainId = await this.scope(actor, id);
    await this.batches.deleteOne({ _id: batchId, actor, domainId, state: 'preview' });
    return { cancelled: true };
  }
  async confirm(actor: number, id: string, batchId: string) {
    const domainId = await this.scope(actor, id);
    const batch = await this.batches.findOne({ _id: batchId, actor, domainId, expiresAt: { $gt: new Date() } });
    if (!batch) throw new SmsError(404, '导入预览不存在或已过期');
    if (batch.state === 'complete') return { added: batch.added, skipped: batch.skipped ?? 0 };
    if (batch.state !== 'preview') throw new SmsError(409, '该批次已执行，请刷新名册，核对后重新预览剩余成员');
    if (batch.rows.some(r => r.errors.length)) throw new SmsError(400, '请修正无效或重复 UID 后重新上传');
    if (((await this.organization.metadata(domainId))?.version ?? 0) !== batch.version) throw new SmsError(409, '名册已更新，请重新预览');
    for (const row of batch.rows.filter(r => r.status === 'add')) {
      await this.students.assertUser(row.uid);
      const hasStudent = !!await this.students.students.findOne({ hydroUid: row.uid! }, { projection: { _id: 1 } });
      if (hasStudent !== (row.kind === 'student') || await this.organization.joined(domainId, row.uid!)) throw new SmsError(409, '档案绑定或成员关系已变化，请重新预览');
    }
    const claimed = await this.batches.updateOne({ _id: batchId, state: 'preview' }, { $set: { state: 'applying' } });
    if (!claimed.modifiedCount) throw new SmsError(409, '该批次正在导入，请勿重复确认');
    let added = 0; let version = batch.version;
    try {
      for (const row of batch.rows.filter(r => r.status === 'add')) {
        const hasStudent = !!await this.students.students.findOne({ hydroUid: row.uid! }, { projection: { _id: 1 } });
        if (hasStudent !== (row.kind === 'student') || await this.organization.joined(domainId, row.uid!)) throw new SmsError(409, '成员或档案已变化');
        const result = await this.organization.domainMembership(actor, domainId, { uid: row.uid, joined: true, kind: row.kind, version });
        version = result.version; added++;
        await this.batches.updateOne({ _id: batchId }, { $set: { added } });
      }
      await this.batches.updateOne({ _id: batchId }, { $set: { state: 'complete', skipped: batch.rows.filter(r => r.status === 'existing').length, rows: [] } });
      return { added, skipped: batch.rows.filter(r => r.status === 'existing').length };
    } catch {
      await this.batches.updateOne({ _id: batchId }, { $set: { state: 'failed', rows: [] } });
      throw new SmsError(409, `导入中断，已完成 ${added} 名；请刷新名册核对后重新上传，已有成员会自动跳过`);
    }
  }
}
