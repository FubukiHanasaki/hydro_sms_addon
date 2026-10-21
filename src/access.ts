import { Policy, Permission, Student, StudentView, basicView } from './types';

export function isAdmin(policy: Policy, uid: number): boolean {
  return Number.isSafeInteger(uid) && uid > 0 && policy.admins.includes(uid);
}
export function activeGrant(policy: Policy, uid: number, now = Date.now()) {
  return policy.grants.filter((g) => g.uid === uid && (!g.expiresAt || Date.parse(g.expiresAt) > now));
}
export function allows(policy: Policy, uid: number, permission: Permission, studentId?: string): boolean {
  if (uid <= 0) return false;
  if (isAdmin(policy, uid)) return true;
  return activeGrant(policy, uid).some((g) => g.permissions.includes(permission)
    && (g.studentIds === 'all' || (!!studentId && g.studentIds.includes(studentId))));
}
export function canRead(policy: Policy, uid: number, student: Student): boolean {
  return uid > 0 && (student.hydroUid === uid || allows(policy, uid, 'students.read', student._id));
}
export function visibleStudent(policy: Policy, uid: number, student: Student): StudentView | null {
  if (!canRead(policy, uid, student)) return null;
  const sensitive = student.hydroUid === uid || allows(policy, uid, 'students.sensitive', student._id);
  // Internal notes are staff-only even when a student can read their own contacts.
  const internalNote = student.hydroUid !== uid && allows(policy, uid, 'students.sensitive', student._id);
  return {
    id: student._id, basic: basicView(student.basic), hydroUid: student.hydroUid ?? null,
    version: student.version, updatedAt: student.updatedAt,
    ...(sensitive ? { sensitive: { ...student.sensitive } } : {}),
    ...(internalNote ? { internalNote: student.internalNote } : {}),
    capabilities: {
      edit: allows(policy, uid, 'students.write', student._id), sensitive,
      editSensitive: allows(policy, uid, 'students.write', student._id) && allows(policy, uid, 'students.sensitive', student._id),
      bind: allows(policy, uid, 'students.bind', student._id), internalNote,
    },
  };
}
export function readFilter(policy: Policy, uid: number): Record<string, unknown> {
  if (uid <= 0) return { _id: { $in: [] } };
  if (allows(policy, uid, 'students.read')) return {};
  const ids = activeGrant(policy, uid).filter((g) => g.permissions.includes('students.read'))
    .flatMap((g) => g.studentIds === 'all' ? [] : g.studentIds);
  return { $or: [{ hydroUid: uid }, { _id: { $in: [...new Set(ids)] } }] };
}
