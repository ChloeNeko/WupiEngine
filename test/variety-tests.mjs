/**
 * Offline tests for the reroll variety note. Run with: npm test
 */
import assert from 'node:assert/strict';
import {
    DEFAULT_VARIETY_DIRECTIVES,
    DEFAULT_VARIETY_TEMPLATE,
    eligibleForVarietyNote,
    parseDirectiveLines,
    buildVarietyNote,
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
        rng: () => 0,
    });
    assert.ok(note.startsWith('[System note:'));
    assert.ok(note.includes(DEFAULT_VARIETY_DIRECTIVES[0]));
    assert.ok(note.includes('(nonce: '));
    assert.ok(!note.includes('{{'));
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
