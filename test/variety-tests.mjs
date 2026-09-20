/**
 * Offline tests for the reroll variety note. Run with: npm test
 */
import assert from 'node:assert/strict';
import {
    DEFAULT_VARIETY_DIRECTIVES,
    DEFAULT_VARIETY_TONES,
    DEFAULT_VARIETY_TEMPLATE,
    LEGACY_VARIETY_DIRECTIVES_TEXT,
    LEGACY_VARIETY_TEMPLATE,
    LEGACY2_VARIETY_DIRECTIVES_TEXT,
    LEGACY2_VARIETY_TEMPLATE,
    LEGACY3_VARIETY_TEMPLATE,
    eligibleForVarietyNote,
    shouldApplyVarietyNote,
    parseDirectiveLines,
    buildVarietyNote,
    rollVariety,
    upgradeVarietyPool,
} from '../src/variety.js';

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`ok ${name}`);
}

check('only reroll types are eligible', () => {
    assert.equal(eligibleForVarietyNote('swipe'), true);
    assert.equal(eligibleForVarietyNote('regenerate'), true);
    assert.equal(eligibleForVarietyNote('normal'), false);
    assert.equal(eligibleForVarietyNote('continue'), false);
    assert.equal(eligibleForVarietyNote('quiet'), false);
    assert.equal(eligibleForVarietyNote('impersonate'), false);
    assert.equal(eligibleForVarietyNote(undefined), false);
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

check('directive lines split, trim and drop empties', () => {
    assert.deepEqual(
        parseDirectiveLines('  Open with dialogue.  \n\nShort and clipped.\n'),
        ['Open with dialogue.', 'Short and clipped.'],
    );
    assert.deepEqual(parseDirectiveLines(''), []);
    assert.deepEqual(parseDirectiveLines('\n \n'), []);
});

check('rng 0 picks the first line, rng near 1 picks the last', () => {
    const lines = ['first.', 'second.', 'third.'];
    const head = buildVarietyNote({ template: '{{directive}}', directives: lines, rng: () => 0 });
    const tail = buildVarietyNote({ template: '{{directive}}', directives: lines, rng: () => 0.999999 });
    assert.equal(head, 'first.');
    assert.equal(tail, 'third.');
});

check('every line of the pool is reachable across rolls', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
        seen.add(buildVarietyNote({
            template: '{{directive}}',
            directives: lines,
            rng: () => i / 100,
        }));
    }
    assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd']);
});

check('directive and nonce placeholders are filled', () => {
    const note = buildVarietyNote({
        template: 'X {{directive}} Y {{nonce}}',
        directives: 'pick me',
        rng: () => 0.42,
    });
    assert.ok(note.includes('pick me'));
    assert.ok(!note.includes('{{directive}}'));
    assert.ok(!note.includes('{{nonce}}'));
    // rng 0.42 as base36: deterministic content, still a non-empty marker
    assert.ok(/Y [a-z0-9]+/.test(note));
});

check('empty template sends no note', () => {
    assert.equal(buildVarietyNote({ template: '', directives: 'x', rng: () => 1 }), '');
    assert.equal(buildVarietyNote({ template: '   ', directives: 'x', rng: () => 1 }), '');
});

check('empty directive list leaves no leftover placeholder', () => {
    const note = buildVarietyNote({ template: 'note {{directive}} end {{nonce}}', directives: '', rng: () => 0.5 });
    assert.ok(!note.includes('{{directive}}'));
    assert.equal(note.startsWith('note  end'), true);
});

check('template without placeholders passes through except nothing', () => {
    const note = buildVarietyNote({ template: 'plain note', directives: 'x', rng: () => 0.1 });
    assert.equal(note, 'plain note');
});

check('array input works like the textarea text', () => {
    const fromList = buildVarietyNote({ template: '{{directive}}', directives: [' one ', '', 'two'], rng: () => 0 });
    assert.equal(fromList, 'one');
});

check('default pool and template compose into a sane note', () => {
    const note = buildVarietyNote({
        template: DEFAULT_VARIETY_TEMPLATE,
        directives: DEFAULT_VARIETY_DIRECTIVES,
        tones: DEFAULT_VARIETY_TONES,
        rng: () => 0,
    });
    assert.ok(note.startsWith('[System note:'));
    assert.ok(note.includes(DEFAULT_VARIETY_DIRECTIVES[0]));
    assert.ok(note.includes(DEFAULT_VARIETY_TONES[0]));
    assert.ok(note.includes('(nonce: '));
    assert.ok(!note.includes('{{'));
    // Chloe's standing requirement: the note suggests structure, it never
    // bans words or moves.
    assert.ok(!note.includes('banned'));
    assert.ok(!note.includes('off limits'));
});

check('every default directive dictates the opening shape', () => {
    // The point of the v1.2.2 rewrite: a quality like "body language" can be
    // satisfied by the very clone the reroll is escaping, a required opening
    // shape cannot.
    for (const line of DEFAULT_VARIETY_DIRECTIVES) {
        assert.ok(line.startsWith('open '), line);
    }
});

check('rollVariety avoids repeating the previous directive', () => {
    const lines = ['a.', 'b.', 'c.'];
    assert.equal(rollVariety({ directives: lines, rng: () => 0 }).directive, 'a.');
    assert.equal(rollVariety({ directives: lines, avoid: 'a.', rng: () => 0 }).directive, 'b.');
});

check('rollVariety repeats a single line even when avoided', () => {
    assert.equal(rollVariety({ directives: ['only.'], avoid: 'only.', rng: () => 0 }).directive, 'only.');
});

check('rollVariety rolls a mood only when the list has lines', () => {
    assert.equal(rollVariety({ directives: 'd.', tones: 'calm\nheated', rng: () => 0.99 }).tone, 'heated');
    assert.equal(rollVariety({ directives: 'd.', rng: () => 0 }).tone, '');
});

check('buildVarietyNote fills the tone placeholder', () => {
    const note = buildVarietyNote({ template: 'S: {{directive}} M: {{tone}}', directives: 'x.', tones: 'y', rng: () => 0 });
    assert.equal(note, 'S: x. M: y');
});

check('upgradeVarietyPool moves an untouched legacy pool to the current one', () => {
    const r = upgradeVarietyPool({
        version: 0,
        directives: LEGACY_VARIETY_DIRECTIVES_TEXT,
        template: LEGACY_VARIETY_TEMPLATE,
        tones: '',
    });
    assert.equal(r.changed, true);
    assert.equal(r.fields.varietyDirectives, DEFAULT_VARIETY_DIRECTIVES.join('\n'));
    assert.equal(r.fields.varietyNoteTemplate, DEFAULT_VARIETY_TEMPLATE);
    assert.equal(r.fields.varietyTones, DEFAULT_VARIETY_TONES.join('\n'));
    assert.equal(r.fields.varietyPoolVersion, 4);
});

check('upgradeVarietyPool survives windows line endings and stray whitespace', () => {
    const dirty = LEGACY_VARIETY_DIRECTIVES_TEXT.replace(/\n/g, '\r\n') + '\r\n';
    const r = upgradeVarietyPool({ version: 2, directives: dirty, template: LEGACY_VARIETY_TEMPLATE + ' ', tones: 'calm' });
    assert.equal(r.fields.varietyDirectives, DEFAULT_VARIETY_DIRECTIVES.join('\n'));
    assert.equal(r.fields.varietyNoteTemplate, DEFAULT_VARIETY_TEMPLATE);
    assert.equal(r.fields.varietyTones, undefined); // a filled tone list is kept
});

check('upgradeVarietyPool also lifts the v1.2.2 pool', () => {
    const r = upgradeVarietyPool({
        version: 2,
        directives: LEGACY2_VARIETY_DIRECTIVES_TEXT,
        template: LEGACY2_VARIETY_TEMPLATE,
        tones: DEFAULT_VARIETY_TONES.join('\n'),
    });
    assert.equal(r.fields.varietyDirectives, DEFAULT_VARIETY_DIRECTIVES.join('\n'));
    assert.equal(r.fields.varietyNoteTemplate, DEFAULT_VARIETY_TEMPLATE);
});

check('upgradeVarietyPool lifts the v1.2.3 template that banned words', () => {
    const r = upgradeVarietyPool({
        version: 3,
        directives: DEFAULT_VARIETY_DIRECTIVES.join('\n'),
        template: LEGACY3_VARIETY_TEMPLATE,
        tones: DEFAULT_VARIETY_TONES.join('\n'),
    });
    assert.equal(r.changed, true);
    assert.equal(r.fields.varietyNoteTemplate, DEFAULT_VARIETY_TEMPLATE);
    assert.ok(!DEFAULT_VARIETY_TEMPLATE.includes('off limits'));
});

check('upgradeVarietyPool never touches a customized pool', () => {
    const mine = 'open with my own custom line.\nopen with another one.';
    const r = upgradeVarietyPool({ version: 0, directives: mine, template: 'do {{directive}} things', tones: 'calm' });
    assert.equal(r.fields.varietyDirectives, undefined);
    assert.equal(r.fields.varietyNoteTemplate, undefined);
    assert.equal(r.fields.varietyTones, undefined);
    assert.equal(r.fields.varietyPoolVersion, 4);
});

check('upgradeVarietyPool is a no-op at the current version', () => {
    assert.equal(upgradeVarietyPool({ version: 4, directives: 'anything', template: 'x', tones: 'y' }).changed, false);
});

check('rolls actually differ for the model', () => {
    const notes = new Set();
    for (let i = 0; i < 20; i++) {
        notes.add(buildVarietyNote({
            template: DEFAULT_VARIETY_TEMPLATE,
            directives: DEFAULT_VARIETY_DIRECTIVES,
        }));
    }
    // With 10 directives and fresh nonces, 20 rolls must not collapse to one.
    assert.ok(notes.size > 1, `expected variety, got ${notes.size} unique note(s)`);
});

console.log(`all ${passed} tests passed`);
