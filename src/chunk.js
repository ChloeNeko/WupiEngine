/**
 * Chunking + archival gates.
 *
 * Direct port of WUPI (old) `src-tauri/src/memory.rs`:
 *   - `chunk_text` / `split_long_paragraph` (byte-budget recursive split)
 *   - `archivable_prose` (chronicle-hygiene gate)
 *
 * The budget is in UTF-8 BYTES (mirroring Rust `String::len`) so the
 * worst-case BERT WordPiece guarantee under the 512-token ceiling carries
 * over unchanged. All cuts land on code-point boundaries (JS strings never
 * split a multi-byte sequence by construction; the Rust `floor_char_boundary`
 * dance is expressed here as byte-to-char index mapping).
 */

import { CHUNK_CHAR_BUDGET, CHUNK_TAIL_FLOOR } from './constants.js';

/** UTF-8 byte length of a JS string. */
export function byteLen(s) {
    let n = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
}

/**
 * Largest char index whose byte offset is <= `maxBytes` (the Rust
 * floor_char_boundary equivalent: a byte cut walked back to a boundary).
 */
function charIndexAtByte(s, maxBytes) {
    let bytes = 0;
    let chars = 0;
    for (const _ch of s) {
        const c = _ch.codePointAt(0);
        const w = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (bytes + w > maxBytes) break;
        bytes += w;
        chars++;
    }
    return chars;
}

/**
 * True iff a prose string carries anything worth archiving: at least one
 * alphanumeric character. A stray "/" or "..." in the composer must not
 * become a memory row. (Unicode-aware, like Rust char::is_alphanumeric.)
 * @param {string} s
 */
export function archivableProse(s) {
    return /[\p{L}\p{N}]/u.test(s ?? '');
}

/**
 * Clamp a string to at most `maxBytes` UTF-8 bytes without splitting a
 * code point.
 * @param {string} s
 * @param {number} maxBytes
 */
export function sliceByBytes(s, maxBytes) {
    if (byteLen(s) <= maxBytes) return s;
    let bytes = 0;
    let chars = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        const w = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (bytes + w > maxBytes) break;
        bytes += w;
        chars++;
    }
    return s.slice(0, chars);
}

/**
 * Split text into embeddable chunks under CHUNK_CHAR_BUDGET bytes.
 * Paragraph-first (`\n\n` greedy pack, separator preserved), sentences
 * second (`. ` / `! ` / `? ` with the terminator glued to its sentence),
 * hard char cut last (with the degenerate-tail guard).
 *
 * No overlap; text within the budget passes through as a single chunk.
 * @param {string} text
 * @returns {string[]}
 */
export function chunkText(text) {
    if (byteLen(text) <= CHUNK_CHAR_BUDGET) {
        return [text];
    }
    const out = [];
    // Paragraph-level split on the literal "\n\n" (roleplay text uses plain
    // blank-line paragraphs; separator re-joined on pack keeps structure).
    const paragraphs = text.split('\n\n');
    let acc = '';
    for (const para of paragraphs) {
        const paraToAdd = acc === '' ? para : `${acc}\n\n${para}`;
        if (byteLen(paraToAdd) <= CHUNK_CHAR_BUDGET) {
            acc = paraToAdd; // fits: keep packing
            continue;
        }
        // Adding this paragraph overflows: flush what's accumulated.
        if (acc !== '') {
            out.push(acc);
            acc = '';
        }
        if (byteLen(para) <= CHUNK_CHAR_BUDGET) {
            acc = para; // fits alone: new accumulator
        } else {
            // Paragraph alone exceeds budget: descend to sentences, emitting
            // sentence-packets directly (no accumulator sharing across
            // paragraph boundaries).
            out.push(...splitLongParagraph(para));
        }
    }
    if (acc !== '') {
        out.push(acc);
    }
    // Defensive: caller filters empties before embedding.
    if (out.length === 0) {
        out.push('');
    }
    return out;
}

/**
 * Sentence-level splitter for a paragraph that alone exceeds the budget.
 * Greedy-packs sentences; a run-on longer than the budget gets hard cuts
 * (the only place we ever break inside a sentence), with the tail-floor
 * guard: a cut that would strand < CHUNK_TAIL_FLOOR bytes is shifted back
 * so the tail keeps a minimum size.
 * @param {string} para
 * @returns {string[]}
 */
function splitLongParagraph(para) {
    // Slice at sentence boundaries: terminator + the following space stay
    // glued to the sentence that earned them; the next starts clean.
    const sentences = [];
    let start = 0;
    for (let i = 0; i < para.length - 1; i++) {
        const ch = para[i];
        if ((ch === '.' || ch === '!' || ch === '?') && para[i + 1] === ' ') {
            sentences.push(para.slice(start, i + 2));
            start = i + 2;
            i++;
        }
    }
    if (start < para.length) {
        // Trailing fragment without terminal punctuation is still a sentence
        // (narrative prose often ends mid-paragraph at a quote or a dash).
        sentences.push(para.slice(start));
    }

    // Greedy-pack sentences into budget-sized chunks.
    const out = [];
    let acc = '';
    for (const sentence of sentences) {
        const candidate = acc === '' ? sentence : `${acc}${sentence}`;
        if (byteLen(candidate) <= CHUNK_CHAR_BUDGET) {
            acc = candidate;
            continue;
        }
        if (acc !== '') {
            out.push(acc);
            acc = '';
        }
        if (byteLen(sentence) <= CHUNK_CHAR_BUDGET) {
            acc = sentence;
        } else {
            // Run-on: hard byte cuts on code-point boundaries, with the
            // degenerate-tail guard (no meaningless 1 or 2 char chunks).
            let s = sentence;
            while (byteLen(s) > CHUNK_CHAR_BUDGET) {
                let cut = CHUNK_CHAR_BUDGET;
                const total = byteLen(s);
                if (total - cut < CHUNK_TAIL_FLOOR) {
                    cut = Math.max(1, total - CHUNK_TAIL_FLOOR);
                }
                const cutIdx = charIndexAtByte(s, cut);
                out.push(s.slice(0, cutIdx));
                s = s.slice(cutIdx);
            }
            if (s !== '') {
                acc = s;
            }
        }
    }
    if (acc !== '') {
        out.push(acc);
    }
    return out;
}
