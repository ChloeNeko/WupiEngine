/**
 * WupiFilter matching logic. Pure functions with no DOM and no app context,
 * so the same code runs in the live gate, in the tester UI, in slash commands
 * and in the offline tests.
 */

/**
 * Splits text into words and strips edge punctuation such as quotes, commas
 * and markdown markers. Inner punctuation like apostrophes and hyphens is
 * kept so words such as "can't" and "well-thought" stay whole.
 * @param {string} text
 * @returns {string[]}
 */
export function toWords(text) {
    return String(text ?? '')
        .split(/\s+/)
        .map((w) => w.replace(/^[^\p{L}\p{N}'’]+/u, '').replace(/[^\p{L}\p{N}'’]+$/u, ''))
        .filter((w) => w.length > 0);
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses a comma separated blocked list into normalized phrase descriptors.
 * @param {string} raw
 * @param {{caseSensitive?: boolean}} options
 * @returns {{raw: string, needle: string}[]}
 */
export function parsePhrases(raw, { caseSensitive = false } = {}) {
    return String(raw ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => ({ raw: p, needle: caseSensitive ? p : p.toLowerCase() }));
}

/**
 * Checks whether any blocked phrase appears within the first `window` words
 * of the text. Safe on partial streams: a phrase that has not fully arrived
 * yet simply does not match, and it will be caught on a later token.
 * @param {string} text
 * @param {{raw: string, needle: string}[]} phrases
 * @param {{window?: number, caseSensitive?: boolean, wholeWords?: boolean}} options
 * @returns {string | null} The matched phrase as the user typed it, or null.
 */
export function matchFirstWords(text, phrases, { window = 5, caseSensitive = false, wholeWords = true } = {}) {
    if (!Array.isArray(phrases) || phrases.length === 0) return null;
    const words = toWords(text).slice(0, Math.max(1, Math.floor(window)));
    if (words.length === 0) return null;
    const hay = (caseSensitive ? words : words.map((w) => w.toLowerCase())).join(' ');
    for (const phrase of phrases) {
        const needleWords = toWords(phrase.needle);
        if (needleWords.length === 0) continue;
        const needle = needleWords.join(' ');
        if (wholeWords) {
            const re = new RegExp(`(?:^|\\s)${escapeRegExp(needle)}(?:$|\\s)`);
            if (re.test(hay)) return phrase.raw;
        } else if (hay.includes(needle)) {
            return phrase.raw;
        }
    }
    return null;
}
