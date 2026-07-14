/*
 * studio-library.test.js — template library (#32) + session library (#33) model.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
global.window = global;
for (const f of ['js/studio-sequencer.js', 'js/studio-model.js']) {
  new Function('window', fs.readFileSync(path.join(root, f), 'utf8')).call(global, global);
}
const S = global.SLMK.studio;
const assert = require('assert');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  :', m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); console.log('ok  :', m); n++; };

// ---- Templates (#32) ----
const m = S.newModel();
S.ensureTemplates(m);
ok(m.templates.length === 1 && m.activeTemplate === m.templates[0].id, 'ensureTemplates seeds one active template');
ok(m.templates[0].knobBanks === m.knobBanks, 'active template shares the live sections (edits write through)');

// editing the live sections mutates the active template
m.knobBanks[0][0].name = 'EDITED';
ok(m.templates[0].knobBanks[0][0].name === 'EDITED', 'editing model.knobBanks updates the active template');

// add a new template -> becomes active, distinct sections, prior edits preserved
const t2 = S.addTemplate(m, { name: 'Lead' });
ok(m.templates.length === 2 && m.activeTemplate === t2.id, 'addTemplate creates + selects a new template');
ok(m.knobBanks === t2.knobBanks, 'live sections now point at the new template');
ok(m.templates[0].knobBanks[0][0].name === 'EDITED', 'the first template kept its edits');

// select back
S.selectTemplate(m, m.templates[0].id);
ok(m.knobBanks[0][0].name === 'EDITED', 'selectTemplate re-points the live sections');

// map a template to a Part -> partTemplates + channelTemplates (runtime input)
S.mapTemplateToPart(m, t2.id, 4);
ok(m.partTemplates[4] === t2.id, 'mapTemplateToPart records the mapping');
ok(m.channelTemplates[4] && m.channelTemplates[4].knobBanks, 'mapping materialises a channelTemplate snapshot');
S.unmapPart(m, 4);
ok(!m.partTemplates[4] && !m.channelTemplates[4], 'unmapPart clears both');

// remove keeps at least one and clears mappings
S.mapTemplateToPart(m, t2.id, 0);
S.removeTemplate(m, t2.id);
ok(m.templates.length === 1 && !m.partTemplates[0], 'removeTemplate drops it and clears its part mapping');

// rename
S.renameTemplate(m, m.templates[0].id, 'Renamed');
ok(m.templates[0].name === 'Renamed', 'renameTemplate works');

// ---- Sessions (#33) ----
S.ensureSequencer(m);
m.sequencer.tempo = 155;
S.mapTemplateToPart(m, m.templates[0].id, 2);
const s = S.snapshotSession(m, 'Take 1');
ok(m.sessions.length === 1 && s.sequencer.tempo === 155, 'snapshotSession captures the sequencer');
eq(s.partTemplates[2], m.templates[0].id, 'session records the part->template mapping');

// mutate then load restores
m.sequencer.tempo = 90; S.unmapPart(m, 2);
S.loadSession(m, s.id);
ok(m.sequencer.tempo === 155, 'loadSession restores the sequencer data');
ok(m.partTemplates[2] === m.templates[0].id, 'loadSession restores the part mapping');

// rename + remove
S.renameSession(m, s.id, 'Final');
ok(m.sessions[0].name === 'Final', 'renameSession works');
S.removeSession(m, s.id);
ok(m.sessions.length === 0, 'removeSession works');

// imported Components session -> decodes into a playable session
const enc = global.SLMK.session; // not loaded here; guard
if (enc && enc.newSequenceBody) {
  const body = enc.newSequenceBody();
  const imp = S.addImportedSession(m, 'Imported', body);
  ok(imp.imported && imp.sequencer, 'addImportedSession decodes a playable session');
}

// ---- #35 template import resolves numeric message types (not everything -> CC) ----
const knob0 = { enabled: true, message_type: 3, first_param: 5, channel: 1, from_value: 0, to_value: 127, name: 'PC' }; // 3 = Program Change
const blankKnob = { enabled: false, message_type: 0, first_param: 0, channel: 'default', from_value: 0, to_value: 127, name: '' };
const tpl = { name: 'T', sections: {
  knobs: [knob0].concat(Array.from({ length: 7 }, () => Object.assign({}, blankKnob))),
  faders: [], buttons: [], pad_hits: [], pad_pressures: [], wheels: [], pedals: [], footswitches: [],
} };
const imp2 = S.fromTemplate(tpl);
eq(imp2.knobBanks[0][0].message_type, 'Program Change', '#35 numeric Program Change survives import (not CC)');

// ---- #74 imported knobs carry pivot / step / mode / bit depth ----
const knobP = { enabled: true, message_type: 0, first_param: 10, channel: 1, from_value: 0, to_value: 127, name: 'K', pivot: 64, step: 3, relative: 1, eight_bit: 1, resolution: 616 };
const tplP = { name: 'P', sections: {
  knobs: [knobP].concat(Array.from({ length: 7 }, () => Object.assign({}, blankKnob))),
  faders: [], buttons: [], pad_hits: [], pad_pressures: [], wheels: [], pedals: [], footswitches: [],
} };
const impP = S.fromTemplate(tplP).knobBanks[0][0];
eq(impP.pivot, 64, '#74 imported knob keeps its pivot');
eq(impP.step, 3, '#74 imported knob keeps its step');
eq(impP.mode, 'Relative', '#74 imported knob relative flag -> Relative mode');
eq(impP.bit_depth, '14-bit', '#74 imported knob eight_bit flag -> 14-bit');

console.log('\n' + n + ' library assertions passed');
