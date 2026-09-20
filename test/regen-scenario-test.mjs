// Regression test for the self-echo bug: archived swipes of the CURRENT turn
// must not be retrieved for that turn's generations.
import { WupiMemoryEngine } from '../src/engine.js';
import { hashString } from '../src/util.js';

class FakeEmbedder {
    constructor() { this._dim = 32; this.isReady = true; }
    _vec(text) {
        // Cluster by topic like real bge embeddings: the swipe answering a
        // Pride-invitation question embeds close to that question.
        const t = String(text);
        const seed = /pride|liam/i.test(t) ? 'pride-topic-cluster' : /club|ghibli|met/i.test(t) ? 'how-we-met-cluster' : t.replace(/^Q:/, '').slice(0, 12);
        const v = new Float32Array(this._dim);
        for (let i = 0; i < seed.length && i < this._dim; i++)
            v[i] = (seed.charCodeAt(i) % 16) / 8 - 1;
        if (seed.length < this._dim)
            for (let i = seed.length; i < this._dim; i++) v[i] = 0.01;
        const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
        for (let i = 0; i < this._dim; i++) v[i] /= norm;
        return v;
    }
    async embed(t) { return this._vec(t); }
    async embedQuery(q) { return this._vec('Q:' + q); }
}
class FakeStore {
    constructor() { this.rows = new Map(); this._next = 1; }
    async addRow(row) { const id = this._next++; this.rows.set(id, { ...row, id }); return id; }
    async putRow(row) { this.rows.set(row.id, row); }
    async getAll(p) { return [...this.rows.values()].filter((r) => r.partition === p); }
    async deleteIds(ids) { for (const id of ids) this.rows.delete(id); return ids.length; }
    async clearAll() { this.rows.clear(); }
    async purgeLegacyCodexRows() { return 0; }
    async getMeta() { return undefined; }
    async setMeta() {}
}

const eng = new WupiMemoryEngine(new FakeStore(), new FakeEmbedder(), {
    topK: 3, retrievalDepth: 64, denseFloor: 0.58, weightSparse: 0.5, weightDense: 0.5,
});

const userMsg = 'Hey Liam, want to go to the Pride festival with me Saturday?';
const chatId = 'liam-chat';
const turnUuid = 't:' + hashString(`${chatId}|2026-09-19T00:47|${userMsg}`);

// Old turn (out of window): fine to retrieve.
await eng.addMessage({ partition: chatId, text: 'We met at the anime club orientation and bonded over Ghibli films.', role: 'assistant', turnUuid: 't:old', chatId });
// Current turn: user msg + two swipes (the second archived after a regen).
await eng.addMessage({ partition: chatId, text: userMsg, role: 'user', turnUuid, chatId });
await eng.addMessage({ partition: chatId, text: 'Liam clutches the tank top to his chest like he has been stabbed. Fuck boy? This is fashion!', role: 'assistant', turnUuid, chatId });
await eng.addMessage({ partition: chatId, text: 'Liam clutches the tank top to his chest, betrayed. Coming or what, twink boy? He is already out the door.', role: 'assistant', turnUuid, chatId });

// What the OLD code retrieved (no exclusions): the swipes.
const old = await eng.search({ partition: chatId, query: userMsg });
const isSelf = (h) => h.text === userMsg || h.text.startsWith('Liam clutches');
const oldSelf = old.hits.filter(isSelf).length;
console.log(`old behavior: ${oldSelf} of ${old.hits.length} hits were this turn's own swipes`);
if (oldSelf === 0) throw new Error('scenario invalid: swipes not retrieved without exclusions');

// What the PATCHED injectForGeneration passes.
const excludeSourceHashes = new Set([
    hashString(`user|${userMsg}`),
    hashString(`assistant|Liam clutches the tank top to his chest, betrayed. Coming or what, twink boy? He is already out the door.`),
]);
const patched = await eng.search({ partition: chatId, query: userMsg, excludeTurnUuid: turnUuid, excludeSourceHashes });
const selfHits = patched.hits.filter(isSelf).length;
console.log(`patched behavior: ${selfHits} of ${patched.hits.length} hits are this turn's own swipes`);
if (selfHits !== 0) throw new Error('self-echo returned: this turn swipes were retrieved');
console.log(`patched still retrieves older memory: ${patched.hits.length} hit(s): ${patched.hits.map((h) => h.text.slice(0, 40)).join(' | ')}`);
// Cross-turn memory must still surface: query the OLD topic with the same
// exclusions active (a later turn about how they first met).
const gh = await eng.search({ partition: chatId, query: 'How did we first meet again, at the club?', excludeTurnUuid: turnUuid, excludeSourceHashes });
console.log(`later-turn query retrieves old memory: ${gh.hits.length} hit(s): ${gh.hits.map((h) => h.text.slice(0, 50)).join(' | ')}`);
if (gh.hits.length === 0) throw new Error('cross-turn memory lost');
console.log('PASS: self-echo loop broken, cross-turn memory intact');
