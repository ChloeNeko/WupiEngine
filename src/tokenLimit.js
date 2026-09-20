/**
 * Token-budget truncation planner: the "oldest chat history only" limiter.
 *
 * The generate interceptor receives the CHAT MESSAGE array (a copy used to
 * build the prompt). Everything static (system prompt, character
 * description, persona, lore/world info, author's note) is assembled by
 * the host AFTER interceptors run, so trimming here can only ever remove
 * chat history. This module computes HOW MUCH to trim; it never mutates.
 *
 * Prompt-cache contract (why hysteresis exists): provider-side prompt/KV
 * caches are PREFIX caches. An append-only prompt prefix hits the cache;
 * every time the trim window slides, the prefix changes once and the cache
 * re-primes. So the planner trims the MINIMUM needed to fit the budget,
 * and only when trimming is already forced does it drop a little deeper
 * (to `hysteresis` × budget): one slightly larger miss that buys many
 * subsequent append-only turns, instead of sliding by one message on every
 * generation. Same philosophy as the engine's 2000/1800 prune hysteresis.
 *
 * Pure module; unit-tested in Node.
 */

/** Estimated per-message wrapper overhead (role/name tokens etc.). */
export const MESSAGE_TOKEN_OVERHEAD = 8;

/** When trimming is forced, trim to this fraction of the budget. */
export const TRIM_HYSTERESIS = 0.9;

/**
 * Plan the truncation of a chat for a token budget.
 *
 * @param {number[]} counts per-message TEXT token counts, oldest first
 * @param {number} budget max total tokens (incl. per-message overhead)
 * @param {object} [opts]
 * @param {number} [opts.hysteresis] headroom fraction when forced to trim
 * @param {number} [opts.minKeep] never trim below this many messages
 * @returns {{dropCount: number, included: number, tokens: number}} tokens =
 *          the projected total of what remains (overhead included)
 */
export function planTokenTruncation(counts, budget, { hysteresis = TRIM_HYSTERESIS, minKeep = 1 } = {}) {
    const n = counts.length;
    if (n === 0) {
        return { dropCount: 0, included: 0, tokens: 0 };
    }

    // Suffix sums (overhead included): suffix[i] = tokens of counts[i..n-1].
    const suffix = new Array(n);
    let sum = 0;
    for (let i = n - 1; i >= 0; i--) {
        sum += counts[i] + MESSAGE_TOKEN_OVERHEAD;
        suffix[i] = sum;
    }

    const floorIndex = Math.max(0, n - Math.max(1, minKeep));

    // Minimal trim: drop the oldest messages until the remainder fits.
    let d = 0;
    while (d < floorIndex && suffix[d] > budget) {
        d++;
    }

    // Hysteresis: only when trimming was already forced, drop a little
    // deeper so the window doesn't slide again on the next message.
    if (d > 0) {
        while (d < floorIndex && suffix[d] > budget * hysteresis) {
            d++;
        }
    }

    return { dropCount: d, included: n - d, tokens: suffix[d] };
}

/**
 * A bounded per-text token-count cache. The active tokenizer is fast but
 * not free; chat messages are re-counted on every generation and the texts
 * rarely change, so counts are memoized by content hash.
 */
export class TokenCountCache {
    constructor(limit = 3000) {
        this.limit = limit;
        /** @type {Map<string, number>} */
        this.map = new Map();
    }

    /**
     * @param {string} text
     * @param {(text: string) => Promise<number>} countFn
     * @returns {Promise<number>}
     */
    async get(text, countFn) {
        const key = `${text.length}:${text.slice(0, 64)}\u0000${text.slice(-64)}`;
        // Move-to-end keeps hot entries alive if we ever evict.
        const hit = this.map.get(key);
        if (hit !== undefined) {
            this.map.delete(key);
            this.map.set(key, hit);
            return hit;
        }
        const n = await countFn(text);
        if (this.map.size >= this.limit) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
        this.map.set(key, n);
        return n;
    }

    clear() {
        this.map.clear();
    }
}
