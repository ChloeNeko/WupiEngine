/**
 * Score-aware Reciprocal Rank Fusion (RRF): the merge step of hybrid search.
 *
 * Direct port of WUPI (old) `src-tauri/src/memory_rrf.rs` (including its
 * doc rationale, which still applies):
 *
 *  1. Floor the dense list on an absolute cosine threshold (the rejection
 *     authority against cross-topic bleed).
 *  2. Rank the survivors within each list (position = 1-BASED rank).
 *  3. Fuse via weighted RRF:
 *         score(id) = w_sparse / (k + rank_sparse(id))
 *                   + w_dense  / (k + rank_dense(id))
 *
 * One deliberate representation change from the Rust original: vec0 returned
 * L2 distance and converted at a single point via cos = 1 - d^2/2; this port
 * computes TRUE cosine directly (dot product of unit vectors), so all inputs
 * here are already on the true-cosine axis. Floors compare identically.
 *
 * Pure module: no storage, no embedder, no DOM. Unit-tested in Node.
 */

import { RRF_K } from './constants.js';

/** @typedef {number} MemoryId */

/**
 * Per-list weights for weighted RRF. Only the RATIO matters (RRF is
 * rank-based); defaults 0.5/0.5 = standard RRF.
 */
export class FusionWeights {
    /** @param {number} sparse @param {number} dense */
    constructor(sparse = 0.5, dense = 0.5) {
        this.sparse = sparse;
        this.dense = dense;
    }

    static default() {
        return new FusionWeights(0.5, 0.5);
    }
}

/**
 * Fused result row: id + fused score + per-path diagnostics (the DebugScores
 * port; the debug panel shows WHY each memory was pulled).
 */
export function makeRanked(id, score, debug = {}) {
    return {
        id,
        score,
        debug: {
            denseCosine: debug.denseCosine ?? null,
            denseRank: debug.denseRank ?? null,
            sparseRank: debug.sparseRank ?? null,
        },
    };
}

/**
 * The sparse-path dense-floor gate: verify EVERY sparse (BM25) candidate on
 * TRUE cosine against the query and drop the ones below the same floor the
 * dense list uses. BM25 is a precision-boost on memories that already
 * PASSED the floor, never an independent recall path a lexical bleed can
 * ride.
 *
 * Cosine sources, in order:
 *  1. The candidate is in `dense` (the RAW dense top-k, pre-floor): its
 *     cosine is authoritative. A below-floor dense member is ALSO dropped
 *     from the sparse list: semantically evaluated and rejected, it must
 *     not re-enter through the lexical side door.
 *  2. Sparse-only: `sparseCosines` carries the true cosine against the
 *     candidate's stored vector.
 *
 * Missing-vector policy: DROP (unverifiable candidates don't bypass the gate).
 *
 * @param {[MemoryId, number][]} sparse  (id, bm25 raw score) best-first
 * @param {[MemoryId, number][]} dense   (id, true cosine) best-first, RAW pre-floor
 * @param {Map<MemoryId, number>} sparseCosines  true cosines for sparse-only ids
 * @param {number} denseCosineFloor
 * @returns {[MemoryId, number][]} gated sparse list, order + scores preserved
 */
export function gateSparseOnFloor(sparse, dense, sparseCosines, denseCosineFloor) {
    const denseCos = new Map(dense); // id -> true cosine (raw list, pre-floor)
    const out = [];
    for (const [id, bm25] of sparse) {
        const cosine = denseCos.has(id) ? denseCos.get(id) : sparseCosines.get(id);
        if (cosine !== undefined && cosine >= denseCosineFloor) {
            out.push([id, bm25]);
        }
    }
    return out;
}

/**
 * Fuse two ranked, scored lists into one sorted ranking with a hard dense
 * floor and weighted RRF.
 *
 * @param {[MemoryId, number][]} sparse  (id, bm25) best-first; pre-gated by the caller
 * @param {[MemoryId, number][]} dense   (id, TRUE cosine) best-first, raw pre-floor
 * @param {number} denseCosineFloor     drop dense candidates below this cosine
 * @param {FusionWeights} weights
 * @param {number} limit                truncate fused output to this many
 * @returns {ReturnType<typeof makeRanked>[]} highest fused score first
 */
export function fuseScoredRRF(sparse, dense, denseCosineFloor, weights, limit) {
    // Dense floor: the rejection gate. Rejected candidates never enter the
    // fusion map, so they contribute nothing to any id's score.
    const denseSurvivors = [];
    for (const [id, cosine] of dense) {
        if (cosine >= denseCosineFloor) {
            denseSurvivors.push([id, cosine]);
        }
    }

    // id -> { score, denseRank, sparseRank, denseCosine }
    const acc = new Map();
    const get = (id) => {
        let a = acc.get(id);
        if (!a) {
            a = { score: 0, denseRank: null, sparseRank: null, denseCosine: null };
            acc.set(id, a);
        }
        return a;
    };

    // Sparse contributions (pre-gated by the caller: rank order is input order).
    for (let i = 0; i < sparse.length; i++) {
        const [id] = sparse[i];
        const rank = i + 1; // 1-based
        const a = get(id);
        a.score += weights.sparse / (RRF_K + rank);
        a.sparseRank = rank;
    }

    // Dense contributions (post-floor survivors only; ranks among survivors).
    for (let i = 0; i < denseSurvivors.length; i++) {
        const [id, cosine] = denseSurvivors[i];
        const rank = i + 1; // 1-based, among survivors
        const a = get(id);
        a.score += weights.dense / (RRF_K + rank);
        a.denseRank = rank;
        a.denseCosine = cosine; // debug panel calibration read
    }

    // Sort by fused score desc, tie-break by id ascending (deterministic).
    const ranked = [...acc.entries()].sort((x, y) => {
        const d = y[1].score - x[1].score;
        return d !== 0 ? d : x[0] - y[0];
    });

    return ranked.slice(0, limit).map(([id, a]) => makeRanked(id, a.score, a));
}

// ---------------------------------------------------------------------------
// Scene-proximity tie-breaker
// ---------------------------------------------------------------------------

/**
 * The scene's anchor terms (e.g. present character names). Used ONLY to
 * break EXACT fused-score ties: a memory mentioning the here-and-now lifts
 * above an equal-scored memory that doesn't. Needles shorter than 3
 * CHARACTERS are dropped (one CJK char would be noise).
 */
export class SceneProximityTerms {
    /** @param {string[]} needles */
    constructor(needles = []) {
        this.needles = needles
            .map((n) => String(n ?? '').trim().toLowerCase())
            .filter((n) => [...n].length >= 3);
    }

    /** @param {string} haystackLower */
    mentionsAny(haystackLower) {
        return this.needles.some((n) => haystackLower.includes(n));
    }
}

/**
 * PURE stable re-rank among EXACT fused-score ties: a tied entry whose text
 * mentions a proximity needle lifts above tied non-mentions; non-tied entries
 * NEVER move; ties with equal mention-ness keep id-ascending order.
 *
 * Runs on HYDRATED rows (`row.text` filled after the fuse). Pure; no I/O.
 *
 * @param {{id:number, score:number, text:string}[]} ranked mutated in place
 * @param {SceneProximityTerms|null} proximity
 */
export function applyProximityTieBreak(ranked, proximity) {
    if (!proximity || proximity.needles.length === 0 || ranked.length < 2) {
        return;
    }
    const mention = ranked.map((r) => proximity.mentionsAny(r.text.toLowerCase()));
    const order = ranked.map((_, i) => i).sort((a, b) => {
        const d = ranked[b].score - ranked[a].score;
        if (d !== 0) return d;
        if (mention[b] !== mention[a]) return mention[b] ? 1 : -1;
        return ranked[a].id - ranked[b].id;
    });
    const rearranged = order.map((i) => ranked[i]);
    ranked.length = 0;
    ranked.push(...rearranged);
}
