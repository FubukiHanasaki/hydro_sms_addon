/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { ObjectId, type Db } from 'mongodb';
import { createHash } from 'node:crypto';
// Only contest configuration belongs here. Identity, ownership, attendance and
// submission/status data remain owned by Hydro and are never restored from a form.
export const CONTEST_FIELDS = ['title','content','rule','beginAt','endAt','pids','rated','duration',
 'assign','_code','autoHide','lockAt','maintainer','allowViewCode','allowPrint',
 'keepScoreboardHidden','langs','score','balloon','unlocked','files','privateFiles','allowTeam'] as const;
export function nativeConfig(c: any) {
 const config: Record<string, any> = {};
 for (const k of CONTEST_FIELDS) if (c[k] !== undefined) config[k] = c[k];
 return config;
}
export async function syncNativeRated(db: Db, domainId: string, contestId: string, rated: boolean) {
 // This is a projection of an already authorized SMS setting, not a native edit
 // or a result change: never invalidate a review or publish a Rating generation.
 await db.collection('document').updateOne({docType:30,domainId,docId:new ObjectId(contestId)},{$set:{rated}});
 await db.collection('sms_exam_native').updateOne({_id:`${domainId}:${contestId}` as any},{$set:{'config.rated':rated}});
}
export async function captureNative(db: Db, c: any) {
 const key=`${c.domainId}:${c.docId}`;
 if (!await db.collection('sms_exams').findOne({_id:key as any})) return;
 const cfg=await db.collection('sms_rating_contests').findOne({_id:key as any});
 const config=nativeConfig(c);config.rated=cfg?.enabled??false;
 await db.collection('sms_exam_native').updateOne({_id:key as any},{$set:{domainId:c.domainId,contestId:String(c.docId),config,updatedAt:new Date()}},{upsert:true});
 await syncNativeRated(db,c.domainId,String(c.docId),config.rated);
}
export async function restoreNative(db: Db) {
 let synchronized=0;
 for await (const e of db.collection('sms_exams').find({})) {
  if (!ObjectId.isValid(e.contestId)) continue;
  const query={docType:30,domainId:e.domainId,docId:new ObjectId(e.contestId)};
  const c=await db.collection('document').findOne(query);if(!c)continue;
  const saved=await db.collection('sms_exam_native').findOne({_id:e._id});
  const cfg=await db.collection('sms_rating_contests').findOne({_id:e._id});
  const config=nativeConfig(saved?.config??c);config.rated=cfg?.enabled??false;
  // Store before applying, so an interrupted migration can safely resume. On
  // first upgrade retain the pre-migration flag for a local administrator audit.
  await db.collection('sms_exam_native').updateOne({_id:e._id},{$set:{domainId:e.domainId,contestId:e.contestId,config},$setOnInsert:{originalRated:!!c.rated,createdAt:new Date()}},{upsert:true});
  const unset=Object.fromEntries(CONTEST_FIELDS.filter(k=>!Object.hasOwn(config,k)).map(k=>[k,'']));
  await db.collection('document').updateOne(query,{$set:config,...saved&&Object.keys(unset).length?{$unset:unset}:{}});synchronized++;
 }
 return synchronized;
}

// Presentation, attachments and participation restrictions do not change scores.
export function resultFingerprint(c:any) {
 const fields=['rule','beginAt','endAt','pids','duration','score','lockAt','unlocked','allowTeam'];
 const normalize=(v:any):any=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(fields.map(k=>[k,normalize(c[k]??null)]))).digest('hex');
}
