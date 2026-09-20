/**
 * FNV-1a 32-bit hash → base36 string. Stable content identity for dedupe
 * keys (the role `getStringHash` plays in the vectors extension).
 * @param {string} s
 * @returns {string}
 */
export function hashString(s) {
    let h = 0x811c9dc5;
    const str = String(s ?? '');
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        // imul keeps the 32-bit multiply exact
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

/** Milliseconds since epoch (mirror of the Rust unix-secs timestamps). */
export function nowTs() {
    return Date.now();
}

/** crypto.randomUUID with fallback. */
export function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}
