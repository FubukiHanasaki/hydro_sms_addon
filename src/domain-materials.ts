/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { Db } from 'mongodb';
import { OrganizationService } from './organization';
import { StudentService } from './service';
import { SmsError } from './types';

export const MATERIAL_LIMITS = { file: 20 * 1024 * 1024, total: 500 * 1024 * 1024, count: 200 };
const images: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const extensions = new Set(['pdf','doc','docx','ppt','pptx','xls','xlsx','txt','md','csv','zip','7z','rar','c','cpp','h','py','java','pas', ...Object.keys(images)]);
interface Material { _id: string; domainId: string; filename: string; size: number; image: boolean; mime: string; path: string; createdBy: number; createdAt: Date }
export interface MaterialStorage {
  put(path: string, file: string, owner: number): Promise<unknown>;
  get(path: string): Promise<Readable>;
  del(paths: string[], owner: number): Promise<unknown>;
  getMeta(path: string): Promise<{ size: number } | null>;
}
export class DomainMaterials {
  constructor(private db: Db, private students: StudentService, private org: OrganizationService, private storage: MaterialStorage) {}
  get files() { return this.db.collection<Material>('sms_domain_materials'); }
  async init() { await this.files.createIndex({ domainId: 1, createdAt: -1 }); }
  private visible(file: Material) { return { id: file._id, filename: file.filename, size: file.size, image: file.image, createdAt: file.createdAt, url: `/sms/materials/${file._id}` }; }
  async readable(uid: number, id: string) {
    if (!(uid > 0) || !(await this.org.joined(id, uid) || await this.org.canManage(uid, id) || await this.students.authorization.fullRead(uid, id))) throw new SmsError(403, '无权读取该子域的学习资料');
  }
  async list(uid: number, id: string) {
    const domain = await this.org.canonicalDomain(id); await this.org.requireBulletin(uid, domain._id);
    return (await this.files.find({ domainId: domain._id }).sort({ createdAt: -1, _id: 1 }).toArray()).map(file => this.visible(file));
  }
  async upload(uid: number, id: string, file: { originalFilename?: string | null; filepath: string; size: number }) {
    const domain = await this.org.canonicalDomain(id); await this.org.requireBulletin(uid, domain._id);
    const filename = (file.originalFilename || '').normalize('NFC');
    if (!filename || filename.length > 160 || /[\x00-\x1f\x7f/\\]/.test(filename) || filename === '.' || filename === '..') throw new SmsError(400, '文件名无效');
    const ext = filename.split('.').at(-1)!.toLowerCase();
    if (!filename.includes('.') || !extensions.has(ext)) throw new SmsError(400, '不支持该资料格式，请使用文档、图片、压缩包或源代码文件');
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MATERIAL_LIMITS.file) throw new SmsError(400, '单个学习资料文件不能超过 20 MB，且不能为空');
    const info = await stat(file.filepath);
    if (!info.isFile() || info.size !== file.size) throw new SmsError(400, '文件大小不正确');
    if (images[ext]) {
      const input = await open(file.filepath, 'r'); const bytes = Buffer.alloc(16);
      try { await input.read(bytes, 0, bytes.length, 0); } finally { await input.close(); }
      const valid = ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : ['jpg', 'jpeg'].includes(ext) ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        : ext === 'gif' ? ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) throw new SmsError(400, '图片内容与文件格式不符');
    }
    return this.org.locked(domain._id, async verify => {
      await this.org.requireBulletin(uid, domain._id);
      const usage = await this.files.find({ domainId: domain._id }, { projection: { size: 1 } }).toArray();
      if (usage.length >= MATERIAL_LIMITS.count || usage.reduce((sum, row) => sum + row.size, 0) + file.size > MATERIAL_LIMITS.total) throw new SmsError(400, '该子域的学习资料已达到数量或容量上限');
      const material: Material = { _id: randomUUID(), domainId: domain._id, filename, size: file.size, image: !!images[ext], mime: images[ext] || 'application/octet-stream', path: '', createdBy: uid, createdAt: new Date() };
      material.path = `sms-domain/${Buffer.from(domain._id).toString('base64url')}/${material._id}.${ext}`;
      return this.students.mutation(uid, 'classes.material.upload', domain._id, ['filename', 'size'], async () => {
        try {
          await verify(); await this.storage.put(material.path, file.filepath, uid);
          const meta = await this.storage.getMeta(material.path);
          if (!meta || meta.size !== file.size) throw new SmsError(409, '资料上传未完成，请重试');
          await verify(); await this.org.requireBulletin(uid, domain._id);
          await this.files.insertOne(material);
          return this.visible(material);
        } catch (error) { await this.storage.del([material.path], uid); throw error; }
      });
    });
  }
  async download(uid: number, id: string) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new SmsError(404, '学习资料不存在');
    const file = await this.files.findOne({ _id: id });
    if (!file) throw new SmsError(404, '学习资料不存在');
    await this.org.domain(file.domainId); await this.readable(uid, file.domainId);
    if (!await this.storage.getMeta(file.path)) throw new SmsError(404, '学习资料不存在');
    return { filename: file.filename, mime: file.mime, image: file.image, body: await this.storage.get(file.path) };
  }
}
