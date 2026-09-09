const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { score, NEUTRAL, CONFLICTING } = require('../tools/dev-probes/probe-toolresult.js');

// The acceptance gate for the tool_result image fix shipped twice with an oracle that
// could not fail. Version 1 matched /magenta/ against a raw answer while the file being
// read was named magenta.png. Version 2 stripped the filename from the ANSWER, but the
// filename still travelled in the PROMPT — inside the folded call and the ledger line
// `#1 Read {"path":"magenta.png"} -> ...` — so a model that merely echoed it still scored
// as having seen the image. Measured: with that filename, the cell where the image is
// provably never uploaded scored SEES_IMAGE 2/2.
//
// The probe now uses colour-neutral and colour-CONFLICTING filenames, and this pins the
// scorer so the next revision cannot quietly become unfalsifiable again.
describe('probe-toolresult oracle', () => {
  it('the fixture names carry no colour, or the wrong one', () => {
    assert.doesNotMatch(NEUTRAL, /magenta|rosa|fucsia|pink/i, 'a neutral fixture name must not leak the answer');
    assert.match(CONFLICTING, /azul/i, 'the conflicting fixture must name a DIFFERENT colour than the pixels');
  });

  it('an answer that only repeats the filename is not a sighting', () => {
    assert.notEqual(score('magenta.png', 'magenta.png'), 'PIXELS');
    assert.notEqual(score('El archivo magenta.png', 'magenta.png'), 'PIXELS');
  });

  it('separates pixels from filename when the two disagree', () => {
    assert.equal(score('Magenta', CONFLICTING), 'PIXELS');
    assert.equal(score('Azul', CONFLICTING), 'FILENAME');
    assert.equal(score('azul.png', CONFLICTING), 'OTHER', 'the filename alone says nothing');
  });

  it('a refusal is scored as a refusal even when it names the colour', () => {
    assert.equal(score('NO_IMAGE', NEUTRAL), 'NO_IMAGE');
    assert.equal(score('No puedo ver ninguna imagen magenta en el contexto.', NEUTRAL), 'NO_IMAGE');
    assert.equal(score('I cannot see any image', NEUTRAL), 'NO_IMAGE');
  });

  it('recognises the colour from the pixels under a neutral name', () => {
    assert.equal(score('Magenta', NEUTRAL), 'PIXELS');
    assert.equal(score('El color dominante es fucsia.', NEUTRAL), 'PIXELS');
    assert.equal(score('Verde', NEUTRAL), 'OTHER');
  });
});
