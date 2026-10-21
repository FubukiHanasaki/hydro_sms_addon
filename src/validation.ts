import { BASIC_FIELDS, SENSITIVE_FIELDS, PERMISSIONS, Grant, SmsError } from './types';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SmsError(400, '请求必须为对象');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new SmsError(400, `${label}必须为文本`);
  const result = value.trim();
  if (result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw new SmsError(400, `${label}格式或长度不正确`);
  return result;
}
export function positiveInt(value: unknown, label = 'UID'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new SmsError(400, `${label}必须为正整数`);
  return value;
}
export function validDate(value: string, label: string): string {
  if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new SmsError(400, `${label}日期无效`);
  return value;
}
export function validateBasic(value: unknown) {
  const input = object(value);
  if (Object.keys(input).some((k) => !(BASIC_FIELDS as readonly string[]).includes(k))) throw new SmsError(400, '基本资料包含未知字段');
  const result = Object.fromEntries(BASIC_FIELDS.map((k) => [k, text(input[k] ?? '', k === 'name' ? 80 : 160, k)])) as Record<typeof BASIC_FIELDS[number], string>;
  if (!result.name) throw new SmsError(400, '姓名不能为空');
  if (!['在校', '休学', '离校'].includes(result.status)) throw new SmsError(400, '请选择有效学生状态');
  if (result.gender && !['男', '女', '未填写'].includes(result.gender)) throw new SmsError(400, '性别无效');
  validDate(result.enrollmentDate, '入学日期');
  return result;
}
export function birthday(value: string): string {
  if (!value) return '';
  const match = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(value);
  if (!match || +match[1] < 1900 || +match[1] > new Date().getUTCFullYear()) throw new SmsError(400, '生日请填写有效年份、年月或年月日');
  const year = match[1];
  if (!match[2]) return year;
  const month = match[2].padStart(2, '0');
  if (+month < 1 || +month > 12) throw new SmsError(400, '生日月份无效');
  if (!match[3]) return `${year}-${month}`;
  return validDate(`${year}-${month}-${match[3].padStart(2, '0')}`, '生日');
}
export function validateSensitive(value: unknown) {
  const input = object(value);
  if (Object.keys(input).some((k) => !(SENSITIVE_FIELDS as readonly string[]).includes(k))) throw new SmsError(400, '敏感资料包含未知字段');
  const result = Object.fromEntries(SENSITIVE_FIELDS.map((k) => [k, text(input[k] ?? '', k === 'address' ? 500 : 160, k)])) as Record<typeof SENSITIVE_FIELDS[number], string>;
  result.birthday = birthday(result.birthday);
  return result;
}
export function validateGrant(value: unknown): Grant {
  const input = object(value);
  const uid = positiveInt(input.uid);
  if (!Array.isArray(input.permissions) || !input.permissions.length || input.permissions.some((p) => !(PERMISSIONS as readonly unknown[]).includes(p))) throw new SmsError(400, '请选择有效权限');
  const permissions = [...new Set(input.permissions)] as Grant['permissions'];
  if (!permissions.includes('students.read')) throw new SmsError(400, '授权必须包含基本资料查看权限');
  let studentIds: Grant['studentIds'] = 'all';
  if (input.studentIds !== 'all') {
    if (!Array.isArray(input.studentIds) || !input.studentIds.length || input.studentIds.length > 500) throw new SmsError(400, '请选择学生范围');
    studentIds = [...new Set(input.studentIds.map((id) => text(id, 64, '学生 ID')))];
    if (studentIds.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))) throw new SmsError(400, '学生 ID 无效');
  }
  let expiresAt: string | null = null;
  if (input.expiresAt) {
    if (typeof input.expiresAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(input.expiresAt) || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) throw new SmsError(400, '失效时间必须包含时区且晚于现在');
    expiresAt = new Date(input.expiresAt).toISOString();
  }
  return { uid, permissions, studentIds, expiresAt };
}
