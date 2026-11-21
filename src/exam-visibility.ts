/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { SmsError } from './types';
export type ExamVisibility = 'visible' | 'hidden' | 'until';
export interface VisibilitySettings { visibility?: ExamVisibility; visibleAt?: Date | null }
// Old contests are visible. A damaged hidden-until setting fails closed.
export function examHidden(exam: VisibilitySettings, now = Date.now()) {
 if (!exam.visibility || exam.visibility === 'visible') return false;
 if (exam.visibility === 'hidden') return true;
 const at = exam.visibleAt ? +new Date(exam.visibleAt) : NaN;
 return exam.visibility !== 'until' || !Number.isFinite(at) || now < at;
}
export function visibilitySettings(value: Record<string, unknown>, previous: VisibilitySettings = {}): Required<VisibilitySettings> {
 const visibility = value.visibility === undefined ? previous.visibility ?? 'visible' : value.visibility;
 if (!['visible', 'hidden', 'until'].includes(visibility as string)) throw new SmsError(400, '比赛显示设置无效');
 if (visibility !== 'until') return { visibility: visibility as ExamVisibility, visibleAt: null };
 const raw = value.visibleAt === undefined ? previous.visibleAt : value.visibleAt;
 // Browser datetime-local values are explicitly Beijing time, independent of
 // the server/browser timezone. API timestamps must carry an explicit offset.
 const local = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw);
 if (!(raw instanceof Date) && (typeof raw !== 'string' || !local && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw))) throw new SmsError(400, '请选择有效的比赛公开时间');
 if (typeof raw === 'string') {
  const [year,month,day]=raw.slice(0,10).split('-').map(Number);
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())throw new SmsError(400,'请选择有效的比赛公开时间');
 }
 const at = new Date(local ? `${raw}:00+08:00` : raw as string | Date);
 if (!Number.isFinite(+at) || at.getUTCFullYear() < 2000 || at.getUTCFullYear() > 9998 || local && new Date(+at + 8 * 3600000).toISOString().slice(0,16) !== raw) throw new SmsError(400, '请选择有效的比赛公开时间');
 return { visibility: 'until', visibleAt: at };
}
export function visibilityLabel(exam: VisibilitySettings, now = Date.now()) {
 if (!examHidden(exam, now)) return '';
 if (exam.visibility === 'hidden') return '保持隐藏';
 if (!exam.visibleAt || !Number.isFinite(+new Date(exam.visibleAt))) return '已隐藏';
 return `${new Date(+new Date(exam.visibleAt) + 8 * 3600000).toISOString().slice(0,16).replace('T',' ')} 前隐藏（北京时间）`;
}
