/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
// Deliberately bounded phrase matching: arbitrary substrings (UUID, username,
// parent names, old/new UID, etc.) must never silently select a different field.
const prefixes: Record<string, string[]> = {
  hydroUid: ['hydro', 'oj', '平台', '系统', '学生', '学员', '用户', '账号', '账户'],
  name: ['学生', '学员', '本人', '真实', '中文', '用户', 'student', 'real', 'full'],
  gender: ['学生', '学员', '本人', 'student'], grade: ['学生', '学员', '就读', '当前', '所在', 'student', 'current'],
  school: ['学生', '学员', '就读', '当前', '所在', '所属', '毕业', 'student', 'current'],
  status: ['学生', '学员', '当前', '计划', 'student', 'current'],
  enrollmentDate: ['学生', '学员', 'student'], currentStage: ['学生', '学员', '当前', 'student', 'current'],
  rating: ['学生', '学员', '当前', '最后', '最终', 'oj', 'hydro', 'current', 'final'],
  ratingRecordedAt: ['学生', '学员', '最后', '最近', '最终', 'rating'], accountMode: ['导入', '学生'],
  domainId: ['所属', '所在', '目标'], title: ['计划', '本次'], teacherUid: ['任课', '任教', 'hydro', 'oj'],
  from: ['计划', '排课'], to: ['计划', '排课'], weekdays: ['上课', '排课'],
  start: ['计划', '排课'], end: ['计划', '排课'], location: ['上课', '授课'], color: ['卡片', '排课'], remark: ['排课', '课程'],
};
const suffixes: Record<string, string[]> = {
  hydroUid: ['编号', 'number'], name: ['信息'], gender: ['信息'], school: ['名称', 'name', '信息'],
  grade: ['信息'], status: ['信息'], enrollmentDate: ['信息'], currentStage: ['信息'],
  rating: ['分数', '得分', '数值', 'score'], ratingRecordedAt: ['信息'], accountMode: ['方式'],
};
function normalize(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/^\uFEFF/, '')
    .replace(/\((?:必填|选填|可选|必须|请填写|required|optional)\)/g, '')
    .replace(/[\s_\-—·.:：/\\()[\]【】*]+/g, '');
}
function decorations(value: string, words: string[]): boolean {
  if (!value) return true;
  // Memoized segmentation bounds work even for repeated/overlapping modifiers.
  const reachable = new Set([0]);
  for (let i = 0; i < value.length; i++) if (reachable.has(i)) for (const word of words) if (value.startsWith(word, i)) reachable.add(i + word.length);
  return reachable.has(value.length);
}
export function inferImportHeaders(headers: string[], aliases: Record<string, string[]>) {
  const candidates = headers.map(header => {
    const h = normalize(header); if (!h || h.length > 100) return [];
    const exact = Object.entries(aliases).filter(([, names]) => names.some(n => normalize(n) === h)).map(([key]) => key);
    if (exact.length) return exact;
    return Object.entries(aliases).filter(([key, names]) => names.some(name => {
      const alias = normalize(name);
      // These very broad aliases remain supported only as complete headers.
      if (['学生', '教师', '名称'].includes(alias)) return false;
      let pos = h.indexOf(alias);
      while (pos >= 0) {
        if (decorations(h.slice(0, pos), prefixes[key] ?? []) && decorations(h.slice(pos + alias.length), suffixes[key] ?? [])) return true;
        pos = h.indexOf(alias, pos + 1);
      }
      return false;
    })).map(([key]) => key);
  });
  const mapping: Record<string, number> = {}; const warnings: string[] = [];
  headers.forEach((header, n) => { if (candidates[n].length > 1) warnings.push(`第 ${n + 1} 列「${header}」含多个字段含义，请手动指定列对应`); });
  for (const key of Object.keys(aliases)) {
    const columns = candidates.flatMap((keys, n) => keys.includes(key) ? [n] : []);
    if (columns.length === 1 && candidates[columns[0]].length === 1) mapping[key] = columns[0];
    else if (columns.length > 1) warnings.push(`「${headers[columns[0]]}」等 ${columns.length} 列可能对应同一字段，请手动选择`);
  }
  return { mapping, mappingWarnings: warnings };
}
