/*
 * Unit tests for the session <-> sequencer codec (node test/session-sequence.test.js).
 *
 * Uses synthetic bodies for the CI-safe checks; if the controlled ground-truth
 * .syx files are present it also verifies the exact decoded notes.
 */
'use strict';
global.window = global;
require('../js/sltemplate.js');
const S = require('../js/session.js');
const fs = require('fs');
const assert = require('assert');
let n = 0;
const ok = (cond, m) => { assert.ok(cond, m); console.log('ok  :', m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m + ' got ' + JSON.stringify(a)); console.log('ok  :', m); n++; };

// ---- synthetic body: empty -> canonical slots -> read gives no notes ----
function emptyBody() {
  const body = new Uint8Array(94208);
  for (let t = 0; t < 8; t++) for (let p = 0; p < 8; p++) {
    const g = S.gridOffset(t, p);
    for (let s = 0; s < 16; s++) {
      const step = g + s * 0x24;
      body[step + 1] = 0x64;
      for (let k = 0; k < 8; k++) body[step + 4 + k * 4 + 1] = 0x60; // empty slot velocity default
    }
  }
  return body;
}

const empty = emptyBody();
const seq0 = S.readSequence(empty);
eq([seq0.tracks.length, seq0.tracks[0].patterns.length, seq0.tracks[0].patterns[0].steps.length], [8, 8, 16], 'read shape 8x8x16');
eq(seq0.tracks[0].patterns[0].steps[0].notes, [], 'empty body -> no notes');
ok(!S.sequenceHasNotes(empty), 'sequenceHasNotes false on empty');

// ---- write notes then read back ----
const seq = S.readSequence(empty);
seq.tracks[0].patterns[0].steps[0].notes = [{ note: 72, velocity: 127, gate: 6 }];
seq.tracks[0].patterns[0].steps[8].notes = [{ note: 60, velocity: 100, gate: 6 }, { note: 64, velocity: 100, gate: 6 }];
seq.tracks[3].patterns[2].steps[15].notes = [{ note: 40, velocity: 1, gate: 24 }];
const written = S.writeSequence(empty, seq);
ok(S.sequenceHasNotes(written), 'sequenceHasNotes true after write');
const seq2 = S.readSequence(written);
eq(seq2.tracks[0].patterns[0].steps[0].notes, [{ note: 72, velocity: 127, gate: 6 }], 'note round-trips');
eq(seq2.tracks[0].patterns[0].steps[8].notes, [{ note: 60, velocity: 100, gate: 6 }, { note: 64, velocity: 100, gate: 6 }], 'chord round-trips (2 notes)');
eq(seq2.tracks[3].patterns[2].steps[15].notes, [{ note: 40, velocity: 1, gate: 24 }], 'note in t3/p2/step16 round-trips');

// writing the read-back of an unmodified body reproduces it byte-for-byte
const rewrite = S.writeSequence(written, seq2);
eq(Buffer.from(rewrite).equals(Buffer.from(written)), true, 'write(read(x)) == x is bit-exact');

// ---- per-field encode/decode (tempo, swing, channel, length, sync, direction, chance, gate/tie) ----
const fseq = S.readSequence(empty);
fseq.tempo = 140; fseq.swing = 60;
fseq.tracks[2].channel = 5;
const fp = fseq.tracks[0].patterns[0];
fp.end = 7; fp.syncRate = '1/8'; fp.direction = 'Ping-Pong';
fp.steps[0].chance = 50;
fp.steps[0].notes = [{ note: 72, velocity: 100, gate: 18 }];        // 3-step gate
fp.steps[1].notes = [{ note: 60, velocity: 90, gate: 6, tie: true }]; // tied note
const fbody = S.writeSequence(empty, fseq);
const fr = S.readSequence(fbody);
eq(fr.tempo, 140, 'tempo round-trips');
eq(fr.swing, 60, 'swing round-trips');
eq(fr.tracks[2].channel, 5, 'per-track channel round-trips');
eq(fr.tracks[0].patterns[0].end, 7, 'pattern length (end) round-trips');
eq(fr.tracks[0].patterns[0].syncRate, '1/8', 'sync rate round-trips');
eq(fr.tracks[0].patterns[0].direction, 'Ping-Pong', 'direction round-trips');
eq(fr.tracks[0].patterns[0].steps[0].chance, 50, 'per-step chance round-trips');
eq(fr.tracks[0].patterns[0].steps[0].notes[0].gate, 18, '3-step gate round-trips');
eq(fr.tracks[0].patterns[0].steps[1].notes[0].tie, true, 'tie flag round-trips');

// ---- optional: ground-truth files ----
const dir = '/root/.claude/uploads/82a8edf0-56ac-5b7c-9549-24618c73766c/';
const files = { A: '6024969a-Session_A.syx', B: 'd11409b2-Session_B.syx', C: 'c1cc618e-Session_C.syx' };
function loadBody(f) { return S.decodeSyx(new Uint8Array(fs.readFileSync(dir + f))).find((x) => x.body.length === 94208).body; }
function flatNotes(body) {
  const seq = S.readSequence(body); const out = [];
  seq.tracks.forEach((tk, t) => tk.patterns.forEach((pt, p) => pt.steps.forEach((st, s) => st.notes.forEach((nt) => out.push({ t, p, s, ...nt })))));
  return out;
}
if (fs.existsSync(dir + files.A)) {
  eq(flatNotes(loadBody(files.A)), [{ t: 0, p: 0, s: 0, note: 72, velocity: 127, gate: 6 }], 'ground-truth A: C3 on step1 only');
  eq(flatNotes(loadBody(files.B)), [
    { t: 0, p: 0, s: 0, note: 72, velocity: 127, gate: 6 },
    { t: 0, p: 0, s: 8, note: 72, velocity: 127, gate: 6 },
  ], 'ground-truth B: C3 on step1 + step9');
  eq(flatNotes(loadBody(files.C)), [
    { t: 0, p: 0, s: 0, note: 72, velocity: 100, gate: 6 },
    { t: 0, p: 0, s: 1, note: 76, velocity: 100, gate: 6 },
  ], 'ground-truth C: C3 step1 + E3 step2, vel100');
} else {
  console.log('skip: ground-truth .syx not present (CI)');
}

console.log('\n' + n + ' assertions passed');
