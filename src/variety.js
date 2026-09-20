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
    // Every line dictates the literal opening shape of the reply. A reroll
    // that only gets a quality ("body language", "short and clipped") can
    // satisfy it with the very reply it was supposed to escape, because the
    // most predictable reply already has those qualities. A shape the
    // default opening cannot fake forces a genuinely different reply.
    'open with a spoken question.',
    'open with a spoken line that is not a question.',
    'open with something the hands do.',
    'open with the whole body already moving.',
    'open with a sound from the room or outside it.',
    'open with a sensory detail of the setting.',
    'open with someone else in the scene reacting first.',
    'open with silence; hold the first spoken line for two more paragraphs.',
    'open mid action, as if the sentence had already begun.',
    'open with the character handling a nearby object.',
    'open with a shift in posture or breathing, and do not name the character in the first sentence.',
    'open with what the light, the weather, or the room itself does.',
]);

export const DEFAULT_VARIETY_TONES = Object.freeze([
    'clipped and terse',
    'slow and sensory',
    'dry and wry',
    'warm and open',
    'tense and coiled',
    'flat and weary',
    'playful and teasing',
    'heated and quick',
]);

export const DEFAULT_VARIETY_TEMPLATE =
    '[System note: this is a fresh take on a reply that already exists. The default opening (the character name followed by an immediate reaction) is banned this time. Shape: {{directive}} Mood: {{tone}} Do not reuse distinctive phrases from earlier replies. (nonce: {{nonce}})]';

/** The v1.2.0 defaults, kept only to upgrade untouched saved settings once. */
export const LEGACY_VARIETY_DIRECTIVES_TEXT = [
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
].join('\n');

export const LEGACY_VARIETY_TEMPLATE =
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
 * Roll the directive and the mood for one reroll. The directive avoids an
 * immediate repeat of the previous roll when the pool has more than one
 * line: two rerolls in a row drawing the same shape read as one shape.
 *
 * @param {object} p
 * @param {string|Array<string>} p.directives one per line, or a ready list
 * @param {string|Array<string>} [p.tones] one per line, or a ready list
 * @param {string} [p.avoid] a directive not to repeat
 * @param {() => number} [p.rng] injectable for tests
 * @returns {{directive: string, tone: string}}
 */
export function rollVariety({ directives, tones, avoid = '', rng = Math.random }) {
    const dLines = Array.isArray(directives)
        ? directives.map((s) => String(s).trim()).filter(Boolean)
        : parseDirectiveLines(directives);
    const tLines = Array.isArray(tones)
        ? tones.map((s) => String(s).trim()).filter(Boolean)
        : parseDirectiveLines(tones);
    return {
        directive: pickAvoiding(dLines, String(avoid ?? ''), rng),
        tone: tLines.length ? tLines[Math.floor(rng() * tLines.length)] : '',
    };
}

function pickAvoiding(lines, avoid, rng) {
    if (!lines.length) return '';
    let pick = lines[Math.floor(rng() * lines.length)];
    if (pick === avoid && lines.length > 1) {
        pick = lines[(lines.indexOf(pick) + 1) % lines.length];
    }
    return pick;
}

/**
 * Build the note for one reroll. {{directive}} and {{tone}} become the
 * rolled lines, {{nonce}} becomes a random marker that only exists to make
 * each request byte-different (backends with a pinned seed or a hot cache
 * replay identical requests). Placeholders the template no longer has are
 * simply not filled in. An empty template means no note at all.
 *
 * @param {object} p
 * @param {string} p.template
 * @param {string|Array<string>} p.directives one per line, or a ready list
 * @param {string|Array<string>} [p.tones] one per line, or a ready list
 * @param {() => number} [p.rng] injectable for tests
 */
export function buildVarietyNote({ template, directives, tones, rng = Math.random }) {
    const tpl = String(template ?? '').trim();
    if (!tpl) return '';
    const lines = Array.isArray(directives)
        ? directives.map((s) => String(s).trim()).filter(Boolean)
        : parseDirectiveLines(directives);
    const tLines = Array.isArray(tones)
        ? tones.map((s) => String(s).trim()).filter(Boolean)
        : parseDirectiveLines(tones);
    const pick = lines.length ? lines[Math.floor(rng() * lines.length)] : '';
    const tonePick = tLines.length ? tLines[Math.floor(rng() * tLines.length)] : '';
    return tpl
        .split('{{directive}}').join(pick)
        .split('{{tone}}').join(tonePick)
        .split('{{nonce}}').join(rollNonce(rng));
}
