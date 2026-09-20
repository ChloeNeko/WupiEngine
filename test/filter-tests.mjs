/**
 * Offline tests for the WupiFilter matcher. Run with: npm test
 */
import assert from 'node:assert/strict';
import { toWords, parsePhrases, matchFirstWords } from '../src/matcher.js';

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`ok ${name}`);
}

const phrases = parsePhrases('sorry, i apologize');

check('word splitting strips edge punctuation and markdown', () => {
    assert.deepEqual(toWords('*"Sorry," everyone'), ['Sorry', 'everyone']);
    assert.deepEqual(toWords('- can\'t stop'), ['can\'t', 'stop']);
    assert.deepEqual(toWords('   '), []);
});

check('blocks sorry as the first word', () => {
    assert.equal(matchFirstWords('Sorry, I can not help with that.', phrases, { window: 5 }), 'sorry');
});

check('blocks sorry deeper in the window', () => {
    assert.equal(matchFirstWords('I am so sorry about this.', phrases, { window: 5 }), 'sorry');
});

check('ignores sorry past the window', () => {
    assert.equal(matchFirstWords('He said nothing at all, sorry.', phrases, { window: 5 }), null);
    assert.equal(matchFirstWords('He said nothing at all, sorry.', phrases, { window: 6 }), 'sorry');
});

check('partial streams do not match early', () => {
    assert.equal(matchFirstWords('Sor', phrases, { window: 5 }), null);
    assert.equal(matchFirstWords('Sor', phrases, { window: 5, wholeWords: false }), null);
    assert.equal(matchFirstWords('Sorry', phrases, { window: 5 }), 'sorry');
});

check('multi word phrases match across the window', () => {
    assert.equal(matchFirstWords('I apologize for the confusion here.', phrases, { window: 5 }), 'i apologize');
    assert.equal(matchFirstWords('And I apologize again.', phrases, { window: 5 }), 'i apologize');
    assert.equal(matchFirstWords('Well, I guess I apologize.', phrases, { window: 5 }), 'i apologize');
    assert.equal(matchFirstWords('Well, I guess that I apologize.', phrases, { window: 5 }), null);
});

check('whole word matching keeps fragments out', () => {
    assert.equal(matchFirstWords('Sorry-ish tone today.', phrases, { window: 5 }), null);
    assert.equal(matchFirstWords('Sorry-ish tone today.', phrases, { window: 5, wholeWords: false }), 'sorry');
    assert.equal(matchFirstWords('SORRIEST day ever.', phrases, { window: 5 }), null);
});

check('case sensitivity is respected', () => {
    const csPhrases = parsePhrases('sorry', { caseSensitive: true });
    assert.equal(matchFirstWords('Sorry, no.', csPhrases, { window: 5, caseSensitive: true }), null);
    assert.equal(matchFirstWords('sorry, no.', csPhrases, { window: 5, caseSensitive: true }), 'sorry');
});

check('empty and missing input is safe', () => {
    assert.equal(matchFirstWords('', phrases, { window: 5 }), null);
    assert.equal(matchFirstWords(undefined, phrases, { window: 5 }), null);
    assert.equal(matchFirstWords('sorry', [], { window: 5 }), null);
});

check('empty phrase list produces no phrases', () => {
    assert.deepEqual(parsePhrases(' , ,'), []);
    assert.deepEqual(parsePhrases(''), []);
});

console.log(`all ${passed} tests passed`);
