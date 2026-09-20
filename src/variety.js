/**
 * The reroll variety note. A reroll (swipe or regenerate) sends the exact
 * same prompt as the attempt before it, so the model keeps landing on the
 * same most-likely reply ("Fit. Sure." three times out of four).
 *
 * The note breaks that loop by adding one randomly rolled creative
 * constraint to each reroll. A different constraint shifts what the most
 * likely continuation is, so the replies genuinely differ.
 *
 * The note never mentions the previous attempt and never quotes it. The
 * model cannot see the old reply (a reroll removes it from the prompt), and
 * showing it as a "do not do this" example would only seed those exact
 * words. Pure functions only, so this file runs in the offline test suite.
 */

export const DEFAULT_VARIETY_DIRECTIVES = Object.freeze([
    'Open the reply with spoken dialogue.',
    'Open the reply with an action or a gesture, no dialogue.',
    'Open the reply with body language or a small scene detail.',
    "Let the character's mood change partway through the reply.",
    'Keep the reply short and clipped.',
    'Take a slower pace with more sensory detail.',
    'Have the character deflect, stall, or answer with a question.',
    'Add one new small detail or story beat.',
    'Focus on what the character does, not what they say.',
    "Let the character say the opposite of what they feel.",
]);

export const DEFAULT_VARIETY_TEMPLATE =
    '[System note: take a fresh angle on this reply instead of the most predictable one. {{directive}} Avoid reusing distinctive phrases from earlier in the chat. (nonce: {{nonce}})]';

/** Reroll generation types: alternatives to a reply that already exists. */
const REROLL_TYPES = new Set(['swipe', 'regenerate']);

/** Only rerolls get the note. First replies and continuations are left alone. */
export function eligibleForVarietyNote(type) {
    return REROLL_TYPES.has(String(type ?? ''));
}

/**
 * Types that are definitely not a reroll of an existing reply. Each of them
 * builds on a prompt that already differs from the attempt before it.
 */
const NON_REROLL_TYPES = new Set(['normal', 'group', 'append', 'continue', 'impersonate', 'quiet', 'notify']);

/**
 * The flexible eligibility used at the prompt interceptor. Hosts differ in
 * what type string they hand extensions, so an unknown or missing type
 * falls back to the saved chat: a reroll replaces a character reply (the
 * chat ends with the character's message), while a fresh send has just
 * appended the player's message.
 */
export function shouldApplyVarietyNote(type, lastSavedMessage) {
    const t = String(type ?? '');
    if (REROLL_TYPES.has(t)) return true;
    if (NON_REROLL_TYPES.has(t)) return false;
    if (!lastSavedMessage) return false;
    return !lastSavedMessage.is_user;
}

/** One directive per non-empty line, trimmed. */
export function parseDirectiveLines(text) {
    return String(text ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
}

function rollNonce(rng) {
    const raw = rng().toString(36).slice(2, 10);
    return raw || '0';
}

/**
 * Build the note for one reroll. {{directive}} becomes one random line from
 * the pool, {{nonce}} becomes a random marker that only exists to make each
 * request byte-different (backends with a pinned seed or a hot cache replay
 * identical requests). Placeholders the template no longer has are simply
 * not filled in. An empty template means no note at all.
 *
 * @param {object} p
 * @param {string} p.template
 * @param {string|Array<string>} p.directives one per line, or a ready list
 * @param {() => number} [p.rng] injectable for tests
 */
export function buildVarietyNote({ template, directives, rng = Math.random }) {
    const tpl = String(template ?? '').trim();
    if (!tpl) return '';
    const lines = Array.isArray(directives)
        ? directives.map((s) => String(s).trim()).filter(Boolean)
        : parseDirectiveLines(directives);
    const pick = lines.length ? lines[Math.floor(rng() * lines.length)] : '';
    return tpl
        .split('{{directive}}').join(pick)
        .split('{{nonce}}').join(rollNonce(rng));
}
