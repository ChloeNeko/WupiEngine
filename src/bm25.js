/**
 * BM25 sparse retrieval: the in-webview stand-in for WUPI's SQLite FTS5
 * mirror table.
 *
 * Same role in the hybrid pipeline: produce a keyword-ranked candidate list
 * (best-first) that RRF fuses with the dense list. Constants match SQLite
 * FTS5 defaults (k1 = 1.2, b = 0.75); the tokenizer approximates unicode61
 * (lowercase, split on non-alphanumeric runs, Unicode-aware). Query terms
 * are OR-combined with scores summed, the same semantics as WUPI's
 * `sanitize_fts5_query` (each token phrase-quoted, joined with OR).
 *
 * Raw score scale is model- and corpus-dependent (exactly like FTS5's bm25),
 * which is why the fusion layer only consumes RANK ORDER and gates on the
 * dense cosine floor instead.
 *
 * Pure module; unit-testable in Node.
 */

const K1 = 1.2;
const B = 0.75;

/** Tokenize to lowercase alphanumeric word runs (unicode61-like). */
export function tokenize(text) {
    return String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export class BM25Index {
    /**
     * @param {{id: number, text: string}[]} docs live (non-superseded) rows
     */
    constructor(docs) {
        /** @type {number} total docs */
        this.n = docs.length;
        /** @type {number} average token length */
        this.avgdl = 0;
        /** @type {Map<string, Map<number, number>>} term -> (docId -> tf) */
        this.postings = new Map();
        /** @type {Map<number, number>} docId -> token count */
        this.docLen = new Map();

        let totalLen = 0;
        for (const doc of docs) {
            const toks = tokenize(doc.text);
            totalLen += toks.length;
            this.docLen.set(doc.id, toks.length);
            const seen = new Map();
            for (const t of toks) {
                seen.set(t, (seen.get(t) ?? 0) + 1);
            }
            for (const [t, tf] of seen) {
                let p = this.postings.get(t);
                if (!p) {
                    p = new Map();
                    this.postings.set(t, p);
                }
                p.set(doc.id, tf);
            }
        }
        this.avgdl = this.n > 0 ? totalLen / this.n : 0;
    }

    /**
     * OR-combined BM25 over the query's tokens.
     * @param {string} query
     * @param {number} k take top-k
     * @returns {[number, number][]} (docId, bm25 score) best-first
     */
    search(query, k) {
        const terms = [...new Set(tokenize(query))];
        if (terms.length === 0 || this.n === 0) return [];
        const scores = new Map();
        for (const term of terms) {
            const p = this.postings.get(term);
            if (!p) continue;
            // FTS5-style idf, with the same clamp SQLite applies (fts5_aux.c):
            // a term in over half the docs would go negative and INVERT the
            // more-matches-is-better ordering, so it is floored at 1e-6.
            const idf = Math.max(1e-6, Math.log((this.n - p.size + 0.5) / (p.size + 0.5)));
            for (const [docId, tf] of p) {
                const dl = this.docLen.get(docId) ?? 0;
                const norm = tf + K1 * (1 - B + B * (dl / (this.avgdl || 1)));
                const s = idf * ((tf * (K1 + 1)) / norm);
                scores.set(docId, (scores.get(docId) ?? 0) + s);
            }
        }
        return [...scores.entries()]
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])
            .slice(0, k);
    }
}
