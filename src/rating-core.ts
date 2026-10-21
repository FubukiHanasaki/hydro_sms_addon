/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
 * Port of sms_system/handlers/rating_core.py. Keep formulas and order unchanged.
 */
export const DIFFICULTIES = ['入门', 'CSP-J', 'CSP-S', 'NOIP', '省选/NOI'] as const;
export type Difficulty = typeof DIFFICULTIES[number];
export const BANDS = [[1000, 1299, 1399], [1300, 1899, 2100], [1900, 2499, 2700], [2100, 2699, 2999], [2700, 3500, 3600]];
const INITIALS = [900, 1400, 1600, 1700, 1800];
const EARLY = [.35, .5, .65, .75, .82, .88];
export const TITLES = [
    { min: 3000, title: 'Legendary Grandmaster', key: 'legendary-grandmaster', color: '#c62828' },
    { min: 2600, title: 'Grandmaster', key: 'grandmaster', color: '#c62828' },
    { min: 2300, title: 'Legendary Master', key: 'legendary-master', color: '#a85d00' },
    { min: 2100, title: 'Master', key: 'master', color: '#a85d00' },
    { min: 1900, title: 'Candidate Master', key: 'candidate-master', color: '#9634a3' },
    { min: 1800, title: 'Ace Expert', key: 'ace-expert', color: '#2456c4' },
    { min: 1600, title: 'Expert', key: 'expert', color: '#2456c4' },
    { min: 1400, title: 'Specialist', key: 'specialist', color: '#087f8c' },
    { min: 1200, title: 'Pupil', key: 'pupil', color: '#278036' },
    { min: 0, title: 'Newbie', key: 'newbie', color: '#666666' },
];
export function ratingTitle(rating: number, rated = true) {
    return rated ? TITLES.find(t => rating >= t.min) ?? TITLES[TITLES.length - 1] : { min: 0, title: '未评级', key: 'unrated', color: '#777777' };
}
export function normalizeDifficulty(value: unknown): Difficulty {
    const text = String(value ?? '').trim();
    if (DIFFICULTIES.includes(text as Difficulty))
        return text as Difficulty;
    const upper = text.toUpperCase().replace(/ /g, '');
    const alias: Record<string, Difficulty> = { INTRO: '入门', BEGINNER: '入门', CSPJ: 'CSP-J', 'CSP-J': 'CSP-J', CSPS: 'CSP-S', 'CSP-S': 'CSP-S', NOIP: 'NOIP', NOI: '省选/NOI', '省选': '省选/NOI', '省选/NOI': '省选/NOI', '省选NOI': '省选/NOI' };
    if (alias[upper])
        return alias[upper];
    if (text.includes('省选') || upper.includes('NOI'))
        return '省选/NOI';
    return DIFFICULTIES.find(k => text.includes(k)) ?? 'CSP-J';
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
// Python round uses ties-to-even; contest delta arithmetic truncates toward zero.
export function round(x: number, digits = 0) {
    if (!Number.isFinite(x) || x === 0)
        return x || 0;
    const bytes = new DataView(new ArrayBuffer(8));
    bytes.setFloat64(0, Math.abs(x));
    const bits = bytes.getBigUint64(0), encoded = Number((bits >> 52n) & 2047n);
    const mantissa = (bits & ((1n << 52n) - 1n)) | (encoded ? 1n << 52n : 0n);
    const exponent = (encoded || 1) - 1023 - 52;
    let numerator = mantissa * 10n ** BigInt(digits), denominator = 1n;
    if (exponent >= 0)
        numerator <<= BigInt(exponent);
    else
        denominator <<= BigInt(-exponent);
    let result = numerator / denominator;
    const remainder = numerator % denominator;
    if (remainder * 2n > denominator || (remainder * 2n === denominator && result % 2n))
        result++;
    return Math.sign(x) * Number(result) / 10 ** digits || 0;
}
// Acklam's inverse normal CDF, absolute error < 1.2e-9 in the used quantiles.
function normalQuantile(p: number): number {
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
    const c = [-.00778489400243029, -.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
    const d = [.00778469570904146, .32246712907004, 2.445134137143, 3.75440866190742];
    if (p < .02425 || p > 1 - .02425) {
        const q = Math.sqrt(-2 * Math.log(p < .5 ? p : 1 - p));
        const n = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
        return p < .5 ? n : -n;
    }
    const q = p - .5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
export interface RatingState {
    rating: number;
    contests: number;
}
export interface Participant {
    uid: number;
    score: number;
    scoreRate?: number;
    rank?: number;
    duration?: number | null;
    absent?: boolean;
}
export interface RatingChange {
    uid: number;
    before: number;
    after: number;
    delta: number;
    rank: number;
    participants: number;
    factor: number;
    contests: number;
}
export function winProbability(a: number, b: number) { const d = (b - a) / 400; return d >= 8 ? 0 : d <= -8 ? 1 : 1 / (1 + 10 ** d); }
export function seedForRating(r: number, others: number[]) { return 1 + others.reduce((s, o) => s + winProbability(o, r), 0); }
export function ratingToRank(rank: number, others: number[]) {
    if (!others.length)
        return 1600;
    let lo = Math.min(-10000, Math.min(...others) - 2000), hi = Math.max(10000, Math.max(...others) + 2000);
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (seedForRating(mid, others) > rank)
            lo = mid;
        else
            hi = mid;
        if (Math.abs(hi - lo) <= 1e-7)
            break;
    }
    return (lo + hi) / 2;
}
function tierIndex(rating: number) {
    const inRange = BANDS.map(([lo, hi], idx) => ({ idx, dist: Math.abs(rating - (lo + hi) / 2), inRange: rating >= lo && rating <= hi }));
    const pool = inRange.some(b => b.inRange) ? inRange.filter(b => b.inRange) : inRange;
    return pool.sort((a, b) => a.dist - b.dist || a.idx - b.idx)[0].idx;
}
// Fit rank quantiles against compressed standard scores, then blend with score-rate targets.
function performance(participants: Participant[], idx: number) {
    const [lo, hi] = BANDS[idx], middle = (lo + hi) / 2, n = participants.length, scores = participants.map(p => p.score);
    const mean = scores.reduce((a, b) => a + b, 0) / n, std = Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / n), max = Math.max(...scores);
    const raw = participants.map(p => { const rank = clamp(p.rank || 1, 1, n), x = normalQuantile(clamp(1 - (rank - .5) / n, 1e-4, 1 - 1e-4)); return { uid: p.uid, x, y: .9 * Math.tanh((std > 1e-9 ? (p.score - mean) / std : 0) / .9), rate: clamp(p.scoreRate ?? (max > 0 ? round(p.score / max * 100, 2) : 0), 0, 100) }; });
    const mx = raw.reduce((s, p) => s + p.x, 0) / n, my = raw.reduce((s, p) => s + p.y, 0) / n, vx = raw.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    const slope = clamp(vx <= 1e-9 ? 1 : raw.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / vx, .05, 3), intercept = my - slope * mx;
    return new Map(raw.map(p => {
        const blended = .9 * Math.tanh((.55 * (intercept + slope * p.x) + .45 * p.y) / .9), rate = 50 + 35 * Math.tanh((p.rate - 50) / 35);
        const target = round(clamp(rate >= 70 ? middle + (rate - 70) / 30 * (hi - middle) : lo + rate / 70 * (middle - lo), lo, hi), 2);
        return [p.uid, { placement: round(clamp(1 + blended * .12, .45, 1.25), 4), estimated: round(clamp(.6 * target + .4 * clamp(middle + blended * Math.max(1, hi - lo) / 2.8, lo, hi), lo, hi), 2) }];
    }));
}
export function calculateContest(input: readonly Participant[], states: ReadonlyMap<number, RatingState>, difficulty: Difficulty, penalty = false): RatingChange[] {
    const participants = input.filter(p => !p.absent).map(p => ({ ...p }));
    if (!participants.length)
        return [];
    participants.sort((a, b) => b.score - a.score || (penalty ? (a.duration ?? 2147483647) - (b.duration ?? 2147483647) : 0) || a.uid - b.uid);
    let rank = 0, previous: Participant | undefined;
    participants.forEach((p, i) => { if (!previous || previous.score !== p.score || (penalty && previous.duration !== p.duration))
        rank = i + 1; const explicit = p.rank; p.rank = explicit && explicit > 0 ? explicit : rank; previous = p; });
    const idx = DIFFICULTIES.indexOf(difficulty), cap = BANDS[idx][2];
    const old = new Map(participants.map(p => [p.uid, (states.get(p.uid)?.contests ?? 0) > 0 ? states.get(p.uid)!.rating : INITIALS[idx]]));
    const profiles = performance(participants, idx), deltas = new Map<number, number>();
    for (const p of participants) {
        const r = old.get(p.uid)!, others = participants.filter(o => o.uid !== p.uid).map(o => old.get(o.uid)!);
        deltas.set(p.uid, others.length ? Math.trunc((ratingToRank(Math.sqrt(p.rank! * seedForRating(r, others)), others) - r) / 2) : 0);
    }
    // First remove global inflation, then apply the old top-group correction.
    const n = participants.length, inc1 = Math.trunc(-[...deltas.values()].reduce((a, b) => a + b, 0) / n) - 1;
    for (const p of participants)
        deltas.set(p.uid, deltas.get(p.uid)! + inc1);
    const topCount = Math.min(n, Math.max(1, 4 * round(Math.sqrt(n)))), top = [...participants].sort((a, b) => old.get(b.uid)! - old.get(a.uid)!).slice(0, topCount);
    const inc2 = clamp(Math.trunc(-top.reduce((s, p) => s + deltas.get(p.uid)!, 0) / topCount), -10, 0);
    return participants.map(p => {
        const before = old.get(p.uid)!, count = states.get(p.uid)?.contests ?? 0, base = deltas.get(p.uid)! + inc2, mismatch = idx - tierIndex(before);
        // Difficulty mismatch, placement fit, gap pull, early-contest damping and caps.
        let factor = 1;
        if (mismatch > 0)
            factor = base > 0 ? Math.min(2.8, 1 + .45 * mismatch) : Math.max(.12, 1 - .32 * mismatch);
        else if (mismatch < 0)
            factor = base > 0 ? 0 : Math.min(2.2, 1 + .32 * Math.abs(mismatch));
        const profile = profiles.get(p.uid)!, gap = profile.estimated - before, abs = Math.abs(gap), gain = (.008 + Math.min(.025, abs / 1500 * .025)) / Math.sqrt(Math.max(1, count + 1)), maxStep = round(8 + Math.min(24, abs * .02));
        const pull = clamp(Math.trunc(gap * gain), -maxStep, maxStep), placement = Math.trunc(Math.trunc(base * factor) * profile.placement);
        let delta = Math.trunc((placement + pull) * (EARLY[Math.max(0, count)] ?? 1));
        if (mismatch < 0 && delta > 0)
            delta = 0;
        const after = round(Math.max(0, delta > 0 ? Math.min(before + delta, cap) : before + delta), 2), actual = Math.trunc(after - before);
        const result = { uid: p.uid, before, after, delta: actual, rank: p.rank!, participants: n, factor: base === 0 ? (actual === 0 ? 1 : 0) : round(actual / base, 4), contests: count + 1 };
        return result;
    });
}
export function changeBucket(changes: {
    delta: number;
}[]) {
    const sum = round(changes.reduce((s, c) => s + c.delta, 0), 2), positive = changes.some(c => c.delta > .5), negative = changes.some(c => c.delta < -.5);
    const key = positive && negative ? 'volatile' : sum >= 8 ? 'up' : sum <= -8 ? 'down' : 'flat';
    return { delta: sum, records: changes.length, key, text: ({ volatile: '波动', up: '进步', down: '退步', flat: '持平' })[key] };
}
