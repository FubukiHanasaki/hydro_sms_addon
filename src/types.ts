export const BASIC_FIELDS = ['studentNo', 'name', 'gender', 'grade', 'school', 'status', 'campus', 'enrollmentDate', 'competitionLevel', 'currentStage', 'targetLevel'] as const;
export const SENSITIVE_FIELDS = ['birthday', 'phone', 'parentName', 'parentPhone', 'wechat', 'address'] as const;
export const PERMISSIONS = ['students.read', 'students.sensitive', 'students.write', 'students.bind'] as const;
export type Permission = typeof PERMISSIONS[number];
export type BasicField = typeof BASIC_FIELDS[number];
export type SensitiveField = typeof SENSITIVE_FIELDS[number];
export interface Student {
  _id: string;
  basic: Record<BasicField, string>;
  sensitive: Record<SensitiveField, string>;
  internalNote: string;
  hydroUid?: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: number;
  updatedBy: number;
}
export interface Grant {
  uid: number;
  permissions: Permission[];
  studentIds: 'all' | string[];
  expiresAt: string | null;
}
export interface Policy {
  _id: string;
  admins: number[];
  grants: Grant[];
  revision: number;
}
export interface StudentView {
  id: string;
  basic: Student['basic'];
  hydroUid: number | null;
  version: number;
  updatedAt: Date;
  sensitive?: Student['sensitive'];
  internalNote?: string;
  capabilities: { edit: boolean; editSensitive: boolean; sensitive: boolean; bind: boolean; internalNote: boolean };
}
export class SmsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
