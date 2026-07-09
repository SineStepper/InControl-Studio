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
    heldPads: new Set(), heldKeys: new Map(), shift: false, audition: new Map(), recRef: new Map(),
    optionsMode: false, optionsMenu: 'velocity', stepPage: 0, padView: 'steps', microstep: 0,
    mute: new Set(), solo: new Set(), activeChannel: 1, litKeys: new Set(), baseRt: null, channelRt: {} };
  const opts = () => global.SLMK.studioOptions;
  const $ = (s) => document.querySelector(s);
  const el = (t, p = {}, c = []) => { const n = document.createElement(t); Object.assign(n, p); (Array.isArray(c) ? c : [c]).forEach((x) => n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x)); return n; };

  function mapControl(name) {
    let m;
    if ((m = /^Pad (\d+)$/.exec(name))) return { group: 'pad', index: +m[1] - 1 };
    if ((m = /^Knob (\d+)$/.exec(name))) return { group: 'knob', index: +m[1] - 1 };
    if ((m = /^Fader (\d+)$/.exec(name))) return { group: 'fader', index: +m[1] - 1 };
    if ((m = /^Soft (\d+)$/.exec(name))) { const i = +m[1] - 1; return i < 24 ? { group: 'button', index: i } : null; }
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
    midi.sendToOutput(st.slOutId, sysex.screenLayout(1)); // Knob Layout: a graphic knob + value per column
    const bank = st.rt.model.knobBanks[st.rt.knobBank] || [];
    for (let i = 0; i < 8; i++) {
      const a = bank[i];
      midi.sendToOutput(st.slOutId, sysex.screenText(i, 0, a ? (a.name || 'Knob ' + (i + 1)) : ''));
      const hex = (a && a.led && a.led.idle && a.led.idle !== '#000000') ? a.led.idle : '#20c0ff';
      const { r, g, b } = sysex.hexTo7bit(hex);
      midi.sendToOutput(st.slOutId, sysex.screenRgb(i, 0, r, g, b)); // colour the graphic knob
      const v = engine.knobDisplay(st.rt, i);
      if (v != null) midi.sendToOutput(st.slOutId, sysex.screenValue(i, 0, v)); // drives the knob arc + value number
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
    events.forEach((e) => {
      const msg = e.type === 'on' ? [0x90 | e.channel, e.note & 0x7f, e.velocity & 0x7f] : [0x80 | e.channel, e.note & 0x7f, 0];
      sendMusic(st.destId, msg);
      if (channelAudible(e.channel + 1)) keyLed(e.note, e.type === 'on' ? KEY_PLAY : '#000000'); // light guide follows playback (#10)
    });
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
    const next = t.activePattern + dir;
    if (next < 0 || next >= SEQ().PATTERNS) return; // clamp at the ends (no wrap, #6)
    t.activePattern = next;
    if (st.rt && st.rt.padMode === 'sequencer') refreshGrid();
    refreshArrowLeds();
    if (st.optionsMode) refreshOptionScreens();
    notify(); log('pattern ' + (t.activePattern + 1));
  }
  function curTrack() { const m = model(); return m && m.sequencer ? m.sequencer.tracks[st.gridTrack] : null; }
  function ledHex(id, hex, beh) { if (!st.slOutId || !sysex) return; const { r, g, b } = sysex.hexTo7bit(hex); midi.sendToOutput(st.slOutId, sysex.ledRgb(id, r, g, b, beh || 'solid')); }

  // ---- Mute / Solo output gating (fixed bank, buttonBanks[0]) ----
  function msBank() { const m = model(); return (m && m.buttonBanks && m.buttonBanks[0]) || []; }
  function channelAudible(ch) { // ch is 1-16
    if (st.mute.has(ch)) return false;
    if (st.solo.size && !st.solo.has(ch)) return false;
    return true;
  }
  // Send a channel-voice message only if its channel isn't muted/soloed out.
  function sendMusic(id, msg) {
    if (!id) return;
    const s = msg[0] & 0xf0;
    if (s >= 0x80 && s <= 0xef && !channelAudible((msg[0] & 0x0f) + 1)) return;
    midi.sendToOutput(id, msg);
  }
  function refreshMuteSolo() {
    const bank = msBank();
    for (let i = 0; i < 8; i++) { const a = bank[i]; if (a) ledHex(12 + i, st.mute.has(a.channel) ? a.led.pressed : a.led.idle); }      // Soft 9-16
    for (let i = 0; i < 8; i++) { const a = bank[8 + i]; if (a) ledHex(20 + i, st.solo.has(a.channel) ? a.led.pressed : a.led.idle); }  // Soft 17-24
  }
  function toggleMute(ch) { if (st.mute.has(ch)) st.mute.delete(ch); else st.mute.add(ch); refreshMuteSolo(); notify(); log((st.mute.has(ch) ? 'mute ' : 'unmute ') + ch); }
  function toggleSolo(ch) { if (st.solo.has(ch)) st.solo.delete(ch); else st.solo.add(ch); refreshMuteSolo(); notify(); log((st.solo.has(ch) ? 'solo ' : 'unsolo ') + ch); }

  // ---- Channel / instrument select (Soft 1-8 below the screens) ----
  function refreshChannelLeds() {
    for (let i = 0; i < 8; i++) ledHex(4 + i, (i + 1) === st.activeChannel ? '#ffffff' : '#0b1730'); // Soft 1-8 = LED 4-11
  }
  function selectChannel(ch) {
    const padMode = st.rt ? st.rt.padMode : 'sequencer';
    st.activeChannel = ch;
    st.gridTrack = ch - 1;                 // the sequencer track follows the channel
    st.rt = runtimeForChannel(ch);         // swap in this channel's control mapping (own template if assigned)
    st.rt.padMode = padMode;
    st.rt.channel = ch;                    // 'default'-channel controls now emit on this channel
    refreshLeds();
    refreshChannelLeds();
    if (st.rt.padMode === 'sequencer') refreshGrid();
    refreshArrowLeds(); refreshKnobScreens();
    if (st.optionsMode) refreshOptionScreens();
    notify(); log('channel ' + ch);
  }
  // Return (and cache) the engine runtime for a channel. Channels with an
  // assigned template get their own runtime built from it; otherwise the base
  // runtime is reused. Never mutates the shared model (#7).
  function runtimeForChannel(ch) {
    const m = model();
    const t = m && m.channelTemplates && m.channelTemplates[ch - 1];
    if (!t) return st.baseRt;
    if (!st.channelRt[ch]) st.channelRt[ch] = engine.makeRuntime(t);
    return st.channelRt[ch];
  }

  // ---- Transport default colours ----
  const TRANSPORT_LEDS = { 36: '#00ff00' /*Play*/, 32: '#ff0000' /*Record*/, 35: '#ff0000' /*Stop*/, 37: '#ffff00' /*Loop*/, 34: '#ffffff' /*FastFwd*/, 33: '#ffffff' /*Rewind*/ };
  function refreshTransport() { Object.keys(TRANSPORT_LEDS).forEach((id) => ledHex(+id, TRANSPORT_LEDS[id])); }

  // ---- Fader LED brightness tracks value (#2) ----
  function refreshFaderLed(index, value) {
    const m = model(); const a = m && m.faders && m.faders[index]; if (!a) return;
    ledHex(54 + index, opts().valueColor((a.led && a.led.idle) || '#20c0ff', value, 127));
  }

  // ---- Keybed light guide (SysEx ids 54-114; key index 0 = note LOW_NOTE) ----
  const LOW_NOTE = 36; // configurable base note for the 61-key light guide
  function keyLed(note, hex) {
    const idx = note - LOW_NOTE;
    if (idx < 0 || idx > 60) return; // outside the light guide range
    ledHex(54 + idx, hex);
    if (hex === '#000000') st.litKeys.delete(note); else st.litKeys.add(note);
  }
  const KEY_PLAY = '#3bd0ff', KEY_AUDITION = '#ff0000';

  // ---- Press-to-lighten feedback (#5): white on press, resting colour on release ----
  function pressFlash(group, index, pressed) {
    if (pressed) { const id = ledIdFor(group, index); if (id != null) ledHex(id, '#f0f0f0'); }
    else restoreLed(group, index);
  }
  function ledIdFor(group, index) {
    if (group === 'pad') return 38 + index;
    if (group === 'button') return 4 + index;
    return null;
  }
  function restoreLed(group, index) {
    if (group === 'pad') { if (st.rt && st.rt.padMode === 'sequencer') refreshGrid(); else { const l = engine.ledOne(st.rt, 'pad', index); if (l) midi.sendToOutput(st.slOutId, l); } return; }
    if (group === 'button') {
      if (index < 8) refreshChannelLeds();
      else if (index < 24) refreshMuteSolo();
      else { const l = engine.ledOne(st.rt, 'button', index); if (l) midi.sendToOutput(st.slOutId, l); }
    }
  }

  function refreshGrid() {
    if (!st.slOutId || !global.SLMK.sysex) return;
    if (st.padView === 'patterns') return refreshPatternPads();
    const p = gridPattern(); if (!p) return;
    const head = st.seqRt ? st.seqRt.pos[st.gridTrack].pad : -1;
    for (let i = 0; i < 16; i++) {
      let hex = '#0a0a0a';
      if (SEQ().stepHasNotes(p, i)) hex = '#3bd0ff';
      if (seqIsPlaying() && i === head) hex = '#ffffff';
      ledHex(38 + i, hex);
    }
  }
  // Patterns view (#4/#7): the 16 pads show/select the 8 patterns.
  function refreshPatternPads() {
    const t = curTrack(); if (!t) return;
    opts().patternPadLeds(t.activePattern, SEQ().PATTERNS).forEach((hex, i) => ledHex(38 + i, hex));
  }
  // Pads Up/Down arrow LEDs reflect the position in the pattern list (#7).
  function refreshArrowLeds() {
    const t = curTrack(); if (!t) return;
    const a = opts().arrowLeds(t.activePattern, SEQ().PATTERNS);
    ledHex(0, a.up ? '#00aaff' : '#000000');
    ledHex(1, a.down ? '#00aaff' : '#000000');
  }
  // Scene 1 (Top) = Patterns view, Scene 2 (Bottom) = Steps view (#4).
  function refreshSceneLeds() {
    ledHex(2, st.padView === 'patterns' ? '#ffae00' : '#160f00');
    ledHex(3, st.padView === 'steps' ? '#3bd0ff' : '#001016');
  }
  // Options-mode soft-button LEDs + the Options button itself (#6).
  function refreshOptionLeds() {
    ledHex(65, st.optionsMode ? '#ffffff' : '#101010'); // Options button
    if (!st.optionsMode) return;
    const leds = opts().softLeds(st.optionsMenu);
    Object.keys(leds).forEach((k) => ledHex(4 + Number(k), leds[k]));
  }
  // Per-knob screen readout for the active options menu/page (#6).
  function refreshOptionScreens() {
    if (!st.slOutId || !sysex) return;
    const t = curTrack(); if (!t) return;
    const p = t.patterns[t.activePattern];
    const seq = model().sequencer;
    midi.sendToOutput(st.slOutId, sysex.screenLayout(1));
    const cols = opts().columns(seq, p, st.optionsMenu, st.stepPage);
    const menu = opts().MENUS[st.optionsMenu];
    for (let i = 0; i < 8; i++) {
      const c = cols[i];
      midi.sendToOutput(st.slOutId, sysex.screenText(i, 0, c ? (menu.perStep ? c.text : c.label + ' ' + c.text) : ''));
      if (c) midi.sendToOutput(st.slOutId, sysex.screenValue(i, 0, c.value));
    }
  }
  function restartClockIfRunning() { if (st.clock) { clearInterval(st.clock); st.clock = setInterval(clockTick, tickInterval()); } }
  function toggleOptions() {
    st.optionsMode = !st.optionsMode;
    if (st.optionsMode) { st.stepPage = 0; refreshOptionLeds(); refreshOptionScreens(); log('options on'); }
    else { refreshOptionLeds(); refreshLeds(); refreshKnobScreens(); log('options off'); }
  }
  function setPadView(view) {
    st.padView = view;
    refreshSceneLeds();
    if (st.rt && st.rt.padMode === 'sequencer') refreshGrid();
    refreshArrowLeds();
    notify(); log('view: ' + view);
  }

  const trackChan = () => { const m = model(); return m && m.sequencer ? (m.sequencer.tracks[st.gridTrack].channel - 1) & 0x0f : 0; };
  function auditionStep(p, step, on) {
    if (!st.destId) return;
    const ch = trackChan();
    p.steps[step].notes.forEach((n) => {
      sendMusic(st.destId, on ? [0x90 | ch, n.note & 0x7f, n.velocity & 0x7f] : [0x80 | ch, n.note & 0x7f, 0]);
      keyLed(n.note, on ? KEY_AUDITION : '#000000'); // red while auditioning/holding a step (#10)
    });
  }
  function transposeCurrent(semi) { const p = gridPattern(); if (p && SEQ().transposePattern(p, semi)) { refreshGrid(); notify(); log('transpose ' + (semi > 0 ? '+' : '') + semi); } }

  // Keyboard input (SL regular port). Three roles, exactly like the built-in
  // sequencer: assign notes to held steps, live-record, and monitor to output.
  function onKeys(bytes) {
    const status = bytes[0] & 0xf0;
    const note = bytes[1], vel = bytes[2];
    const isOn = status === 0x90 && vel > 0;
    const isOff = status === 0x80 || (status === 0x90 && vel === 0);
    sendMusic(st.destId, bytes); // monitor through (respecting mute/solo)
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
    // Options button: toggle the options-editing surface (#6)
    if (ev.control === 'Options') { if (ev.value > 0) toggleOptions(); return; }
    // Scene 1 (Top) -> Patterns view, Scene 2 (Bottom) -> Steps view (#4)
    if (ev.control === 'Scene Top' || ev.control === 'Scene Bottom') { if (ev.value > 0) setPadView(ev.control === 'Scene Top' ? 'patterns' : 'steps'); return; }
    // Grid toggles pad function between playable pads and the step grid
    if (ev.control === 'Grid') { if (ev.value > 0) { engine.nav(st.rt, 'grid'); if (st.rt.padMode === 'sequencer') refreshGrid(); else refreshLeds(); log('grid: ' + st.rt.padMode); } return; }
    // In options mode the screen arrows page between steps 1-8 and 9-16 (#6)
    if (st.optionsMode && (ev.control === 'Screen Up' || ev.control === 'Screen Down')) {
      if (ev.value > 0) { st.stepPage = ev.control === 'Screen Down' ? 1 : 0; refreshOptionScreens(); log('steps ' + (st.stepPage ? '9-16' : '1-8')); }
      return;
    }
    // Pads Up/Down: scroll patterns, or (with Shift) transpose the pattern an octave
    if (ev.control === 'Pads Up' || ev.control === 'Pads Down') { if (ev.value > 0) { if (st.shift) transposeCurrent(ev.control === 'Pads Up' ? 12 : -12); else pagePattern(ev.control === 'Pads Down' ? 1 : -1); } return; }
    // Clear / Duplicate held modifiers (for step editing)
    if (ev.control === 'Clear') { st.mod = ev.value > 0 ? 'clear' : (st.mod === 'clear' ? null : st.mod); return; }
    if (ev.control === 'Duplicate') { st.mod = ev.value > 0 ? 'dup' : (st.mod === 'dup' ? null : st.mod); if (ev.value === 0) st.dupFrom = null; return; }

    const c = mapControl(ev.control);

    // ---- Options mode intercepts knobs + soft buttons (#6) ----
    if (st.optionsMode && c) {
      if (c.group === 'button') {
        if (ev.value > 0) {
          const menu = opts().menuForButton(c.index);
          if (menu) { st.optionsMenu = menu; refreshOptionLeds(); refreshOptionScreens(); log('menu: ' + menu); }
          else if (opts().MICROSTEP_BUTTONS.indexOf(c.index) >= 0) { st.microstep = c.index; log('microstep ' + (c.index + 1)); }
        }
        return;
      }
      if (c.group === 'knob') {
        const t = curTrack(); if (t) {
          const seq = model().sequencer;
          const delta = engine.knobDelta(ev.value);
          const desc = opts().applyKnob(seq, t.patterns[t.activePattern], st.optionsMenu, c.index, delta, st.stepPage, st.shift);
          if (desc) { refreshOptionScreens(); if (st.rt.padMode === 'sequencer') refreshGrid(); notify(); if (/tempo/.test(desc)) restartClockIfRunning(); log(desc); }
        }
        return;
      }
    }

    // Patterns view: a pad selects that pattern (#4/#7)
    if (c && c.group === 'pad' && st.padView === 'patterns' && st.rt && st.rt.padMode === 'sequencer') {
      if (ev.value > 0 && c.index < SEQ().PATTERNS) { curTrack().activePattern = c.index; refreshPatternPads(); refreshArrowLeds(); if (st.optionsMode) refreshOptionScreens(); notify(); log('pattern ' + (c.index + 1)); }
      return;
    }

    // Soft buttons: 1-8 (below the screens) select the channel/instrument;
    // 9-24 (above the faders) are the fixed Mute/Solo bank. Press-to-lighten (#5).
    if (c && c.group === 'button') {
      pressFlash('button', c.index, ev.value > 0);
      if (ev.value > 0) {
        if (c.index < 8) selectChannel(c.index + 1);              // Soft 1-8 -> channel 1-8 (#7)
        else if (c.index < 24) { const a = msBank()[c.index - 8]; if (a) (c.index < 16 ? toggleMute : toggleSolo)(a.channel); } // Soft 9-16 Mute, 17-24 Solo (#1)
      }
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
        refreshGrid(); ledHex(38 + c.index, '#f0f0f0'); notify(); // press-to-lighten over the grid (#5)
      } else { // release
        st.heldPads.delete(c.index);
        if (!seqIsPlaying()) auditionStep(p, c.index, false);
        refreshGrid();
      }
      return;
    }

    const res = engine.handle(st.rt, { group: c.group, index: c.index, value: ev.value });
    res.out.forEach((mb) => sendMusic(st.destId, mb));
    if (c.group === 'knob') sendKnobValue(c.index); // show adjustment on the SL screens
    if (c.group === 'fader') refreshFaderLed(c.index, ev.value); // LED brightness tracks value (#2)
    if (c.group === 'pad') pressFlash('pad', c.index, ev.value > 0); // press-to-lighten in instrument mode (#5)
    else if (res.ledDirty) { const led = engine.ledOne(st.rt, c.group, c.index); if (led) midi.sendToOutput(st.slOutId, led); }
    if (res.out.length) log('▶ ' + ev.control);
  }

  function start() {
    if (st.running) return;
    if (!midi.snapshot().connected) { log('Connect MIDI first (top-right).'); return; }
    if (!st.slInId || !st.destId) { log('Pick SL input and destination.'); return; }
    st.baseRt = engine.makeRuntime(global.SLMK.studioState.getModel());
    st.channelRt = {};
    st.rt = runtimeForChannel(st.activeChannel);
    refreshLeds();
    refreshKnobScreens();
    if (st.rt.padMode === 'sequencer') refreshGrid(); // pads show the step/pattern grid by default (#7)
    refreshSceneLeds();
    refreshArrowLeds();
    refreshOptionLeds();
    refreshTransport();
    refreshMuteSolo();
    refreshChannelLeds();
    st.rt.channel = st.activeChannel;
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
    // Inject a resolved-control MIDI message (used by tests and future on-screen control).
    handleControl: (bytes) => onMsg(bytes),
    state: () => st,
  };

  document.addEventListener('DOMContentLoaded', init);
})(window);
