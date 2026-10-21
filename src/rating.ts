/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { RatingEngine, legacySmsRatingEngine } from './rating-engine';
import { randomUUID } from 'node:crypto';
import { Db } from 'mongodb';
import { StudentService } from './service';
import { SmsError } from './types';
import { object, positiveInt, text } from './validation';
import { BANDS, DIFFICULTIES, TITLES, Difficulty, Participant, RatingState, changeBucket, ratingTitle, round } from './rating-core';
export interface RatingSource {
    key: string;
    kind: 'import' | 'contest';
    at: string;
    uid?: number;
    rating?: number;
    domainId?: string;
    contestId?: string;
    title?: string;
    difficulty?: Difficulty;
    penalty?: boolean;
    participants?: Participant[];
}
interface Head {
    _id: string;
    generation: string;
    revision: number;
    engine?: string;
    lock?: string;
    lockUntil?: Date;
    updatedAt?: Date;
}
interface StoredSource extends RatingSource {
    _id: string;
    generation: string;
}
interface Summary {
    _id: string;
    generation: string;
    uid: number;
    rating: number;
    contests: number;
    peak: number;
    records: number;
    updatedAt: string;
}
interface Change {
    order?: number;
    _id: string;
    generation: string;
    uid: number;
    source: string;
    kind: 'import' | 'contest';
    at: string;
    title: string;
    difficulty?: Difficulty;
    before: number;
    after: number;
    delta: number;
    rank: number | null;
    participants: number | null;
    factor?: number;
}
export interface ContestGateway {
    snapshot(domainId: string, contestId: string, difficulty: Difficulty): Promise<RatingSource | null>;
}
export function recordTime(value: unknown) {
    const s = text(value, 40, '记录时间');
    if (!/^\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)?)?$/.test(s))
        throw new SmsError(400, '记录时间格式无效');
    const raw = s.replace(' ', 'T'), day = raw.slice(0, 10), date = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day)
        throw new SmsError(400, '记录日期无效');
    // Legacy sms_system timestamps are in Beijing local time. Explicit offsets win.
    const withTime = raw.length === 10 ? `${raw}T00:00:00` : raw;
    const time = /T(\d\d):(\d\d)(?::(\d\d))?/.exec(withTime);
    if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? 0) > 59))
        throw new SmsError(400, '记录时间无效');
    const result = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(withTime) ? withTime : `${withTime}+08:00`);
    if (!Number.isFinite(result.getTime()) || result.getTime() > Date.now() + 60000)
        throw new SmsError(400, '记录时间无效或晚于当前时间');
    return result.toISOString();
}
export class RatingService {
    constructor(private db: Db, private students: StudentService, private gateway?: ContestGateway, private invalidate: () => void = () => { }, private engine: RatingEngine = legacySmsRatingEngine) { }
    get heads() { return this.db.collection<Head>('sms_rating_head'); }
    get sources() { return this.db.collection<StoredSource>('sms_rating_sources'); }
    get summaries() { return this.db.collection<Summary>('sms_rating_summaries'); }
    get changes() { return this.db.collection<Change>('sms_rating_changes'); }
    async init() {
        await this.heads.updateOne({ _id: 'global' }, { $setOnInsert: { generation: 'initial', revision: 0 } }, { upsert: true });
        await this.sources.createIndex({ generation: 1, key: 1 }, { unique: true });
        await this.summaries.createIndex({ generation: 1, uid: 1 }, { unique: true });
        await this.changes.createIndex({ generation: 1, uid: 1, at: -1 });
    }
    async head() { return (await this.heads.findOne({ _id: 'global' }))!; }
    async allSources(generation: string) { return (await this.sources.find({ generation }).toArray()).map(({ _id, generation, ...s }) => s); }
    // Full immutable generations keep readers on the last complete result even on
    // standalone MongoDB. Publish sources, summaries and history with one CAS.
    async mutate(actor: number, action: string, work: (sources: RatingSource[]) => Promise<RatingSource[]>, expected?: number) {
        const token = randomUUID(), now = new Date(), head = await this.head();
        if (expected !== undefined && head.revision !== expected)
            throw new SmsError(409, 'Rating 已更新，请刷新后重试');
        const locked = await this.heads.findOneAndUpdate({ _id: 'global', revision: head.revision, $or: [{ lock: { $exists: false } }, { lockUntil: { $lt: now } }] }, { $set: { lock: token, lockUntil: new Date(+now + 600000) } }, { returnDocument: 'after' });
        if (!locked)
            throw new SmsError(409, 'Rating 正在更新，请稍后重试');
        try {
            const old = await this.allSources(head.generation), next = await work(old);
            if (head.engine === this.engine.id && JSON.stringify(old) === JSON.stringify(next))
                return { revision: head.revision, changed: false };
            return await this.students.mutation(actor, action, 'rating', [], async () => {
                const generation = randomUUID(), states = new Map<number, RatingState>(), changes: Change[] = [], summaries = new Map<number, Summary>();
                const ordered = [...next].sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind === 'import' ? -1 : 1));
                for (const s of ordered) {
                    if (s.kind === 'import') {
                        const before = states.get(s.uid!)?.rating ?? s.rating!;
                        states.set(s.uid!, { rating: s.rating!, contests: Math.max(1, states.get(s.uid!)?.contests ?? 0) });
                        changes.push({ _id: `${generation}:${s.key}`, generation, uid: s.uid!, source: s.key, kind: 'import', at: s.at, title: '历史导入', before, after: s.rating!, delta: round(s.rating! - before, 2), rank: null, participants: null });
                    }
                    else {
                        for (const c of this.engine.calculate(s.participants ?? [], states, s.difficulty!, !!s.penalty)) {
                            states.set(c.uid, { rating: c.after, contests: c.contests });
                            changes.push({ _id: `${generation}:${s.key}:${c.uid}`, generation, uid: c.uid, source: s.key, kind: 'contest', at: s.at, title: s.title || '比赛', difficulty: s.difficulty, before: c.before, after: c.after, delta: c.delta, rank: c.rank, participants: c.participants, factor: c.factor });
                        }
                    }
                }
                for (const c of changes) {
                    const prev = summaries.get(c.uid);
                    summaries.set(c.uid, { _id: `${generation}:${c.uid}`, generation, uid: c.uid, rating: c.after, contests: (prev?.contests ?? 0) + (c.kind === 'contest' ? 1 : 0), peak: Math.max(prev?.peak ?? 0, c.after), records: (prev?.records ?? 0) + 1, updatedAt: c.at });
                }
                if (next.length)
                    await this.sources.insertMany(next.map(s => ({ ...s, _id: `${generation}:${s.key}`, generation })));
                changes.forEach((change, index) => { change.order = index; });
                if (changes.length)
                    await this.changes.insertMany(changes);
                if (summaries.size)
                    await this.summaries.insertMany([...summaries.values()]);
                const published = await this.heads.updateOne({ _id: 'global', revision: head.revision, lock: token }, { $set: { generation, engine: this.engine.id, updatedAt: new Date() }, $inc: { revision: 1 }, $unset: { lock: '', lockUntil: '' } });
                if (!published.modifiedCount)
                    throw new SmsError(409, 'Rating 更新冲突，请重新提交');
                this.invalidate();
                return { revision: head.revision + 1, changed: true };
            });
        }
        finally {
            await this.heads.updateOne({ _id: 'global', lock: token }, { $unset: { lock: '', lockUntil: '' } });
        }
    }
    async importRecords(actor: number, input: unknown) {
        await this.students.requireAdmin(actor);
        const body = object(input);
        if (!Array.isArray(body.records) || !body.records.length || body.records.length > 500)
            throw new SmsError(400, '每次导入 1–500 条记录');
        const records = body.records.map((v: unknown, index: number) => { const r = object(v), uid = positiveInt(r.uid, 'UID'); if (typeof r.rating !== 'number' || !Number.isFinite(r.rating) || r.rating < 0 || r.rating > 100000)
            throw new SmsError(400, `第 ${index + 1} 条 Rating 无效`); return { key: `import:${uid}:${recordTime(r.recordedAt)}`, kind: 'import' as const, at: recordTime(r.recordedAt), uid, rating: round(r.rating, 2) }; });
        const uids = [...new Set(records.map(r => r.uid))], bound = await this.students.students.find({ hydroUid: { $in: uids } }, { projection: { hydroUid: 1 } }).toArray();
        const accounts = await this.db.collection<{
            _id: number;
        }>('user').find({ _id: { $in: uids } }, { projection: { _id: 1 } }).toArray();
        if (bound.length !== uids.length || accounts.length !== uids.length)
            throw new SmsError(400, '导入 UID 必须对应已绑定档案的学生账号');
        const head = await this.head(), previous = await this.allSources(head.generation), map = new Map(previous.map(s => [s.key, s]));
        let added = 0;
        for (const r of records) {
            const prior = map.get(r.key);
            if (prior && prior.rating !== r.rating)
                throw new SmsError(409, `UID ${r.uid} 同一时间已有不同分数`);
            if (!prior) {
                map.set(r.key, r);
                added++;
            }
        }
        if (body.preview === true)
            return { revision: head.revision, received: records.length, added, duplicates: records.length - added, records: records.slice(0, 20) };
        const revision = body.revision;
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
            throw new SmsError(400, '请先预览导入数据');
        const result = await this.mutate(actor, 'rating.import', async () => [...map.values()], revision);
        return { ...result, received: records.length, added, duplicates: records.length - added };
    }
    async configList(actor: number) {
        await this.students.requireAdmin(actor);
        const head = await this.head();
        const contests = await this.db.collection('document').find({ docType: 30, rule: { $in: ['oi', 'ioi', 'acm', 'strictioi'] } }).sort({ beginAt: -1 }).limit(200).project({ docId: 1, domainId: 1, title: 1, beginAt: 1, endAt: 1, rule: 1, rated: 1 }).toArray();
        const configs = await this.db.collection<{
            _id: string;
            difficulty: Difficulty;
            enabled: boolean;
            error?: string;
        }>('sms_rating_contests').find({}).toArray();
        const sources = await this.sources.find({ generation: head.generation, kind: 'contest' }).toArray();
        return { revision: head.revision, difficulties: DIFFICULTIES, bands: BANDS, contests: contests.map(c => { const key = `${c.domainId}:${c.docId}`, config = configs.find(k => k._id === key), source = sources.find(s => s.key === `contest:${key}`); return { id: String(c.docId), domainId: c.domainId, title: c.title, endAt: c.endAt, rule: c.rule, enabled: config?.enabled ?? false, difficulty: config?.difficulty ?? 'CSP-J', settled: !!source, participants: source?.participants?.length ?? 0, error: config?.error ?? '' }; }) };
    }
    async configure(actor: number, input: unknown) {
        await this.students.requireAdmin(actor);
        const b = object(input), domainId = text(b.domainId, 160, '子域 ID'), contestId = text(b.contestId, 24, '比赛 ID');
        if (!/^[a-f\d]{24}$/i.test(contestId) || !DIFFICULTIES.includes(b.difficulty as Difficulty) || typeof b.enabled !== 'boolean')
            throw new SmsError(400, '比赛配置无效');
        const doc = await this.db.collection('document').findOne({ docType: 30, domainId, docId: (await import('mongodb')).ObjectId.createFromHexString(contestId) });
        if (!doc)
            throw new SmsError(404, '比赛不存在');
        if (!['oi', 'ioi', 'acm', 'strictioi'].includes(doc.rule))
            throw new SmsError(400, '此赛制暂不支持 Rating');
        await this.students.mutation(actor, 'rating.configure', `${domainId}:${contestId}`, ['difficulty', 'enabled'], async () => this.db.collection<{
            _id: string;
        }>('sms_rating_contests').updateOne({ _id: `${domainId}:${contestId}` }, { $set: { domainId, contestId, difficulty: b.difficulty, enabled: b.enabled, updatedBy: actor, updatedAt: new Date() } }, { upsert: true }));
        await this.sync(actor);
        return { saved: true };
    }
    async sync(actor = 0) {
        if (!this.gateway)
            return;
        const configs = await this.db.collection<{
            _id: string;
            domainId: string;
            contestId: string;
            difficulty: Difficulty;
            enabled: boolean;
        }>('sms_rating_contests').find({}).sort({ _id: 1 }).toArray();
        if (!configs.length)
            return;
        const snapshots: RatingSource[] = [];
        for (const c of configs) {
            if (!c.enabled)
                continue;
            try {
                const s = await this.gateway.snapshot(c.domainId, c.contestId, c.difficulty);
                if (s)
                    snapshots.push(s);
                await this.db.collection('sms_rating_contests').updateOne({ _id: c._id as any }, { $unset: { error: '' } });
            }
            catch (e) {
                await this.db.collection('sms_rating_contests').updateOne({ _id: c._id as any }, { $set: { error: e instanceof Error ? e.message : '比赛读取失败' } });
                throw e;
            }
        }
        await this.mutate(actor, 'rating.recalculate', async (old) => [...old.filter(s => s.kind === 'import'), ...snapshots].sort((a, b) => a.key.localeCompare(b.key)));
    }
    async summary(uid: number) { const h = await this.head(); const s = await this.summaries.findOne({ generation: h.generation, uid }); return this.present(s); }
    present(s: Summary | null) { const r = s?.rating ?? 0; return { rating: r, rated: !!s, contests: s?.contests ?? 0, peak: s?.peak ?? 0, records: s?.records ?? 0, updatedAt: s?.updatedAt ?? null, ...ratingTitle(r, !!s) }; }
    async history(uidValue: unknown, pageValue: unknown = 1) {
        const uid = positiveInt(Number(uidValue), 'UID'), page = positiveInt(Number(pageValue), '页码');
        if (page > 100000)
            throw new SmsError(400, '页码无效');
        const user = await this.db.collection<{
            _id: number;
            uname: string;
        }>('user').findOne({ _id: uid }, { projection: { uname: 1 } });
        if (!user)
            throw new SmsError(404, '账号不存在');
        const h = await this.head(), filter = { generation: h.generation, uid }, summary = await this.summaries.findOne(filter), total = await this.changes.countDocuments(filter);
        const rows = await this.changes.find(filter).sort({ at: -1, order: -1 }).skip((page - 1) * 20).limit(20).toArray();
        const trend = await this.changes.find(filter).sort({ at: 1, order: 1 }).project({ at: 1, after: 1 }).toArray();
        const recent = await this.changes.find({ ...filter, at: { $gte: new Date(Date.now() - 30 * 86400000).toISOString() } }).toArray();
        return { uid, username: user.uname, ...this.present(summary), recent: changeBucket(recent), total, page, pageSize: 20, history: rows.map(({ _id, generation, ...c }) => c), trend: trend.map(c => ({ at: c.at, rating: c.after })) };
    }
    async board(domainId: string, query: unknown = '', pageValue: unknown = 1, mode: unknown = 'all', gradeValue: unknown = '', schoolValue: unknown = '') {
        const q = text(query ?? '', 80, '搜索词'), grade = text(gradeValue ?? '', 160, '年级'), school = text(schoolValue ?? '', 160, '学校'), page = positiveInt(Number(pageValue), '页码');
        if (page > 100000)
            throw new SmsError(400, '页码无效');
        if (!['all', 'recent'].includes(String(mode)))
            throw new SmsError(400, '榜单类型无效');
        const h = await this.head(), members = await this.db.collection('domain.user').find({ domainId, join: true, uid: { $gt: 0 } }, { projection: { uid: 1 } }).toArray();
        const ids = members.map(m => m.uid);
        const users = await this.db.collection<{
            _id: number;
            uname: string;
        }>('user').find({ _id: { $in: ids } }, { projection: { uname: 1 } }).toArray();
        const summaries = await this.summaries.find({ generation: h.generation, uid: { $in: ids } }).toArray();
        const recent = await this.changes.find({ generation: h.generation, uid: { $in: ids }, at: { $gte: new Date(Date.now() - 30 * 86400000).toISOString() } }).toArray();
        const grouped = new Map<number, Change[]>();
        for (const c of recent) {
            const list = grouped.get(c.uid) ?? [];
            list.push(c);
            grouped.set(c.uid, list);
        }
        // Basic student fields are used only as predicates; never publish private names.
        let allowed: Set<number> | undefined;
        if (grade || school) {
            const students = await this.students.students.find({ ...grade ? { 'basic.grade': grade } : {}, ...school ? { 'basic.school': school } : {} }, { projection: { hydroUid: 1 } }).toArray();
            allowed = new Set(students.map(s => s.hydroUid!).filter(Boolean));
        }
        const summaryMap = new Map(summaries.map(s => [s.uid, s]));
        const all = users.filter(u => (!allowed || allowed.has(u._id)) && (!q || u.uname.toLowerCase().includes(q.toLowerCase()) || String(u._id) === q)).map(u => ({ uid: u._id, username: u.uname, ...this.present(summaryMap.get(u._id) ?? null), recent: changeBucket(grouped.get(u._id) ?? []) })).sort((a, b) => (mode === 'recent' ? b.recent.delta - a.recent.delta : 0) || b.rating - a.rating || b.contests - a.contests || a.username.localeCompare(b.username));
        let rank = 0;
        const ranked = all.map((u, i) => { if (!i || (mode === 'recent' ? u.recent.delta !== all[i - 1].recent.delta || u.rating !== all[i - 1].rating : u.rating !== all[i - 1].rating))
            rank = i + 1; return { ...u, rank: u.rated ? rank : null }; });
        return { total: all.length, page, pageSize: 20, mode, revision: h.revision, stats: { rated: all.filter(u => u.rated).length, highest: Math.max(0, ...all.map(u => u.rating)), average: round(all.filter(u => u.rated).reduce((s, u) => s + u.rating, 0) / Math.max(1, all.filter(u => u.rated).length), 2), tiers: TITLES.map(t => ({ title: t.title, count: all.filter(u => u.rated && u.key === t.key).length })) }, users: ranked.slice((page - 1) * 20, page * 20) };
    }
}
