/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { ObjectId } from 'mongodb';
import { Context, ContestModel, PERM, ForbiddenError } from 'hydrooj';
import { RatingService, ContestGateway } from './rating';
import { OrganizationService } from './organization';
import { SmsError } from './types';
export function hydroContestGateway(ctx: Context): ContestGateway {
    return { async snapshot(domainId, contestId, difficulty) {
            const tid = new ObjectId(contestId);
            const offline = await ctx.db.db.collection('offline_judge_contests').findOne({ _id: `${domainId}:${contestId}` as any });
            if (offline && offline.state !== 'complete') throw new SmsError(409, '离线赛正式代码尚未完成导入评测');
            if (!await ctx.db.db.collection('document').findOne({ docType: 30, domainId, docId: tid }, { projection: { _id: 1 } }))
                return null;
            const tdoc = await ContestModel.get(domainId, tid);
            if (!tdoc)
                return null;
            if (new Date(tdoc.endAt).getTime() > Date.now())
                return null;
            if (await ctx.db.db.collection('record').findOne({ domainId, contest: tid, status: { $in: [0, 20, 21, 22] } }))
                throw new SmsError(409, '比赛仍有待评测提交');
            const rule = ContestModel.RULES[tdoc.rule];
            if (!rule || !['oi', 'ioi', 'strictioi', 'acm'].includes(tdoc.rule))
                throw new SmsError(400, '此赛制暂不支持 Rating');
            // Official standings resolve all submission/penalty rules. Exclude unranked
            // accounts and attendees with no submissions, as absent scores in sms_system.
            const cursor = ContestModel.getMultiStatus(domainId, { docId: tid, journal: { $exists: true, $ne: [] }, unrank: { $ne: true }, uid: { $gt: 0 } }).sort(rule.statusSort);
            const ranked = await rule.ranked(tdoc, cursor);
            const fullScore = tdoc.pids.reduce((total: number, pid: number) => total + (tdoc.score?.[pid] || 100), 0);
            const participants = ranked.map(([rank, s]: [
                number,
                any
            ]) => ({ uid: s.uid, score: tdoc.rule === 'acm' ? Number(s.accept ?? 0) : Number(s.score ?? 0), scoreRate: tdoc.pids.length ? (tdoc.rule === 'acm' ? Number(s.accept ?? 0) / tdoc.pids.length * 100 : Number(s.score ?? 0) / fullScore * 100) : 0, rank: Number(rank), duration: tdoc.rule === 'acm' ? Number(s.time ?? 0) : null }));
            return { key: `contest:${domainId}:${contestId}`, kind: 'contest', at: new Date(tdoc.endAt).toISOString(), domainId, contestId, title: tdoc.title, difficulty, penalty: tdoc.rule === 'acm', participants };
        } };
}
export function installRating(ctx: Context, rating: RatingService, organization: OrganizationService) {
    const decorate = async (u: any) => { if (!u || typeof u._id !== 'number')
        return; u.smsRating = await rating.summary(u._id); u.rp = u.smsRating.rating; u.level = 0; u.rank = null; };
    // The user/get event runs for a full Hydro user, while render dictionaries may
    // contain plain public documents. Cover both without changing account fields.
    ctx.on('user/get', async (u: any) => { await decorate(u); });
    ctx.on('handler/before-prepare', async (h) => { await decorate(h.user); });
    ctx.on('handler/after', async (h) => {
        if (!h.response.template)
            return;
        const seen = new Set<object>(), users: any[] = [];
        const visit = (v: any, depth: number) => { if (!v || typeof v !== 'object' || seen.has(v) || depth > 5)
            return; seen.add(v); if (typeof v._id === 'number' && typeof v.uname === 'string') {
            users.push(v);
            return;
        } for (const [k, item] of Object.entries(v))
            if (!k.startsWith('_'))
                visit(item, depth + 1); };
        visit(h.response.body, 0);
        await Promise.all(users.map(decorate));
    });
    ctx.on('handler/before/DomainRank', async (h) => {
        h.checkPerm(PERM.PERM_VIEW_RANKING);
        let scope;
        try { scope = await organization.ratingScope(h.user?._id ?? 0, h.domain._id, h.context.query.classId); }
        catch (error) { if (error instanceof SmsError) throw new ForbiddenError(); throw error; }
        const data = await rating.board(scope.domainId, h.context.query.q, h.context.query.page ?? 1, h.context.query.mode ?? 'all');
        h.response.template = 'sms_ranking.html';
        h.response.body = { page_name: 'ranking', smsBoard: data, smsClassScope: scope, smsRatingApi: h.url('sms_api_rating_history', { uid: 0 }).replace(/\/0$/, '') };
        h.response.addHeader('Cache-Control', 'private, no-store');
        return 'after';
    });
    // Native RP scripts/scheduled tasks must never overwrite the new system.
    const hydro = (globalThis as any).Hydro;
    let originalRp: any;
    const replaceRp = () => { if (hydro.script.rp && !hydro.script.rp.smsRating) {
        originalRp = hydro.script.rp;
        hydro.script.rp = { ...originalRp, smsRating: true, description: 'Recalculate SMS Rating', run: async () => { await rating.sync(); return true; } };
    } };
    ctx.on('app/started', async () => { replaceRp(); });
    ctx.effect(() => { replaceRp(); return () => { if (originalRp)
        hydro.script.rp = originalRp; }; });
    ctx.on('handler/create/http', async (h: any) => {
        replaceRp();
        if (h.constructor.name === 'HomeHandler')
            h.getRanking = async (domainId: string, limit = 50) => {
                if (!h.user.hasPerm(PERM.PERM_VIEW_RANKING))
                    return [];
                const uids: number[] = [];
                let page = 1;
                while (uids.length < Math.min(limit, 200)) {
                    const board = await rating.board(domainId, '', page);
                    uids.push(...board.users.filter(u => u.rated).map(u => u.uid));
                    if (page * 20 >= board.total || !board.users.some(u => u.rated))
                        break;
                    page++;
                }
                const selected = uids.slice(0, limit);
                h.collectUser(selected);
                return selected;
            };
    });
    // Ended contests, rejudges, deletions and backdated edits converge automatically.
    // Errors remain visible on the configuration row; never clear previous results.
    let busy = false;
    const sync = async () => { if (busy)
        return; busy = true; try {
        await rating.sync();
    }
    catch (e) {
        console.error('[hydro-sms-rating]', e instanceof Error ? e.message : e);
    }
    finally {
        busy = false;
    } };
    ctx.effect(() => { const timer = setInterval(() => void sync(), 60000); timer.unref(); return () => clearInterval(timer); });
    for (const event of ['contest/edit', 'contest/del', 'record/judge'])
        ctx.on(event, async () => { void sync(); });
    void sync();
}
