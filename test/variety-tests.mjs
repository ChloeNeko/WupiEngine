/**
 * Offline tests for the reroll variety note. Run with: npm test
 */
import assert from 'node:assert/strict';
import {
    DEFAULT_VARIETY_TEMPLATE,
    LEGACY_VARIETY_TEMPLATE,
    LEGACY2_VARIETY_TEMPLATE,
    LEGACY3_VARIETY_TEMPLATE,
    LEGACY4_VARIETY_TEMPLATE,
    VARIETY_NOTE_VERSION,
    shouldApplyVarietyNote,
    upgradeVarietyNote,
} from '../src/variety.js';

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`ok ${name}`);
}

check('default note is one short generic line', () => {
    assert.ok(DEFAULT_VARIETY_TEMPLATE.startsWith('[System note:'));
    assert.ok(DEFAULT_VARIETY_TEMPLATE.includes('different'));
    // Chloe's standing requirement: no placeholders, no random markers, no
    // examples, no prescribed shapes or moods, nothing genre specific.
    assert.ok(!DEFAULT_VARIETY_TEMPLATE.includes('{{'));
    assert.ok(!DEFAULT_VARIETY_TEMPLATE.toLowerCase().includes('nonce'));
    assert.ok(!DEFAULT_VARIETY_TEMPLATE.includes('Shape:'));
    assert.ok(!DEFAULT_VARIETY_TEMPLATE.includes('Mood:'));
    assert.ok(DEFAULT_VARIETY_TEMPLATE.length < 200);
});

check('shouldApply: known reroll types always apply', () => {
    const charMsg = { is_user: false };
    const userMsg = { is_user: true };
    assert.equal(shouldApplyVarietyNote('swipe', charMsg), true);
    assert.equal(shouldApplyVarietyNote('regenerate', userMsg), true);
});

check('shouldApply: known non-reroll types never apply', () => {
    const charMsg = { is_user: false };
    for (const t of ['normal', 'group', 'append', 'continue', 'impersonate', 'quiet', 'notify']) {
        assert.equal(shouldApplyVarietyNote(t, charMsg), false, `type ${t}`);
    }
});

check('shouldApply: unknown type falls back to the saved chat', () => {
    // A reroll replaces a character reply, so the chat ends with it.
    assert.equal(shouldApplyVarietyNote('', { is_user: false }), true);
    assert.equal(shouldApplyVarietyNote(undefined, { is_user: false }), true);
    assert.equal(shouldApplyVarietyNote('weirdHostType', { is_user: false }), true);
    // A fresh send has just appended the player's message.
    assert.equal(shouldApplyVarietyNote('', { is_user: true }), false);
    assert.equal(shouldApplyVarietyNote(undefined, { is_user: true }), false);
    assert.equal(shouldApplyVarietyNote('weirdHostType', { is_user: true }), false);
    // Nothing saved yet (first message ever): not a reroll.
    assert.equal(shouldApplyVarietyNote('', null), false);
    assert.equal(shouldApplyVarietyNote(undefined, undefined), false);
});

check('upgrade replaces every older default note', () => {
    const olds = [
        [0, LEGACY_VARIETY_TEMPLATE],
        [2, LEGACY2_VARIETY_TEMPLATE],
        [3, LEGACY3_VARIETY_TEMPLATE],
        [4, LEGACY4_VARIETY_TEMPLATE],
    ];
    for (const [version, template] of olds) {
        const r = upgradeVarietyNote({ version, template });
        assert.equal(r.changed, true, `version ${version}`);
        assert.equal(r.fields.varietyNoteTemplate, DEFAULT_VARIETY_TEMPLATE);
        assert.equal(r.fields.varietyPoolVersion, VARIETY_NOTE_VERSION);
    }
});

check('upgrade survives stray whitespace around an old default', () => {
    const r = upgradeVarietyNote({ version: 4, template: LEGACY4_VARIETY_TEMPLATE + ' \r\n' });
    assert.equal(r.fields.varietyNoteTemplate, DEFAULT_VARIETY_TEMPLATE);
});

check('upgrade keeps a hand edited note', () => {
    const r = upgradeVarietyNote({ version: 0, template: 'my own note words' });
    assert.equal(r.fields.varietyNoteTemplate, undefined);
    assert.equal(r.fields.varietyPoolVersion, VARIETY_NOTE_VERSION);
});

check('upgrade is a no-op at the current version', () => {
    assert.equal(upgradeVarietyNote({ version: VARIETY_NOTE_VERSION, template: 'anything' }).changed, false);
});

console.log(`all ${passed} tests passed`);
