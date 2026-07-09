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
    seqRt: null, clock: null, recording: false, gridTrack: 0, mod: null, stepCbs: [] };
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

  // Keyboard input (SL regular port): monitor to the destination, and record
  // into the sequencer while Record + Play are active.
  function onKeys(bytes) {
    const status = bytes[0] & 0xf0;
    // forward everything to the destination so you hear the keys through the rig
    if (st.destId) midi.sendToOutput(st.destId, bytes);
    if (!st.recording || !seqIsPlaying()) return;
    if (status === 0x90 && bytes[2] > 0) recordNote(bytes[1], bytes[2]);
  }
  function recordNote(note, velocity) {
    const p = gridPattern(); if (!p) return;
    const step = st.seqRt ? st.seqRt.pos[st.gridTrack].pad : 0; // quantise to the current step
    const s = p.steps[step];
    if (!s.notes.some((n) => n.note === note)) s.notes.push({ note, velocity, gate: 6 });
    if (st.rt && st.rt.padMode === 'sequencer') refreshGrid();
    notify(); log('● rec ' + note + ' @step ' + (step + 1));
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
    // Grid toggles pad function between playable pads and the step grid
    if (ev.control === 'Grid') { if (ev.value > 0) { engine.nav(st.rt, 'grid'); if (st.rt.padMode === 'sequencer') refreshGrid(); else refreshLeds(); log('grid: ' + st.rt.padMode); } return; }
    // Pads Up/Down page the sequencer patterns for the current track
    if (ev.control === 'Pads Up' || ev.control === 'Pads Down') { if (ev.value > 0) pagePattern(ev.control === 'Pads Down' ? 1 : -1); return; }
    // Clear / Duplicate held modifiers (for step editing)
    if (ev.control === 'Clear') { st.mod = ev.value > 0 ? 'clear' : null; return; }
    if (ev.control === 'Duplicate') { st.mod = ev.value > 0 ? 'dup' : null; return; }

    const navAction = engine.NAV_MAP[ev.control];
    if (navAction) { if (ev.value > 0) { engine.nav(st.rt, navAction); refreshLeds(); log('⇄ ' + ev.control); } return; }

    const c = mapControl(ev.control);
    if (!c) return;

    // Pad in sequencer mode edits the step grid instead of playing
    if (c.group === 'pad' && st.rt.padMode === 'sequencer') {
      if (ev.value === 0) return; // act on press only
      const p = gridPattern(); if (!p) return;
      if (st.mod === 'clear') SEQ().clearStep(p, c.index);
      else if (st.mod === 'dup' && st.dupFrom != null) SEQ().copyStep(p, st.dupFrom, c.index);
      else if (st.mod === 'dup') st.dupFrom = c.index;
      else SEQ().toggleStepNote(p, c.index, SEQ().DEFAULT_NOTE, 100, 6);
      refreshGrid(); notify(); return;
    }

    const res = engine.handle(st.rt, { group: c.group, index: c.index, value: ev.value });
    res.out.forEach((mb) => midi.sendToOutput(st.destId, mb));
    if (res.ledDirty) { const led = engine.ledOne(st.rt, c.group, c.index); if (led) midi.sendToOutput(st.slOutId, led); }
    if (res.out.length) log('▶ ' + ev.control);
  }

  function start() {
    if (st.running) return;
    if (!midi.snapshot().connected) { log('Connect MIDI first (top-right).'); return; }
    if (!st.slInId || !st.destId) { log('Pick SL input and destination.'); return; }
    st.rt = engine.makeRuntime(global.SLMK.studioState.getModel());
    refreshLeds();
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
