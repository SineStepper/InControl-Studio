/*
 * studio-runtime.js — wires the Studio engine to live MIDI (P3b).
 *
 * Listens to the SL MkIII InControl input, resolves each control, runs it
 * through the engine per the current model/bank/channel, sends the resulting
 * MIDI to a destination port, and pushes per-state LED colours back to the SL.
 * Handles the navigation buttons (bank paging, channel) too.
 *
 * A browser can't create a virtual port, so the destination is an existing port
 * (IAC / loopMIDI); the Electron app exposes its own virtual port. Same model as
 * the Bridge tab.
 */
(function (global) {
  'use strict';
  const { midi, incontrol, engine } = global.SLMK;
  const SEQ = () => global.SLMK.sequencer;
  const studio = () => global.SLMK.studio;

  const st = { running: false, rt: null, unsub: null, keysUnsub: null, slInId: null, slOutId: null, destId: null, keysInId: null, log: [],
    seqRt: null, clock: null, recording: false, gridTrack: 0, mod: null, dupFrom: null, stepCbs: [],
    heldPads: new Set(), heldKeys: new Map(), shift: false, audition: new Map(), recRef: new Map() };
  const $ = (s) => document.querySelector(s);
  const el = (t, p = {}, c = []) => { const n = document.createElement(t); Object.assign(n, p); (Array.isArray(c) ? c : [c]).forEach((x) => n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x)); return n; };

  function mapControl(name) {
    let m;
    if ((m = /^Pad (\d+)$/.exec(name))) return { group: 'pad', index: +m[1] - 1 };
    if ((m = /^Knob (\d+)$/.exec(name))) return { group: 'knob', index: +m[1] - 1 };
    if ((m = /^Fader (\d+)$/.exec(name))) return { group: 'fader', index: +m[1] - 1 };
    if ((m = /^Soft (\d+)$/.exec(name))) { const i = +m[1] - 1; return i < 16 ? { group: 'button', index: i } : null; }
    return null;
  }

  function fill(sel, ports, selId) {
    if (!sel) return;
    sel.innerHTML = '';
    if (!ports.length) { sel.appendChild(el('option', { value: '' }, '(none)')); sel.disabled = true; return; }
    sel.disabled = false;
    ports.forEach((p) => sel.appendChild(el('option', { value: p.id, selected: p.id === selId }, p.name)));
  }
  function refreshPorts() {
    const outs = midi.outputPorts(), ins = midi.inputPorts();
    if (!st.slInId) st.slInId = midi.guessDefaultInputId();
    if (!st.slOutId) st.slOutId = midi.guessDefaultOutputId();
    if (!st.keysInId) st.keysInId = midi.guessDefaultKeysInputId();
    fill($('#se-in'), ins, st.slInId);
    fill($('#se-out'), outs, st.slOutId);
    fill($('#se-dest'), outs, st.destId);
    fill($('#se-keys'), ins, st.keysInId);
  }

  function log(m) { st.log.unshift(m); st.log = st.log.slice(0, 6); const n = $('#se-log'); if (n) n.textContent = st.log.join('   '); }
  function refreshLeds() { engine.ledMessages(st.rt).forEach((mb) => midi.sendToOutput(st.slOutId, mb)); }

  const sysex = global.SLMK.sysex;
  // Put the SL screens into knob layout and show the current bank's names + values.
  function refreshKnobScreens() {
    if (!st.slOutId || !sysex || !st.rt) return;
    midi.sendToOutput(st.slOutId, sysex.screenLayout(1)); // Knob Layout
    const bank = st.rt.model.knobBanks[st.rt.knobBank] || [];
    for (let i = 0; i < 8; i++) {
      const a = bank[i];
      midi.sendToOutput(st.slOutId, sysex.screenText(i, 0, a ? (a.name || 'Knob ' + (i + 1)) : ''));
      const v = engine.knobDisplay(st.rt, i);
      if (v != null) midi.sendToOutput(st.slOutId, sysex.screenValue(i, 0, v));
    }
  }
  function sendKnobValue(index) {
    if (!st.slOutId || !sysex) return;
    const v = engine.knobDisplay(st.rt, index);
    if (v != null && index < 8) midi.sendToOutput(st.slOutId, sysex.screenValue(index, 0, v));
  }

  // ---- sequencer clock / transport ----
  function model() { return global.SLMK.studioState ? global.SLMK.studioState.getModel() : null; }
  function ensureSeqRt() {
    const m = model(); if (!m) return null;
    studio().ensureSequencer(m);
    if (!st.seqRt || st.seqRt.seq !== m.sequencer) st.seqRt = SEQ().makeSeqRuntime(m.sequencer);
    return st.seqRt;
  }
  function tickInterval() { const t = (st.seqRt && st.seqRt.seq.tempo) || 120; return Math.max(4, Math.round(60000 / t / SEQ().PPQN)); }
  function clockTick() {
    const events = SEQ().onTick(st.seqRt);
    events.forEach((e) => { const msg = e.type === 'on' ? [0x90 | e.channel, e.note & 0x7f, e.velocity & 0x7f] : [0x80 | e.channel, e.note & 0x7f, 0]; if (st.destId) midi.sendToOutput(st.destId, msg); });
    if (st.rt && st.rt.padMode === 'sequencer') refreshGrid();
    st.stepCbs.forEach((cb) => { try { cb(); } catch (e) {} });
  }
  function seqPlay() {
    const rt = ensureSeqRt(); if (!rt) return;
    SEQ().start(rt);
    if (st.clock) clearInterval(st.clock);
    st.clock = setInterval(clockTick, tickInterval());
    notify();
  }
  function seqStop() {
    if (st.clock) { clearInterval(st.clock); st.clock = null; }
    if (st.seqRt) SEQ().stop(st.seqRt).forEach((e) => { if (st.destId) midi.sendToOutput(st.destId, [0x80 | e.channel, e.note & 0x7f, 0]); });
    if (st.rt && st.rt.padMode === 'sequencer') refreshGrid();
    notify();
  }
  const seqIsPlaying = () => !!st.clock;
  function notify() { st.stepCbs.forEach((cb) => { try { cb(); } catch (e) {} }); }

  // ---- pad grid (step editing + play head) in sequencer mode ----
  function gridPattern() { const m = model(); if (!m || !m.sequencer) return null; const t = m.sequencer.tracks[st.gridTrack]; return t.patterns[t.activePattern]; }
  function pagePattern(dir) {
    const m = model(); if (!m || !m.sequencer) return;
    const t = m.sequencer.tracks[st.gridTrack];
    t.activePattern = (t.activePattern + dir + SEQ().PATTERNS) % SEQ().PATTERNS;
    if (st.rt && st.rt.padMode === 'sequencer') refreshGrid();
    notify(); log('pattern ' + (t.activePattern + 1));
  }
  function refreshGrid() {
    if (!st.slOutId || !global.SLMK.sysex) return;
    const p = gridPattern(); if (!p) return;
    const sysex = global.SLMK.sysex;
    const head = st.seqRt ? st.seqRt.pos[st.gridTrack].pad : -1;
    for (let i = 0; i < 16; i++) {
      let hex = '#0a0a0a';
      if (SEQ().stepHasNotes(p, i)) hex = '#3bd0ff';
      if (seqIsPlaying() && i === head) hex = '#ffffff';
      const { r, g, b } = sysex.hexTo7bit(hex);
      midi.sendToOutput(st.slOutId, sysex.ledRgb(38 + i, r, g, b, 'solid'));
    }
  }

  const trackChan = () => { const m = model(); return m && m.sequencer ? (m.sequencer.tracks[st.gridTrack].channel - 1) & 0x0f : 0; };
  function auditionStep(p, step, on) {
    if (!st.destId) return;
    const ch = trackChan();
    p.steps[step].notes.forEach((n) => midi.sendToOutput(st.destId, on ? [0x90 | ch, n.note & 0x7f, n.velocity & 0x7f] : [0x80 | ch, n.note & 0x7f, 0]));
  }
  function transposeCurrent(semi) { const p = gridPattern(); if (p && SEQ().transposePattern(p, semi)) { refreshGrid(); notify(); log('transpose ' + (semi > 0 ? '+' : '') + semi); } }

  // Keyboard input (SL regular port). Three roles, exactly like the built-in
  // sequencer: assign notes to held steps, live-record, and monitor to output.
  function onKeys(bytes) {
    const status = bytes[0] & 0xf0;
    const note = bytes[1], vel = bytes[2];
    const isOn = status === 0x90 && vel > 0;
    const isOff = status === 0x80 || (status === 0x90 && vel === 0);
    if (st.destId) midi.sendToOutput(st.destId, bytes); // monitor through
    if (isOn) {
      st.heldKeys.set(note, vel);
      // Hold pad(s) + press key -> toggle that note on those steps.
      if (st.heldPads.size && st.rt && st.rt.padMode === 'sequencer') {
        const p = gridPattern(); if (p) { st.heldPads.forEach((step) => SEQ().toggleStepNote(p, step, note, vel, 6)); refreshGrid(); notify(); log('note ' + note + ' -> steps'); }
        return;
      }
      if (st.recording && seqIsPlaying()) recordNoteOn(note, vel);
    } else if (isOff) {
      st.heldKeys.delete(note);
      if (st.recording && seqIsPlaying()) recordNoteOff(note);
    }
  }
  function recordNoteOn(note, velocity) {
    const p = gridPattern(); if (!p) return;
    const step = st.seqRt ? st.seqRt.pos[st.gridTrack].pad : 0; // quantise to the current step
    const s = p.steps[step];
    let n = s.notes.find((x) => x.note === note);
    if (!n) { n = { note, velocity, gate: 6 }; s.notes.push(n); }
    st.recRef.set(note, { n, startTick: st.seqRt.tick });
    if (st.rt && st.rt.padMode === 'sequencer') refreshGrid();
    notify(); log('● rec ' + note + ' @step ' + (step + 1));
  }
  function recordNoteOff(note) {
    const ref = st.recRef.get(note); if (!ref) return;
    st.recRef.delete(note);
    const p = gridPattern(); if (!p) return;
    const stepTicks = SEQ().SYNC[p.syncRate] || 6;
    const held = Math.max(1, st.seqRt.tick - ref.startTick);
    ref.n.gate = Math.max(1, Math.round((held / stepTicks) * 6)); // gate in sixths of a step
    notify();
  }
  function toggleRecord() { st.recording = !st.recording; notify(); }

  function onMsg(bytes) {
    const ev = incontrol.resolve(bytes);
    if (!ev) return;
    // Transport controls the sequencer
    if (ev.value > 0 && (ev.control === 'Play' || ev.control === 'Stop' || ev.control === 'Record')) {
      if (ev.control === 'Play') seqPlay();
      else if (ev.control === 'Stop') seqStop();
      else if (ev.control === 'Record') { st.recording = !st.recording; notify(); }
      log('⏵ ' + ev.control); return;
    }
    // Shift modifier
    if (ev.control === 'Shift') { st.shift = ev.value > 0; return; }
    // Grid toggles pad function between playable pads and the step grid
    if (ev.control === 'Grid') { if (ev.value > 0) { engine.nav(st.rt, 'grid'); if (st.rt.padMode === 'sequencer') refreshGrid(); else refreshLeds(); log('grid: ' + st.rt.padMode); } return; }
    // Pads Up/Down: scroll patterns, or (with Shift) transpose the pattern an octave
    if (ev.control === 'Pads Up' || ev.control === 'Pads Down') { if (ev.value > 0) { if (st.shift) transposeCurrent(ev.control === 'Pads Up' ? 12 : -12); else pagePattern(ev.control === 'Pads Down' ? 1 : -1); } return; }
    // Clear / Duplicate held modifiers (for step editing)
    if (ev.control === 'Clear') { st.mod = ev.value > 0 ? 'clear' : (st.mod === 'clear' ? null : st.mod); return; }
    if (ev.control === 'Duplicate') { st.mod = ev.value > 0 ? 'dup' : (st.mod === 'dup' ? null : st.mod); if (ev.value === 0) st.dupFrom = null; return; }

    const c = mapControl(ev.control);

    // Soft buttons 1-8 select the track while in the step sequencer
    if (c && c.group === 'button' && c.index < 8 && st.rt && st.rt.padMode === 'sequencer') {
      if (ev.value > 0) { st.gridTrack = c.index; refreshGrid(); notify(); log('track ' + (c.index + 1)); }
      return;
    }

    const navAction = engine.NAV_MAP[ev.control];
    if (navAction) { if (ev.value > 0) { engine.nav(st.rt, navAction); refreshLeds(); if (/knobBank/.test(navAction)) refreshKnobScreens(); log('⇄ ' + ev.control); } return; }
    if (!c) return;

    // Pad in the step sequencer: hold-pad + keys note entry, clear/duplicate, audition
    if (c.group === 'pad' && st.rt.padMode === 'sequencer') {
      const p = gridPattern(); if (!p) return;
      if (ev.value > 0) { // press
        if (st.mod === 'clear') { SEQ().clearStep(p, c.index); refreshGrid(); notify(); return; }
        if (st.mod === 'dup') { if (st.dupFrom == null) st.dupFrom = c.index; else SEQ().copyStep(p, st.dupFrom, c.index); refreshGrid(); notify(); return; }
        st.heldPads.add(c.index);
        if (st.heldKeys.size) st.heldKeys.forEach((vel, note) => SEQ().toggleStepNote(p, c.index, note, vel, 6)); // reverse order: keys already held
        else if (!seqIsPlaying()) auditionStep(p, c.index, true); // audition when stopped
        refreshGrid(); notify();
      } else { // release
        st.heldPads.delete(c.index);
        if (!seqIsPlaying()) auditionStep(p, c.index, false);
      }
      return;
    }

    const res = engine.handle(st.rt, { group: c.group, index: c.index, value: ev.value });
    res.out.forEach((mb) => midi.sendToOutput(st.destId, mb));
    if (c.group === 'knob') sendKnobValue(c.index); // show adjustment on the SL screens
    if (res.ledDirty) { const led = engine.ledOne(st.rt, c.group, c.index); if (led) midi.sendToOutput(st.slOutId, led); }
    if (res.out.length) log('▶ ' + ev.control);
  }

  function start() {
    if (st.running) return;
    if (!midi.snapshot().connected) { log('Connect MIDI first (top-right).'); return; }
    if (!st.slInId || !st.destId) { log('Pick SL input and destination.'); return; }
    st.rt = engine.makeRuntime(global.SLMK.studioState.getModel());
    refreshLeds();
    refreshKnobScreens();
    st.unsub = midi.subscribeInput(st.slInId, onMsg);
    if (st.keysInId && st.keysInId !== st.slInId) st.keysUnsub = midi.subscribeInput(st.keysInId, onKeys);
    st.running = true;
    $('#se-start').textContent = 'Stop engine';
    $('#se-start').classList.add('running');
    log('Engine started — SL MkIII must be in InControl mode.');
  }
  function stop() {
    if (st.unsub) { st.unsub(); st.unsub = null; }
    if (st.keysUnsub) { st.keysUnsub(); st.keysUnsub = null; }
    st.running = false;
    $('#se-start').textContent = 'Start engine';
    $('#se-start').classList.remove('running');
    log('Engine stopped.');
  }

  function init() {
    if (!$('#view-studio') || !$('#se-start')) return;
    refreshPorts();
    midi.onChange(() => { if (!st.running) refreshPorts(); });
    $('#se-in').addEventListener('change', (e) => (st.slInId = e.target.value));
    $('#se-out').addEventListener('change', (e) => (st.slOutId = e.target.value));
    $('#se-dest').addEventListener('change', (e) => (st.destId = e.target.value));
    if ($('#se-keys')) $('#se-keys').addEventListener('change', (e) => (st.keysInId = e.target.value));
    $('#se-start').addEventListener('click', () => (st.running ? stop() : start()));
    $('#se-refresh').addEventListener('click', () => { if (st.running) refreshLeds(); });
  }

  // Public API for the Sequencer UI tab.
  global.SLMK.studioRuntime = {
    seqPlay, seqStop, seqIsPlaying, recording: () => st.recording, toggleRecord,
    onStep: (cb) => st.stepCbs.push(cb),
    playhead: () => (st.seqRt ? st.seqRt.pos[st.gridTrack].pad : -1),
    setGridTrack: (i) => { st.gridTrack = i; if (st.rt && st.rt.padMode === 'sequencer') refreshGrid(); notify(); },
    gridTrack: () => st.gridTrack,
    restartClock: () => { if (st.clock) { clearInterval(st.clock); st.clock = setInterval(clockTick, tickInterval()); } },
  };

  document.addEventListener('DOMContentLoaded', init);
})(window);
