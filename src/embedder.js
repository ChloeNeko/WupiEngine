/**
 * Local embedding backend: the webview stand-in for WUPI's in-process
 * llama.cpp embedder (`memory_embedder_llama.rs`).
 *
 * Same model family, same contract, different runtime:
 *   - model: bge-small-en-v1.5 (384-dim, 512-token BERT encoder); the ONNX
 *     port (`Xenova/bge-small-en-v1.5`) runs via transformers.js, exactly
 *     how the TTS extension runs its local web model in this app.
 *   - pooling: CLS; output L2-normalized (both handled by the pipeline opts
 *     below, the pair WUPI configured on its LlamaContext).
 *   - asymmetric retrieval: queries carry the bge instruction prefix
 *     (`BGE_QUERY_INSTRUCTION`), documents embed raw.
 *   - embeddings are served sequentially off one promise chain (JS is
 *     single-threaded, the moral equivalent of WUPI's single-owner
 *     embedder thread).
 *   - startup self-test: cosine-collapse detection (HIGH >= 0.6 and
 *     HIGH - LOW >= 0.15), like `run_self_test`.
 *
 * transformers.js is vendored at `lib/transformers.min.mjs` (relative to the
 * extension root) with a jsdelivr CDN fallback. Model weights stream from
 * the HF CDN on first use and are cached by the browser (Cache API).
 */

import { BGE_QUERY_INSTRUCTION } from './constants.js';

const VENDORED_URL = new URL('../lib/transformers.min.mjs', import.meta.url).href;
const CDN_FALLBACK = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

export class TransformersEmbedder {
    /**
     * @param {object} [opts]
     * @param {() => {model: string, dtype: string, device: string}} [opts.getConfig]
     *        Live config accessor (settings may change between loads). Falls
     *        back to a static snapshot from `opts.model/dtype/device`.
     */
    constructor({ getConfig = null, model = 'Xenova/bge-small-en-v1.5', dtype = 'q8', device = 'auto' } = {}) {
        this._getConfig = getConfig ?? (() => ({ model, dtype, device }));
        this.status = 'idle'; // idle | loading | ready | error
        this.lastError = null;
        this.loadedFrom = null;
        /** @type {number|null} */
        this._dim = null;
        this._extractor = null;
        this._lib = null;
        this._loadedConfigSig = null;
        this._loadingPromise = null;
        this._queue = Promise.resolve();
    }

    get model() { return this._getConfig().model; }
    get dtype() { return this._getConfig().dtype; }
    get device() { return this._getConfig().device; }

    /** Download + initialize the pipeline. Idempotent; safe to re-call;
     *  re-initializes when the model/dtype/device config changed. */
    async load(onProgress = null) {
        const sig = `${this.model}|${this.dtype}|${this.device}`;
        if (this.status === 'ready' && sig === this._loadedConfigSig) {
            return;
        }
        if (this._loadingPromise && this.status === 'loading') {
            return this._loadingPromise;
        }
        this.status = 'loading';
        this.lastError = null;
        this._loadingPromise = (async () => {
            try {
                let lib;
                let loadedFrom;
                try {
                    lib = await import(VENDORED_URL);
                    loadedFrom = 'vendored';
                } catch (err) {
                    console.warn('WupiMemory: vendored transformers.js failed, trying CDN', err);
                    lib = await import(/* @vite-ignore */ CDN_FALLBACK);
                    loadedFrom = 'cdn';
                }
                // Same env posture as SillyTavern's local pipeline: no local
                // /models/ dir to probe; keep the browser cache.
                if (lib.env) {
                    lib.env.allowLocalModels = false;
                    lib.env.useBrowserCache = true;
                }
                const makePipeline = (device) => lib.pipeline('feature-extraction', this.model, {
                    dtype: this.dtype,
                    ...(device && device !== 'auto' ? { device } : {}),
                    ...(onProgress ? { progress_callback: onProgress } : {}),
                });

                let extractor;
                const wantDevice = this.device;
                try {
                    extractor = await makePipeline(wantDevice === 'auto' ? null : wantDevice);
                } catch (err) {
                    if (wantDevice === 'auto' || wantDevice === 'webgpu') {
                        console.warn('WupiMemory: preferred device failed, falling back to wasm', err);
                        extractor = await makePipeline('wasm');
                    } else {
                        throw err;
                    }
                }
                this._lib = lib;
                this._extractor = extractor;
                this.loadedFrom = loadedFrom;
                this._loadedConfigSig = sig;
                this.status = 'ready';
            } catch (err) {
                this.status = 'error';
                this.lastError = err;
                throw err;
            } finally {
                this._loadingPromise = null;
            }
        })();
        return this._loadingPromise;
    }

    get isReady() {
        return this.status === 'ready';
    }

    /** Embedding dimension (learned on first embed; 384 for bge-small). */
    get dim() {
        return this._dim;
    }

    /**
     * Embed a document (raw, no instruction prefix).
     * @param {string} text
     * @returns {Promise<Float32Array>} unit-normalized
     */
    async embed(text) {
        return this._enqueue(() => this._embedOne(text));
    }

    /**
     * Embed a retrieval query (bge instruction prefixed).
     * @param {string} query
     * @returns {Promise<Float32Array>} unit-normalized
     */
    async embedQuery(query) {
        return this._enqueue(() => this._embedOne(BGE_QUERY_INSTRUCTION + query));
    }

    /** Serialize inference calls through one chain (single embedder owner). */
    _enqueue(job) {
        const run = this._queue.then(job, job);
        // keep the chain alive even if a job rejects
        this._queue = run.then(() => {}, () => {});
        return run;
    }

    async _embedOne(text) {
        if (!this.isReady) {
            await this.load();
        }
        // CLS pooling + L2 normalization, the exact pair WUPI configured
        // (LlamaPoolingType::Cls + post-normalize).
        const output = await this._extractor(text, { pooling: 'cls', normalize: true });
        const dims = output?.ort_tensor?.dims ?? output?.dims;
        const data = output?.ort_tensor?.data ?? output?.data;
        if (!data) {
            throw new Error('WupiMemory: embedder returned no vector');
        }
        const vec = data instanceof Float32Array ? data : Float32Array.from(data);
        this._dim = dims ? dims[dims.length - 1] : vec.length;
        return vec;
    }

    /**
     * Cosine-collapse self-test (port of run_self_test's intent; the exact
     * probe phrases are equivalent, thresholds identical).
     * @returns {Promise<{ok: boolean, high: number, low: number, gap: number, reason?: string}>}
     */
    async selfTest() {
        const cos = (a, b) => {
            let dot = 0;
            for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
            return dot; // unit vectors: dot == cosine
        };
        const [gold, gold2, silver, weather] = await Promise.all([
            this.embed('gold'), this.embed('gold'),
            this.embed('silver'), this.embed('The weather is mild today.'),
        ]);
        const high = cos(gold, gold2);
        const low = Math.max(cos(gold, silver), cos(gold, weather));
        const gap = high - low;
        if (high < 0.6) return { ok: false, high, low, gap, reason: `self-similarity ${high.toFixed(3)} < 0.6` };
        if (gap < 0.15) return { ok: false, high, low, gap, reason: `separation gap ${gap.toFixed(3)} < 0.15` };
        return { ok: true, high, low, gap };
    }
}
