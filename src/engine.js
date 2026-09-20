/**
 * WupiMemoryEngine: the orchestration port of WUPI (old)
 * `src-tauri/src/memory.rs` `MemoryEngine`.
 *
 * Data flow per turn (mirrors the Rust engine):
 *   BEFORE generation:  search(query = the user's just-typed message) ->
 *                       dense (brute-force true cosine) + sparse (BM25)
 *                       -> sparse floor gate -> weighted RRF fuse -> hydrate ->
 *                       proximity tie-break -> renderMemoryBlock -> caller
 *                       injects it via setExtensionPrompt.
 *   AFTER generation:   archive the turn (user + assistant messages, shared
 *                       turnUuid, content-hash dedupe, archivable-prose
 *                       gate), then retention prune.
 *
 * Partitions mirror WUPI's card_id: one memory namespace per character
 * (group chats get their own), optionally scoped to a single chat.
 */

import {
    RETRIEVAL_DEPTH,
    DEFAULT_TOP_K,
    DENSE_COSINE_FLOOR,
    CHUNK_CHAR_BUDGET,
    MAX_EPISODIC_CHUNKS,
    EPISODIC_PRUNE_TARGET,
} from './constants.js';
import {
    FusionWeights,
    gateSparseOnFloor,
    fuseScoredRRF,
    SceneProximityTerms,
    applyProximityTieBreak,
} from './rrf.js';
import { chunkText, archivableProse, byteLen } from './chunk.js';
import { BM25Index } from './bm25.js';
import { renderMemoryBlock, wrapRetrievedMemory } from './renderBlock.js';
import { hashString, uuid } from './util.js';

export class WupiMemoryEngine {
    /**
     * @param {import('./store.js').MemoryStore} store
     * @param {import('./embedder.js').TransformersEmbedder} embedder
     * @param {object} settings live settings object (read at call time)
     */
    constructor(store, embedder, settings) {
        this.store = store;
        this.embedder = embedder;
        this.settings = settings;
        /** @type {Map<string, {byId: Map<number, object>}>} partition caches */
        this._caches = new Map();
    }

    // -----------------------------------------------------------------
    // Partition cache (the vec0 + row cache stand-in)
    // -----------------------------------------------------------------

    async _cache(partition) {
        let cache = this._caches.get(partition);
        if (!cache) {
            const rows = await this.store.getAll(partition);
            cache = { byId: new Map(rows.map((r) => [r.id, r])) };
            this._caches.set(partition, cache);
        }
        return cache;
    }

    dropCache(partition = null) {
        if (partition === null) {
            this._caches.clear();
        } else {
            this._caches.delete(partition);
        }
    }

    // -----------------------------------------------------------------
    // Archival (add_memory + the lib.rs archive-site gates)
    // -----------------------------------------------------------------

    /**
     * Archive one message as episodic memory: chunk -> embed each chunk ->
     * insert rows sharing parentUuid (chunk 0) + turnUuid. Content-hash
     * dedupe: re-archiving the same text in the same partition is a no-op.
     *
     * @param {object} args
     * @param {string} args.partition
     * @param {string} args.text
     * @param {'user'|'assistant'|'system'|'summary'} args.role
     * @param {string} args.turnUuid
     * @param {string} [args.chatId]
     * @param {string} [args.sendDate]
     * @param {string} [args.sourceHash] identity for dedupe (defaults to text hash)
     * @returns {Promise<{inserted: number, skipped: boolean}>}
     */
    async addMessage({ partition, text, role, turnUuid, chatId = '', sendDate = '', sourceHash = null }) {
        if (!archivableProse(text)) {
            return { inserted: 0, skipped: true };
        }
        const hash = sourceHash ?? hashString(`${role}|${text}`);
        const dedupeKey = `${partition}|${hash}`;
        const cache = await this._cache(partition);
        for (const row of cache.byId.values()) {
            if (row.dedupeKey === dedupeKey) {
                return { inserted: 0, skipped: true };
            }
        }

        // Chunk first (multi-chunk messages embed every chunk before any
        // row is written: one logical insert, like the Rust transaction).
        const chunks = chunkText(text).filter((c) => archivableProse(c));
        if (chunks.length === 0) {
            return { inserted: 0, skipped: true };
        }
        const parentUuid = uuid();
        let inserted = 0;
        for (let i = 0; i < chunks.length; i++) {
            const embedding = await this.embedder.embed(chunks[i]);
            const row = {
                partition,
                role,
                text: chunks[i],
                timestamp: Date.now(),
                chunkIndex: i,
                parentUuid: chunks.length > 1 ? parentUuid : '',
                turnUuid: turnUuid ?? '',
                sourceHash: hash,
                dedupeKey: i === 0 ? dedupeKey : `${dedupeKey}#c${i}`,
                chatId,
                sendDate,
                pinned: false,
                supersededBy: null,
                embedding,
            };
            row.id = await this.store.addRow(row);
            (await this._cache(partition)).byId.set(row.id, row);
            inserted++;
        }
        return { inserted, skipped: false };
    }

    // -----------------------------------------------------------------
    // Retrieval (search + search_*_visible)
    // -----------------------------------------------------------------

    /**
     * Hybrid search. Returns the fused ranking (hydrated, with debug
     * scores), the rendered block, and the raw candidate diagnostics.
     *
     * @param {object} args
     * @param {string} args.partition
     * @param {string} args.query
     * @param {string[]} [args.proximityNeedles] present-scene anchor names
     * @param {string} [args.excludeTurnUuid] live-turn anchor: rows sharing it are already in the prompt
     * @param {Set<string>} [args.excludeSourceHashes] source hashes of messages still visible in chat
     * @returns {Promise<{hits: object[], block: string, denseRawCount: number, sparseRawCount: number, gatedSparseCount: number}>}
     */
    async search({ partition, query, proximityNeedles = [], excludeTurnUuid = null, excludeSourceHashes = null }) {
        const s = this.settings;
        const topK = s.topK ?? DEFAULT_TOP_K;
        const depth = s.retrievalDepth ?? RETRIEVAL_DEPTH;
        const denseFloor = s.denseFloor ?? DENSE_COSINE_FLOOR;
        const weights = new FusionWeights(
            s.weightSparse ?? 0.5,
            s.weightDense ?? 0.5,
        );

        const cache = await this._cache(partition);
        // Golden Retrieval Rule: consolidated/superseded sources never surface.
        // Self-echo guard: rows from the turn being answered (including
        // swiped-away regens, which share its turnUuid) and rows whose source
        // message is still in the visible chat are already in the live
        // prompt; retrieving them feeds the model its own previous answer
        // and collapses regens/swipes into near-copies.
        const live = [...cache.byId.values()].filter((r) =>
            r.supersededBy === null
            && r.turnUuid !== excludeTurnUuid
            && !(excludeSourceHashes?.has(r.sourceHash) ?? false),
        );
        if (live.length === 0 || !this.embedder.isReady) {
            return { hits: [], block: '', denseRawCount: 0, sparseRawCount: 0, gatedSparseCount: 0 };
        }

        // Embed the query ONCE (instruction-prefixed).
        const qvec = await this.embedder.embedQuery(query);

        // Dense: brute-force TRUE cosine over every live row (vec0 is a
        // linear scan too; dot == cosine on unit vectors).
        const cosines = new Map(); // id -> true cosine (the sparse gate's source)
        for (const row of live) {
            const v = row.embedding;
            let dot = 0;
            for (let i = 0; i < qvec.length; i++) dot += qvec[i] * v[i];
            cosines.set(row.id, dot);
        }
        const denseRaw = [...cosines.entries()]
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])
            .slice(0, depth); // [id, cosine] best-first

        // Sparse: BM25 over the same live set (FTS5 OR semantics).
        const bm25 = new BM25Index(live.map((r) => ({ id: r.id, text: r.text })));
        const sparseRaw = bm25.search(query, depth); // [id, bm25] best-first

        // Sparse-path dense-floor gate: BM25 only precision-boosts rows that
        // already passed the SAME gate; a below-floor dense hit cannot
        // re-enter through the lexical side door.
        const gatedSparse = gateSparseOnFloor(sparseRaw, denseRaw, cosines, denseFloor);

        // Weighted RRF fuse (K=60, 1-based ranks, id-ascending tie-break).
        const fused = fuseScoredRRF(gatedSparse, denseRaw, denseFloor, weights, topK);

        // Hydrate (the fuse emits shells; text lives in the cache).
        const hits = fused
            .map((r) => {
                const row = cache.byId.get(r.id);
                if (!row) return null;
                return {
                    id: r.id,
                    score: r.score,
                    debug: r.debug,
                    text: row.text,
                    role: row.role,
                    timestamp: row.timestamp,
                };
            })
            .filter(Boolean);

        // Scene-proximity tie-break (exact ties only; present names lift).
        applyProximityTieBreak(hits, new SceneProximityTerms(proximityNeedles));

        return {
            hits,
            block: wrapRetrievedMemory(renderMemoryBlock(hits)),
            denseRawCount: denseRaw.length,
            sparseRawCount: sparseRaw.length,
            gatedSparseCount: gatedSparse.length,
        };
    }

    // -----------------------------------------------------------------
    // Retention (prune_episodic_card port: turn-atomic FIFO eviction)
    // -----------------------------------------------------------------

    /**
     * Evict whole oldest turns when the partition exceeds the episodic
     * cap. Never touches turns containing a pinned row.
     * @returns {Promise<number>} rows deleted
     */
    async prune(partition) {
        const cache = await this._cache(partition);
        const episodic = [...cache.byId.values()];
        if (episodic.length <= MAX_EPISODIC_CHUNKS) {
            return 0;
        }

        // Group rows by turn (turn-atomic: every row of a turn flips
        // together). Rows without a turnUuid (legacy/manual) form singleton
        // groups keyed by their own id.
        const groups = new Map(); // key -> {ids: [], minTs: number, pinned: boolean}
        for (const row of episodic) {
            const key = row.turnUuid || `__row_${row.id}`;
            let g = groups.get(key);
            if (!g) {
                g = { ids: [], minTs: row.timestamp, pinned: false };
                groups.set(key, g);
            }
            g.ids.push(row.id);
            g.minTs = Math.min(g.minTs, row.timestamp);
            if (row.pinned) g.pinned = true;
        }

        // Oldest first; pinned turns never evict.
        const ordered = [...groups.entries()]
            .map(([key, g]) => ({ key, ...g }))
            .sort((a, b) => a.minTs - b.minTs);

        let liveCount = episodic.length;
        const toDelete = [];
        for (const g of ordered) {
            if (liveCount <= EPISODIC_PRUNE_TARGET) break;
            if (g.pinned) continue;
            toDelete.push(...g.ids);
            liveCount -= g.ids.length;
        }
        if (toDelete.length > 0) {
            await this.store.deleteIds(toDelete);
            for (const id of toDelete) {
                cache.byId.delete(id);
            }
        }
        return toDelete.length;
    }

    // -----------------------------------------------------------------
    // Maintenance
    // -----------------------------------------------------------------

    /**
     * Wipe a partition's memory entirely (the wipe_episodic_card contract).
     * @returns {Promise<number>} rows deleted
     */
    async wipe(partition) {
        const cache = await this._cache(partition);
        const doomed = [...cache.byId.values()].map((r) => r.id);
        if (doomed.length > 0) {
            await this.store.deleteIds(doomed);
            this.dropCache(partition);
        }
        return doomed.length;
    }

    /**
     * Partition stats for the UI.
     * @returns {Promise<{rows: number, turns: number, dim: number|null, bytes: number}>}
     */
    async stats(partition) {
        const cache = await this._cache(partition);
        const rows = [...cache.byId.values()];
        const turns = new Set(rows.filter((r) => r.turnUuid).map((r) => r.turnUuid)).size;
        const dim = rows[0]?.embedding?.length ?? null;
        return {
            rows: rows.length,
            turns,
            dim,
            bytes: rows.reduce((n, r) => n + byteLen(r.text), 0),
        };
    }
}
