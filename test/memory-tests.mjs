/**
 * Node test runner for the pure engine modules.
 *
 * Section 1 (rrf) is a 1:1 port of the Rust unit tests in
 * WUPI(old)/src-tauri/src/memory_rrf.rs: same inputs, same expectations
 * (the dense input here is already TRUE cosine; the Rust helper built the
 * L2 distance equivalent). Sections 2 to 6 cover chunking, BM25, the render
 * block, the engine orchestration over fake store/embedder, and the token
 * limiter.
 *
 * Run: node test/run-tests.mjs   (exit 0 = all pass)
 */

import assert from 'node:assert/strict';

import {
    FusionWeights,
    gateSparseOnFloor,
    fuseScoredRRF,
    SceneProximityTerms,
    applyProximityTieBreak,
} from '../src/rrf.js';
import { chunkText, archivableProse, sliceByBytes, byteLen } from '../src/chunk.js';
import { BM25Index, tokenize } from '../src/bm25.js';
import { renderMemoryBlock, wrapRetrievedMemory } from '../src/renderBlock.js';
import { hashString } from '../src/util.js';
import { WupiMemoryEngine } from '../src/engine.js';
import { RRF_K } from '../src/constants.js';
import { planTokenTruncation, TokenCountCache, MESSAGE_TOKEN_OVERHEAD } from '../src/tokenLimit.js';
import { rescopeRow, planChatRename, planPerChatMigration } from '../src/lifecycle.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failed++;
        failures.push({ name, err });
        console.error(`  FAIL ${name}\n      ${err?.stack ?? err}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
    } catch (err) {
        failed++;
        failures.push({ name, err });
        console.error(`  FAIL ${name}\n      ${err?.stack ?? err}`);
    }
}

// ---------------------------------------------------------------------------
// 1. RRF fusion (ports of the Rust test suite)
// ---------------------------------------------------------------------------

console.log('§1 rrf.js (Rust test port)');

const ids = (out) => out.map((r) => r.id);

// Dense list helper: (id, TRUE cosine) best-first. (The Rust helper built
// the L2 distance whose cosine image equals this.)
const dense = (id, cosine) => [id, cosine];
// Sparse helper: (id, bm25). More-negative = better; only rank matters.
const sparse = (id, q) => [id, -q];

test('empty inputs return empty', () => {
    const out = fuseScoredRRF([], [], 0.40, FusionWeights.default(), 10);
    assert.deepEqual(out, []);
});

test('one empty list passes the other through', () => {
    const s = [sparse(10, 1.0), sparse(20, 0.9), sparse(30, 0.8)];
    const out = fuseScoredRRF(s, [], 0.40, FusionWeights.default(), 10);
    assert.deepEqual(ids(out), [10, 20, 30]);
});

test('dense floor drops below threshold', () => {
    const d = [dense(1, 0.9), dense(2, 0.5), dense(3, 0.2)];
    const out = fuseScoredRRF([], d, 0.40, FusionWeights.default(), 10);
    assert.deepEqual(ids(out), [1, 2], 'below-floor candidate must be rejected');
    assert.ok(!ids(out).includes(3));
});

test('dense floor records cosine on survivors only', () => {
    const d = [dense(1, 0.9), dense(2, 0.2)];
    const out = fuseScoredRRF([], d, 0.40, FusionWeights.default(), 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 1);
    assert.ok(Math.abs(out[0].debug.denseCosine - 0.9) < 1e-5, 'survivor cosine should be recorded');
});

test('id in both lists outranks id in one', () => {
    const s = [sparse(5, 1.0), sparse(1, 0.9), sparse(2, 0.8)];
    const d = [dense(5, 0.9), dense(9, 0.8), dense(8, 0.7)];
    const out = fuseScoredRRF(s, d, 0.40, FusionWeights.default(), 10);
    assert.equal(out[0].id, 5, 'overlap must dominate');
    assert.ok(out[0].score > out[1].score);
});

test('dense weight tilts toward semantic', () => {
    const s = [sparse(1, 1.0)];
    const d = [dense(2, 0.9)];

    const equal = fuseScoredRRF(s, d, 0.40, FusionWeights.default(), 10);
    assert.deepEqual(ids(equal), [1, 2], 'equal weights: tie-break by id');

    const denseHeavy = fuseScoredRRF(s, d, 0.40, new FusionWeights(0.1, 0.9), 10);
    assert.deepEqual(ids(denseHeavy), [2, 1], 'dense-heavy: dense id first');
});

test('limit truncates', () => {
    const s = [1, 2, 3, 4, 5].map((i) => sparse(i, 1.0 / i));
    const d = [6, 7, 8, 9, 10].map((i) => dense(i, 0.9 - i * 0.01));
    const out = fuseScoredRRF(s, d, 0.40, FusionWeights.default(), 3);
    assert.equal(out.length, 3);
});

test('rank indexing is 1-based not 0', () => {
    const s = [sparse(1, 1.0)];
    const out = fuseScoredRRF(s, [], 0.40, FusionWeights.default(), 10);
    const expected = 0.5 / (RRF_K + 1);
    assert.ok(Math.abs(out[0].score - expected) < 1e-6, `top score should be w/(k+1), got ${out[0].score}`);
    const wrong = 0.5 / RRF_K;
    assert.ok(Math.abs(out[0].score - wrong) > 1e-6, 'must not equal w/k (0-based bug)');
});

test('scores descend monotonically', () => {
    const s = [1, 2, 3, 4].map((i, n) => sparse(i, 1.0 - n * 0.1));
    const d = [dense(5, 0.9), dense(1, 0.85), dense(6, 0.8), dense(2, 0.75)];
    const out = fuseScoredRRF(s, d, 0.40, FusionWeights.default(), 10);
    for (let i = 1; i < out.length; i++) {
        assert.ok(out[i - 1].score >= out[i].score, `scores must descend: ${out[i - 1].score} then ${out[i].score}`);
    }
});

test('sparse only id has no dense debug', () => {
    const s = [sparse(7, 1.0)];
    const d = [dense(8, 0.9)];
    const out = fuseScoredRRF(s, d, 0.40, FusionWeights.default(), 10);
    const seven = out.find((r) => r.id === 7);
    assert.equal(seven.debug.denseCosine, null);
    assert.equal(seven.debug.denseRank, null);
    assert.equal(seven.debug.sparseRank, 1);
});

// ---- sparse-path dense-floor gate ----

test('gate drops sparse-only candidates below the floor', () => {
    const s = [sparse(1, 1.0), sparse(2, 0.9)];
    const cosines = new Map([[1, 0.30], [2, 0.80]]);
    const gated = gateSparseOnFloor(s, [], cosines, 0.40);
    assert.equal(gated.length, 1);
    assert.equal(gated[0][0], 2, 'only the above-floor sparse-only candidate survives');
    assert.equal(gated[0][1], s[1][1], 'survivor keeps its raw bm25 score');
});

test('gate uses the dense cosine for dense-list members', () => {
    const s = [sparse(3, 1.0), sparse(4, 0.5)];
    const d = [dense(3, 0.10), dense(4, 0.80)];
    // bogus map value for id 4 must be IGNORED in favor of the dense cosine
    const cosines = new Map([[4, 0.05]]);
    const gated = gateSparseOnFloor(s, d, cosines, 0.40);
    assert.equal(gated.length, 1, 'only id 4 survives (id 3 rejected on both paths)');
    assert.equal(gated[0][0], 4);
});

test('gate drops candidates missing a vector', () => {
    const s = [sparse(9, 1.0), sparse(10, 1.0)];
    const cosines = new Map([[10, 0.90]]);
    const gated = gateSparseOnFloor(s, [], cosines, 0.40);
    assert.equal(gated.length, 1);
    assert.equal(gated[0][0], 10);
});

test('gate passes everything through when all clear the floor', () => {
    const s = [sparse(1, 1.0), sparse(2, 0.9), sparse(3, 0.8)];
    const d = [dense(2, 0.90)];
    const cosines = new Map([[1, 0.95], [3, 0.85]]);
    const gated = gateSparseOnFloor(s, d, cosines, 0.40);
    assert.deepEqual(gated, s, 'order + scores preserved bit-for-bit when nothing is floored');
});

// ---- scene-proximity tie-break ----

const hydrated = (id, score, text) => ({ id, score, text });

test('proximity promotes only within exact ties', () => {
    const rows = [
        hydrated(1, 0.05, 'a stranger bargains at the docks'),
        hydrated(2, 0.05, 'Mara laughs at the jest'),
        hydrated(3, 0.09, 'Mara pockets the coin'),
        hydrated(4, 0.09, 'the harbor bell tolls'),
    ];
    const terms = new SceneProximityTerms(['Mara', 'ironhaven']);
    applyProximityTieBreak(rows, terms);
    assert.deepEqual(rows.map((r) => r.id), [3, 4, 2, 1], 'mention promotes within ties only');
});

test('proximity never moves distinct scores', () => {
    const rows = [
        hydrated(1, 0.09, 'a stranger bargains at the docks'),
        hydrated(2, 0.05, 'Mara laughs at the jest'),
    ];
    applyProximityTieBreak(rows, new SceneProximityTerms(['Mara']));
    assert.deepEqual(rows.map((r) => r.id), [1, 2]);
});

test('proximity none or empty is a no-op', () => {
    const rows = [hydrated(1, 0.05, 'Mara laughs'), hydrated(2, 0.05, 'a stranger bargains')];
    applyProximityTieBreak(rows, null);
    assert.equal(rows[0].id, 1);
    const rows2 = [hydrated(1, 0.05, 'Mara laughs'), hydrated(2, 0.05, 'a stranger bargains')];
    applyProximityTieBreak(rows2, new SceneProximityTerms());
    assert.equal(rows2[0].id, 1);
    assert.equal(rows2[1].id, 2);
});

test('short needles are dropped (>= 3 chars)', () => {
    const t = new SceneProximityTerms(['Al', 'Mara', '猫']);
    assert.deepEqual(t.needles, ['mara']);
});

// ---------------------------------------------------------------------------
// 2. Chunking (chunk.js)
// ---------------------------------------------------------------------------

console.log('§2 chunk.js');

test('short text is a single chunk', () => {
    assert.deepEqual(chunkText('hello world'), ['hello world']);
});

test('paragraphs pack greedily with separator preserved', () => {
    const paras = ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600)];
    const chunks = chunkText(paras.join('\n\n'));
    // 600+2+600=1202 fits in one chunk; the third flushes separately
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].includes('\n\n'));
    assert.equal(chunks[0], `a`.repeat(600) + '\n\n' + `b`.repeat(600));
    assert.equal(chunks[1], 'c'.repeat(600));
});

test('long paragraph splits on sentence boundaries, terminator glued', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} here. `).join('');
    const chunks = chunkText(sentences);
    assert.ok(chunks.length > 1, 'must split');
    for (const c of chunks) {
        assert.ok(byteLen(c) <= 1300, `chunk within budget (${byteLen(c)})`);
    }
    // ". " stays glued to the sentence that earned it
    assert.ok(chunks[0].endsWith('. ') || chunks[0].endsWith('.'));
});

test('run-on sentence gets hard cuts with a >=32-byte tail (CJK safe)', () => {
    const runon = '猫'.repeat(2000); // 3 bytes/char = 6000 bytes, no terminators
    const chunks = chunkText(runon);
    assert.ok(chunks.length >= 5);
    for (const c of chunks) {
        assert.ok(byteLen(c) <= 1300);
        assert.ok(!c.includes('\uFFFD'), 'no broken code points');
    }
    const last = chunks[chunks.length - 1];
    assert.ok(byteLen(last) >= 32 || chunks.length === 1, `tail keeps a minimum size (${byteLen(last)})`);
});

test('archivable prose gate', () => {
    assert.equal(archivableProse('...'), false);
    assert.equal(archivableProse('/'), false);
    assert.equal(archivableProse(''), false);
    assert.equal(archivableProse('abc'), true);
    assert.equal(archivableProse('ネコ'), true);
    assert.equal(archivableProse('a...'), true);
});

test('sliceByBytes clamps without splitting a code point', () => {
    const s = 'ab猫def';
    assert.equal(sliceByBytes(s, 100), s);
    assert.equal(sliceByBytes(s, 2), 'ab');
    assert.equal(sliceByBytes(s, 3), 'ab'); // would split 猫 -> drop it
    assert.equal(sliceByBytes(s, 5), 'ab猫');
});

// ---------------------------------------------------------------------------
// 3. BM25 (bm25.js)
// ---------------------------------------------------------------------------

console.log('§3 bm25.js');

test('tokenize is unicode-aware lowercase word runs', () => {
    // CJK has no spaces: 猫と犬 is one letter-run (unicode61 behaves the same)
    assert.deepEqual(tokenize('Hello, World! 猫と犬'), ['hello', 'world', '猫と犬']);
});

test('relevant doc outranks irrelevant (OR semantics)', () => {
    const docs = [
        { id: 1, text: 'The butter melted in the pan' },
        { id: 2, text: 'Diamonds are pressed from carbon' },
        { id: 3, text: 'butter butter butter on toast' },
    ];
    const idx = new BM25Index(docs);
    const out = idx.search('butter', 10);
    assert.equal(out[0][0], 3, 'repeated term ranks first');
    assert.equal(out.length, 2, 'OR: only docs containing a query term score');
});

test('empty query or corpus returns empty', () => {
    assert.deepEqual(new BM25Index([{ id: 1, text: 'x' }]).search('', 5), []);
    assert.deepEqual(new BM25Index([]).search('a', 5), []);
});

// ---------------------------------------------------------------------------
// 4. Render block (renderBlock.js)
// ---------------------------------------------------------------------------

console.log('§4 renderBlock.js');

test('block carries the anti-contamination frame', () => {
    const block = renderMemoryBlock([
        { text: 'We met at the docks', role: 'user' },
    ]);
    assert.ok(block.startsWith('Past records: recall only.'));
    assert.ok(block.includes('<m role="user">We met at the docks</m>'));
});

test('xml-special characters are escaped', () => {
    const block = renderMemoryBlock([
        { text: 'Ironhaven is a port city & "free" trade hub', role: 'system' },
    ]);
    assert.ok(block.includes('&amp; &quot;free&quot; trade hub'));
    assert.ok(!block.includes('city & "free"'), 'raw & and quotes must not appear');
});

test('wrapped block uses retrieved_memory region tags', () => {
    assert.equal(wrapRetrievedMemory(''), '');
    const w = wrapRetrievedMemory('x');
    assert.equal(w, '<retrieved_memory>\nx\n</retrieved_memory>');
});

// ---------------------------------------------------------------------------
// 5. Engine orchestration over fakes (engine.js)
// ---------------------------------------------------------------------------

console.log('§5 engine.js (fake store + fake embedder)');

/** Deterministic fake embedder: hash-seeded normalized vector. */
class FakeEmbedder {
    constructor() { this.status = 'ready'; this._dim = 16; }
    get isReady() { return true; }
    get dim() { return this._dim; }
    _vec(text) {
        const v = new Float32Array(this._dim);
        let h = parseInt(hashString(text), 36) || 1;
        for (let i = 0; i < this._dim; i++) {
            h = (Math.imul(h, 48271) + 11) >>> 0;
            v[i] = ((h % 2000) / 1000) - 1;
        }
        let norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
        for (let i = 0; i < this._dim; i++) v[i] /= norm;
        return v;
    }
    async embed(text) { return this._vec(text); }
    async embedQuery(q) { return this._vec('Q:' + q); }
}

/** In-Memory stand-in for MemoryStore. */
class FakeStore {
    constructor() { this.rows = new Map(); this._next = 1; }
    async addRow(row) { const id = this._next++; this.rows.set(id, { ...row, id }); return id; }
    async putRow(row) { this.rows.set(row.id, row); }
    async getAll(partition) { return [...this.rows.values()].filter((r) => r.partition === partition); }
    async deleteIds(ids) { for (const id of ids) this.rows.delete(id); return ids.length; }
    async clearAll() { this.rows.clear(); }
    async purgeLegacyCodexRows() { return 0; }
    async getMeta() { return undefined; }
    async setMeta() {}
}

const mkEngine = (settings = {}) =>
    new WupiMemoryEngine(new FakeStore(), new FakeEmbedder(), {
        topK: 5, retrievalDepth: 64, denseFloor: 0.72,
        weightSparse: 0.5, weightDense: 0.5, ...settings,
    });

// Fake vectors are hash-noise with no stable cosine signal, so for the
// search tests we need an embedder whose vectors encode topical overlap.
// Similar texts get similar vectors by seeding from the first 12 chars.
class TopicEmbedder extends FakeEmbedder {
    _vec(text) {
        const seed = String(text).replace(/^Q:/, '').slice(0, 12);
        const v = new Float32Array(this._dim);
        for (let i = 0; i < seed.length && i < this._dim; i++) {
            v[i] = (seed.charCodeAt(i) % 16) / 8 - 1;
        }
        if (seed.length < this._dim) {
            for (let i = seed.length; i < this._dim; i++) v[i] = 0.01;
        }
        let norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
        for (let i = 0; i < this._dim; i++) v[i] /= norm;
        return v;
    }
}

await testAsync('addMessage: single chunk, dedupe on re-add', async () => {
    const eng = mkEngine();
    const r1 = await eng.addMessage({ partition: 'p', text: 'hello world', role: 'user', turnUuid: 't1' });
    assert.equal(r1.inserted, 1);
    assert.equal(r1.skipped, false);
    const r2 = await eng.addMessage({ partition: 'p', text: 'hello world', role: 'user', turnUuid: 't2' });
    assert.equal(r2.skipped, true, 'same text re-archive is a no-op');
    assert.equal(r2.inserted, 0);
});

await testAsync('addMessage: punctuation-only text is skipped', async () => {
    const eng = mkEngine();
    const r = await eng.addMessage({ partition: 'p', text: ' ... ', role: 'user', turnUuid: 't1' });
    assert.equal(r.inserted, 0);
});

await testAsync('addMessage: multi-chunk message shares turnUuid', async () => {
    const eng = mkEngine();
    const long = Array.from({ length: 5 }, (_, i) => `Para ${i} ${'x'.repeat(700)}`).join('\n\n');
    const r = await eng.addMessage({ partition: 'p', text: long, role: 'assistant', turnUuid: 't1' });
    assert.ok(r.inserted >= 2, `split into chunks (${r.inserted})`);
    const rows = [...eng._caches.get('p').byId.values()];
    assert.ok(rows.every((row) => row.turnUuid === 't1'));
    assert.ok(rows.every((row) => row.parentUuid === rows[0].parentUuid && row.parentUuid !== ''));
});

await testAsync('search: hybrid fusion returns hydrated hits + wrapped block', async () => {
    const eng = new WupiMemoryEngine(new FakeStore(), new TopicEmbedder(), {
        topK: 5, retrievalDepth: 64, denseFloor: 0.0,
        weightSparse: 0.5, weightDense: 0.5,
    });
    await eng.addMessage({ partition: 'p', text: 'butter melted in the pan', role: 'user', turnUuid: 't1' });
    await eng.addMessage({ partition: 'p', text: 'diamonds press from carbon', role: 'assistant', turnUuid: 't2' });
    const res = await eng.search({ partition: 'p', query: 'butter' });
    assert.ok(res.hits.length >= 1);
    assert.ok(res.block.startsWith('<retrieved_memory>'));
    assert.ok(res.hits[0].text.includes('butter'));
    assert.ok(res.hits[0].debug.sparseRank !== null || res.hits[0].debug.denseRank !== null);
});

await testAsync('search: dense floor rejects semantically distant memories', async () => {
    const eng = new WupiMemoryEngine(new FakeStore(), new TopicEmbedder(), {
        topK: 5, retrievalDepth: 64, denseFloor: 0.95,
        weightSparse: 0.5, weightDense: 0.5,
    });
    await eng.addMessage({ partition: 'p', text: 'butter melted in the pan', role: 'user', turnUuid: 't1' });
    // TopicEmbedder gives ~orthogonal vectors to different prefixes: with a
    // 0.95 floor nothing survives even if BM25 matches the keyword.
    const res = await eng.search({ partition: 'p', query: 'butter' });
    assert.equal(res.hits.length, 0, 'floor is the rejection authority, BM25 cannot override it');
    assert.equal(res.block, '');
});

await testAsync('prune: turn-atomic eviction to target, pinned protected', async () => {
    const eng = mkEngine();
    // 1100 turns x 2 messages = 2200 rows > 2000 cap
    for (let t = 0; t < 1100; t++) {
        await eng.addMessage({ partition: 'p', text: `user message number ${t}`, role: 'user', turnUuid: `t${t}` });
        await eng.addMessage({ partition: 'p', text: `assistant message number ${t}`, role: 'assistant', turnUuid: `t${t}` });
    }
    // pin the NEWEST turn's rows (present in cache)
    const rows = [...eng._caches.get('p').byId.values()];
    const newestUser = rows.find((r) => r.text === 'user message number 1099');
    newestUser.pinned = true;
    await eng.store.putRow(newestUser);

    const deleted = await eng.prune('p');
    assert.ok(deleted > 0);
    const after = [...eng._caches.get('p').byId.values()];
    assert.ok(after.length <= 1800 + 2, `pruned to target (${after.length})`);
    assert.ok(after.some((r) => r.text === 'user message number 1099'), 'pinned turn survives');
    assert.ok(!after.some((r) => r.text === 'user message number 0'), 'oldest turn evicted');
    // turn-atomic: no orphan halves of an evicted turn remain
    for (const r of after) {
        if (r.turnUuid?.startsWith('t')) {
            const n = after.filter((x) => x.turnUuid === r.turnUuid).length;
            assert.equal(n, 2, `turn ${r.turnUuid} must flip together`);
        }
    }
});

await testAsync('wipe deletes the whole partition', async () => {
    const eng = mkEngine();
    await eng.addMessage({ partition: 'p', text: 'episodic row', role: 'user', turnUuid: 't1' });
    await eng.addMessage({ partition: 'p', text: 'another row', role: 'assistant', turnUuid: 't1' });
    const n = await eng.wipe('p');
    assert.equal(n, 2);
    const st = await eng.stats('p');
    assert.equal(st.rows, 0);
});

await testAsync('stats reports rows/turns/dim', async () => {
    const eng = mkEngine();
    await eng.addMessage({ partition: 'p', text: 'a', role: 'user', turnUuid: 't1' });
    await eng.addMessage({ partition: 'p', text: 'b', role: 'assistant', turnUuid: 't1' });
    const st = await eng.stats('p');
    assert.equal(st.rows, 2);
    assert.equal(st.turns, 1);
    assert.equal(st.dim, 16);
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. Token limiter (tokenLimit.js)
// ---------------------------------------------------------------------------

console.log('§6 tokenLimit.js');

test('under budget: nothing is dropped (append-only, cache-friendly)', () => {
    const counts = [100, 100, 100, 100];
    const r = planTokenTruncation(counts, 10_000);
    assert.equal(r.dropCount, 0);
    assert.equal(r.included, 4);
    assert.equal(r.tokens, 4 * (100 + MESSAGE_TOKEN_OVERHEAD));
});

test('hysteresis does NOT trigger when under budget', () => {
    // 10 msgs x (100+8) = 1080; budget 1100 -> fits, even though 1080 > 1100*0.9
    const counts = Array(10).fill(100);
    const r = planTokenTruncation(counts, 1100);
    assert.equal(r.dropCount, 0, 'must not preemptively trim a fitting prompt');
});

test('over budget: drops the minimum, then to hysteresis headroom', () => {
    const counts = Array(10).fill(100); // each msg = 108 tokens
    // budget 1000: 9 msgs = 972 fits, 10 = 1080 doesn't -> d=1;
    // hysteresis 0.9 -> 900: 9 msgs = 972 > 900 -> d=2 (8 msgs = 864 <= 900)
    const r = planTokenTruncation(counts, 1000);
    assert.equal(r.dropCount, 2);
    assert.equal(r.included, 8);
    assert.equal(r.tokens, 8 * 108);
});

test('drops only the OLDEST messages (suffix stays identical)', () => {
    const counts = [500, 10, 10, 10, 10];
    const r = planTokenTruncation(counts, 200); // oldest is huge
    // suffix from idx1: 4*(10+8)=72 fits; idx0: 568 > 200 -> d=1; 72 <= 180 stop
    assert.equal(r.dropCount, 1);
});

test('never drops the last message (minKeep)', () => {
    const counts = [1000, 1000, 5];
    const r = planTokenTruncation(counts, 1);
    assert.equal(r.dropCount, 2);
    assert.equal(r.included, 1);
});

test('zero budget still keeps one message; empty chat is a no-op', () => {
    assert.equal(planTokenTruncation([10, 20], 0).included, 1);
    assert.deepEqual(planTokenTruncation([], 4096), { dropCount: 0, included: 0, tokens: 0 });
});

test('hysteresis can be disabled (1.0 = minimal drop only)', () => {
    const counts = Array(10).fill(100);
    const r = planTokenTruncation(counts, 1000, { hysteresis: 1.0 });
    assert.equal(r.dropCount, 1);
});

await testAsync('TokenCountCache memoizes by content and evicts the oldest', async () => {
    const cache = new TokenCountCache(3);
    let calls = 0;
    const fn = async (t) => { calls++; return t.length; };
    assert.equal(await cache.get('aaaa', fn), 4);
    assert.equal(await cache.get('aaaa', fn), 4);
    assert.equal(calls, 1, 'second hit is memoized');
    await cache.get('bbbb', fn);
    await cache.get('cccc', fn);
    await cache.get('dddd', fn); // evicts 'aaaa'
    assert.equal(await cache.get('aaaa', fn), 4);
    assert.equal(calls, 5, 're-counted after eviction');
});

// ---------------------------------------------------------------------------
// 7. Chat lifecycle (lifecycle.js)
// ---------------------------------------------------------------------------

console.log('§7 lifecycle.js');

/** Row factory mirroring engine.addMessage's stored shape. */
function mkRow({ id, partition, chatId, hash = `h${id}`, chunk = null }) {
    const dedupeKey = `${partition}|${hash}${chunk != null ? `#c${chunk}` : ''}`;
    return {
        id, partition, chatId, dedupeKey,
        role: 'user', text: `text ${id}`, timestamp: id,
        sourceHash: hash, turnUuid: `t${id}`, embedding: new Float32Array([1, 0]),
    };
}

test('rescopeRow re-splices the dedupeKey prefix, chunk suffix included', () => {
    const row = mkRow({ id: 1, partition: 'char:a.png', chatId: 'c1', chunk: 1 });
    const next = rescopeRow(row, 'char:a.png:chat:c1');
    assert.equal(next.partition, 'char:a.png:chat:c1');
    assert.equal(next.dedupeKey, 'char:a.png:chat:c1|h1#c1');
    assert.equal(next.sourceHash, 'h1');
    assert.equal(row.partition, 'char:a.png', 'input row untouched');
    assert.notEqual(next, row);
});

test('planChatRename retags rows and moves per-chat partitions', () => {
    const rows = [
        mkRow({ id: 1, partition: 'char:a.png:chat:old', chatId: 'old' }),
        mkRow({ id: 2, partition: 'char:a.png', chatId: 'old' }), // character-scope row
        mkRow({ id: 3, partition: 'char:a.png:chat:other', chatId: 'other' }),
        mkRow({ id: 4, partition: 'group:g:chat:old', chatId: 'old' }),
    ];
    const { updates, drops } = planChatRename(rows, 'old', 'new');
    assert.deepEqual(drops, []);
    const byId = new Map(updates.map((r) => [r.id, r]));
    assert.equal(updates.length, 3, 'only the renamed chat rows move');
    assert.equal(byId.get(1).partition, 'char:a.png:chat:new');
    assert.equal(byId.get(1).chatId, 'new');
    assert.equal(byId.get(1).dedupeKey, 'char:a.png:chat:new|h1');
    assert.equal(byId.get(2).partition, 'char:a.png', 'character-scope partition stays');
    assert.equal(byId.get(2).chatId, 'new');
    assert.equal(byId.get(4).partition, 'group:g:chat:new', 'group chats rename too');
    assert.ok(!byId.has(3), 'other chats untouched');
});

test('planChatRename drops rows that would collide with a survivor', () => {
    const rows = [
        mkRow({ id: 1, partition: 'char:a.png:chat:old', chatId: 'old', hash: 'x' }),
        mkRow({ id: 2, partition: 'char:a.png:chat:new', chatId: 'new', hash: 'x' }),
    ];
    const { updates, drops } = planChatRename(rows, 'old', 'new');
    assert.deepEqual(drops, [1], 'mover loses to the row already living there');
    assert.deepEqual(updates.map((r) => r.id), []);
});

test('planPerChatMigration moves chat-attributed rows into their chat', () => {
    const rows = [
        mkRow({ id: 1, partition: 'char:a.png', chatId: 'c1' }),
        mkRow({ id: 2, partition: 'char:a.png', chatId: 'c2' }),
        mkRow({ id: 3, partition: 'char:a.png:chat:c1', chatId: 'c1' }), // already scoped
        mkRow({ id: 4, partition: 'char:b.png', chatId: '' }),           // unattributed
        mkRow({ id: 5, partition: 'group:g', chatId: 'gc' }),
    ];
    const { updates, drops } = planPerChatMigration(rows);
    assert.deepEqual(drops, []);
    const byId = new Map(updates.map((r) => [r.id, r]));
    assert.equal(updates.length, 3);
    assert.equal(byId.get(1).partition, 'char:a.png:chat:c1');
    assert.equal(byId.get(1).dedupeKey, 'char:a.png:chat:c1|h1');
    assert.equal(byId.get(2).partition, 'char:a.png:chat:c2');
    assert.equal(byId.get(5).partition, 'group:g:chat:gc');
    assert.ok(!byId.has(3) && !byId.has(4), 'scoped and unattributed rows stay put');
});

test('planPerChatMigration collides onto an existing per-chat row: mover drops', () => {
    const rows = [
        mkRow({ id: 1, partition: 'char:a.png', chatId: 'c1', hash: 'x' }),
        mkRow({ id: 2, partition: 'char:a.png:chat:c1', chatId: 'c1', hash: 'x' }),
    ];
    const { updates, drops } = planPerChatMigration(rows);
    assert.deepEqual(drops, [1]);
    assert.deepEqual(updates, []);
});

test('planPerChatMigration is idempotent (second run is a no-op)', () => {
    const rows = [
        mkRow({ id: 1, partition: 'char:a.png:chat:c1', chatId: 'c1' }),
        mkRow({ id: 2, partition: 'char:b.png', chatId: '' }),
    ];
    const once = planPerChatMigration(rows);
    const applied = once.updates.length ? [...rows.filter((r) => !once.updates.some((u) => u.id === r.id)), ...once.updates] : rows;
    const twice = planPerChatMigration(applied);
    assert.equal(twice.updates.length + twice.drops.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('FAILURES:', failures.map((f) => f.name).join(', '));
    process.exit(1);
}
