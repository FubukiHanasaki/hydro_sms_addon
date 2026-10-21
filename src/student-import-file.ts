/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { SmsError } from './types';
import { object, text } from './validation';
export const IMPORT_FIELDS = { name: '姓名', gender: '性别', grade: '年级', school: '学校', status: '学生状态', enrollmentDate: '入学日期', currentStage: '学习阶段', hydroUid: 'Hydro UID', rating: 'Rating', ratingRecordedAt: 'Rating结算时间', accountMode: '账号处理' };
const aliases: Record<string, string[]> = { name:['姓名','学生姓名','学生','name'], gender:['性别','gender','sex'], grade:['年级','grade'],school:['学校','所在学校','school'],status:['学生状态','状态','学籍状态','status'],enrollmentDate:['入学日期','入学时间','enrollmentDate','enrollment_date'],currentStage:['学习阶段','当前阶段','currentStage','current_stage'],hydroUid:['Hydro UID','HydroUID','UID','hydroUid','hydro_uid'],rating:['Rating','rating分数','rating_score'],ratingRecordedAt:['Rating结算时间','最后结算时间','Rating记录时间','ratingRecordedAt','recordedAt'],accountMode:['账号处理','账户处理','accountMode'] };
export interface FileRow { row:number; values:string[]; errors:string[] }
export interface ParsedFile { sheets:string[];sheet:string;headers:string[];rows:FileRow[] }
export function guessMapping(headers:string[]) { const result:Record<string,number>={};for(const [key,names]of Object.entries(aliases)){const matches=headers.flatMap((v,n)=>names.some(a=>a.toLowerCase()===v.replace(/^\uFEFF/,'').trim().toLowerCase())?[n]:[]);if(matches.length===1)result[key]=matches[0];}return result; }
export async function parseTableFile(value:unknown):Promise<ParsedFile> {
  const b=object(value);if(Object.keys(b).some(k=>!['filename','content','sheet'].includes(k)))throw new SmsError(400,'请求包含未知字段');
  const name=text(b.filename,160,'文件名'),ext=name.split('.').at(-1)?.toLowerCase();if(!ext||!['xlsx','xls','csv'].includes(ext))throw new SmsError(400,'请选择 XLSX、XLS 或 CSV 文件');
  if(typeof b.content!=='string'||b.content.length>2800000||!b.content.length||(b.content.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.content)))throw new SmsError(400,'文件编码无效或超过 2 MB');
  const bytes=Buffer.from(b.content,'base64');if(bytes.length>2*1024*1024)throw new SmsError(400,'文件不能超过 2 MB');
  if(ext==='xlsx'&&!bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4]))||ext==='xls'&&!bytes.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])))throw new SmsError(400,'文件内容与扩展名不一致');
  const result=await new Promise<ParsedFile>((resolve,reject)=>{
    const worker=new Worker(join(__dirname,'student-import-worker.cjs'),{workerData:{bytes,ext,sheet:b.sheet===undefined?'':text(b.sheet,100,'工作表')},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16}});
    const timer=setTimeout(()=>{void worker.terminate();reject(new SmsError(400,'文件解析超时，请简化表格后重试'));},10000);
    worker.once('message',(message:ParsedFile & {error?:string})=>{clearTimeout(timer);void worker.terminate();if(message.error)reject(new SmsError(400,message.error));else resolve(message);});
    worker.once('error',()=>{clearTimeout(timer);reject(new SmsError(400,'表格过大或无法解析，请检查文件'));});worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new SmsError(400,'文件解析未完成'));});
  });
  return result;
}

export async function parseStudentFile(value:unknown){const result=await parseTableFile(value);return {...result,mapping:guessMapping(result.headers),fields:IMPORT_FIELDS};}
