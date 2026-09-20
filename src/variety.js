/**
 * The reroll variety note. A reroll (swipe or regenerate) sends the exact
 * same prompt as the attempt before it, so the model keeps landing on the
 * same most-likely reply ("Fit. Sure." three times out of four).
 *
 * The note is one short, generic instruction: this is a reroll, write a
 * different version. No examples, no prescribed shapes, no mood lists, no
 * random markers. Chloe, 2026-09-20: pools and examples overcomplicated it
 * and assumed NPC fiction, while his roleplays can be RPGs or anything
 * else, so the note must assume nothing about the kind of game being
 * played. Pure functions only, so this file runs in the offline test suite.
 */

/** The one note sent with every reroll. Empty means no note at all. */
export const DEFAULT_VARIETY_TEMPLATE =
    '[System note: this is a reroll of a reply that was just discarded. Write a new, clearly different version of it.]';

/** Older default notes, kept only to upgrade untouched saved settings once. */
export const LEGACY_VARIETY_TEMPLATE =
    '[System note: take a fresh angle on this reply instead of the most predictable one. {{directive}} Avoid reusing distinctive phrases from earlier in the chat. (nonce: {{nonce}})]';
export const LEGACY2_VARIETY_TEMPLATE =
    '[System note: this is a fresh take on a reply that already exists. The default opening (the character name followed by an immediate reaction) is banned this time. Shape: {{directive}} Mood: {{tone}} Do not reuse distinctive phrases from earlier replies. (nonce: {{nonce}})]';
export const LEGACY3_VARIETY_TEMPLATE =
    '[System note: this is a fresh take on a reply that already exists, not a touch up of the old one. Do not open with the character name plus an instant reaction, and do not slide back into that default after the first sentence. Stock reaction beats (scoffing, smirking, eye rolling, sighing) are off limits in this reply. Shape: {{directive}} Mood: {{tone}} Do not reuse distinctive phrases from earlier replies. (nonce: {{nonce}})]';
export const LEGACY4_VARIETY_TEMPLATE =
    '[System note: this is a fresh take on a reply that already exists, so make this version genuinely different. Shape: {{directive}} Mood: {{tone}} Do not reuse distinctive phrases from earlier replies. (nonce: {{nonce}})]';

/**
 * Kept under its historical name varietyPoolVersion because that is the
 * saved settings key; bumped whenever the default note changes so untouched
 * saved notes upgrade once.
 */
export const VARIETY_NOTE_VERSION = 5;

function normalizeTemplateText(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Upgrade the saved variety note. A saved note that still matches an older
 * default (line endings and stray whitespace normalized) moves to the
 * current one once. A hand-edited note belongs to its owner and is never
 * touched. The version stamp must never live in the defaults: this host
 * hydrates saved settings after the extension initializes, so the caller
 * re-runs this lazily before each reroll note is built, when the saved
 * settings are guaranteed to be in place.
 *
 * @param {object} p
 * @param {number|string} [p.version] saved varietyPoolVersion, if any
 * @param {string} [p.template]
 * @returns {{changed: boolean, fields: object}} fields to assign when changed
 */
export function upgradeVarietyNote({ version = 0, template = '' }) {
    if ((Number(version) || 0) >= VARIETY_NOTE_VERSION) return { changed: false, fields: {} };
    const tpl = normalizeTemplateText(template);
    const isDefault = !tpl
        || [LEGACY_VARIETY_TEMPLATE, LEGACY2_VARIETY_TEMPLATE, LEGACY3_VARIETY_TEMPLATE, LEGACY4_VARIETY_TEMPLATE]
            .some((k) => normalizeTemplateText(k) === tpl);
    const fields = { varietyPoolVersion: VARIETY_NOTE_VERSION };
    if (isDefault) {
        fields.varietyNoteTemplate = DEFAULT_VARIETY_TEMPLATE;
    }
    return { changed: true, fields };
}

/** Reroll generation types: alternatives to a reply that already exists. */
const REROLL_TYPES = new Set(['swipe', 'regenerate']);

/**
 * Types that are definitely not a reroll of an existing reply. Each of them
 * builds on a prompt that already differs from the attempt before it.
 */
const NON_REROLL_TYPES = new Set(['normal', 'group', 'append', 'continue', 'impersonate', 'quiet', 'notify']);

/**
 * Eligibility for the note. Hosts differ in what type string they hand
 * extensions, so an unknown or missing type falls back to the saved chat:
 * a reroll replaces a model reply (the chat ends with the model's
 * message), while a fresh send has just appended the player's message.
 */
export function shouldApplyVarietyNote(type, lastSavedMessage) {
    const t = String(type ?? '');
    if (REROLL_TYPES.has(t)) return true;
    if (NON_REROLL_TYPES.has(t)) return false;
    if (!lastSavedMessage) return false;
    return !lastSavedMessage.is_user;
}
