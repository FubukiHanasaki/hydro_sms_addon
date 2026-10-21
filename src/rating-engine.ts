/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { Difficulty, Participant, RatingChange, RatingState, calculateContest } from './rating-core';
/** No Hydro, MongoDB, clock or I/O dependencies. Input state is read-only. */
export interface RatingEngine {
    readonly id: string;
    calculate(participants: readonly Participant[], states: ReadonlyMap<number, RatingState>, difficulty: Difficulty, penalty: boolean): RatingChange[];
}
export const legacySmsRatingEngine: RatingEngine = {
    id: 'sms-system',
    calculate: calculateContest,
};
