/**
 * WupiMemory engine constants.
 *
 * Ported from WUPI (old) `src-tauri/src/memory_rrf.rs` and `memory.rs`.
 * Every value keeps the original name and semantics so the two engines can
 * be reasoned about side by side. Calibrated values (floors) stay
 * overridable at runtime via extension settings.
 */

/** RRF smoothing constant. Standard value from Cormack et al. (2009). */
export const RRF_K = 60;

/**
 * Default hard cosine floor for the dense path (episodic memories).
 * True-cosine axis (cos = 1 - d^2/2 on unit vectors).
 *
 * WUPI v2's tested value (`C:/WUPI/scripts/memory.cs`, Rrf.DenseCosineFloor):
 * calibrated 2026-09-12 by tools/memstress against a paraphrase-recall
 * corpus. v1's provisional 0.72 rejected nearly all paraphrase recalls
 * (relevant pairs at p50 ~0.51, same-genre bleed at p95 ~0.54; measured
 * knee 0.60 at 75% recall; 0.58 buys recall toward the 0.55 row's ~100%
 * while fusion + the anti-contamination frame absorb the extra bleed).
 */
export const DENSE_COSINE_FLOOR = 0.58;

/** Per-list retrieval depth. Larger than the final limit so RRF has overlap. */
export const RETRIEVAL_DEPTH = 64;

/** Production retrieval limit: hits injected per turn. */
export const DEFAULT_TOP_K = 5;

/** Chunk budget in UTF-8 BYTES (mirrors Rust `String::len`), sized so
 *  worst-case BERT WordPiece inflation stays under the 512-token ceiling. */
export const CHUNK_CHAR_BUDGET = 1300;

/** Degenerate-tail guard for hard cuts: no chunk smaller than this (bytes). */
export const CHUNK_TAIL_FLOOR = 32;

/** Retention: max episodic chunk rows per partition before prune. */
export const MAX_EPISODIC_CHUNKS = 2000;

/** Retention: prune target (hysteresis: evict to this many, not to zero). */
export const EPISODIC_PRUNE_TARGET = 1800;

/** bge-small asymmetric retrieval: instruction prefixed to QUERIES only. */
export const BGE_QUERY_INSTRUCTION =
    'Represent this sentence for searching relevant passages: ';

/** Roles a memory row can carry (mirrors WUPI `Role`). */
export const ROLES = Object.freeze(['user', 'assistant', 'system', 'summary']);

/** IndexedDB name + object stores (the SQLite three-table layout collapses
 *  into one store + indexes; embeddings live inline on the row). */
export const DB_NAME = 'wupi_memory';
export const DB_VERSION = 1;
export const STORE_MEMORIES = 'memories';
export const STORE_META = 'meta';
