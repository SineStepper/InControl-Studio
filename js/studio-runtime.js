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

  const st = { running: false, rt: null, unsub: null, keysUnsub: null, slInId: null, slOutId: null, destId: null, keysInId: null, keysOutId: null, log: [],
    seqRt: null, clock: null, recording: false, gridTrack: 0, mod: null, dupFrom: null, stepCbs: [],
    heldPads: new Set(), heldKeys: new Map(), shift: false, audition: new Map(), recRef: new Map(), recEcho: new Map(),
    optionsMode: false, optionsMenu: 'velocity', stepPage: 0, padView: 'steps', microstep: 0,
    mute: new Set(), solo: new Set(), activeChannel: 1, litKeys: new Set(), baseRt: null, channelRt: {}, keyGuide: true,
    heldPatterns: new Set(), selStep: null, heldMicros: new Set(), changeCbs: [], audioCtx: null, gridFlashTimer: null, partTop: 0,
    audioLatencyMs: 0, metroSyncMs: null, metro: null, audioLatencyHint: 'interactive', audioSinkId: null };
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
  // Knob Layout object indices (Programmer's Guide "Knob Layout"):
  //   text:  0 = row above icon, 2 = row below icon
  //   value: 0 = the knob value shown on the icon (0-127)
  //   rgb:   1 = knob icon line colour
  const send = (msg) => midi.sendToOutput(st.slOutId, msg);
  // Put the SL screens into knob layout and show the current bank's names, graphic
  // knobs (value arc), value numbers and per-knob colours.
  function refreshKnobScreens() {
    if (!st.slOutId || !sysex || !st.rt) return;
    send(sysex.screenLayout(1)); // Knob Layout
    const bank = st.rt.model.knobBanks[st.rt.knobBank] || [];
    for (let i = 0; i < 8; i++) {
      const a = bank[i];
      send(sysex.screenText(i, 0, a ? (a.name || 'Knob ' + (i + 1)) : '')); // knob name at the top
      const hex = (a && a.led && a.led.idle && a.led.idle !== '#000000') ? a.led.idle : '#20c0ff';
      const { r, g, b } = sysex.hexTo7bit(hex);
      send(sysex.screenRgb(i, 1, r, g, b)); // knob icon (glyph) colour — customisable per knob (#12)
      sendKnobValue(i);
    }
    refreshCentreScreen();
  }
  // Update one knob column: the graphic knob (glyph) + its value shown above it.
  function sendKnobValue(index) {
    if (!st.slOutId || !sysex || index >= 8) return;
    const v = engine.knobDisplay(st.rt, index);
    if (v == null) return;
    send(sysex.screenValue(index, 0, v));          // graphic-knob glyph value
    send(sysex.screenText(index, 1, String(v)));   // value shown above the glyph, below the name (#12)
  }
  // Far-right screen: Part name + selected knob bank (left), selected button bank (right) (#12).
  function refreshCentreScreen() {
    if (!st.slOutId || !sysex || !st.rt) return;
    const t = curTrack();
    const name = (t && (t.name || 'Part ' + st.activeChannel)) || 'Part ' + st.activeChannel;
    send(sysex.screenText(8, 0, name));                                   // left row 1: part name
    send(sysex.screenText(8, 1, 'Knobs ' + ((st.rt.knobBank || 0) + 1))); // left row 2: knob bank
    send(sysex.screenText(8, 2, (st.rt.buttonBank || 0) === 0 ? 'MuteSolo' : 'Btns ' + ((st.rt.buttonBank || 0) + 1))); // right row 1: button bank
  }

  // ---- sequencer clock / transport ----
  function model() { return global.SLMK.studioState ? global.SLMK.studioState.getModel() : null; }
  function ensureSeqRt() {
    const m = model(); if (!m) return null;
    studio().ensureSequencer(m);
    if (!st.seqRt || st.seqRt.seq !== m.sequencer) st.seqRt = SEQ().makeSeqRuntime(m.sequencer);
    return st.seqRt;
  }
  function tickInterval() { const t = (st.seqRt && st.seqRt.seq.tempo) || 120; return Math.max(4, 60000 / t / SEQ().PPQN); }
  // Clock config sent to the worker: base ms/tick + swing so the timer can vary
  // each tick's interval (swings the whole timeline, incl. the outgoing MIDI clock
  // so the SL's arp swings too — #39). swing 50 = straight.
  function clockConfig() {
    const seq = st.seqRt && st.seqRt.seq;
    const swing = (seq && seq.swing != null) ? seq.swing : 50;
    const syncTicks = (SEQ().SYNC[(seq && seq.swingSync)] || 6);
    return { base: tickInterval(), swing, syncTicks };
  }

  // Clock timer. A Web Worker keeps ticking when the window is unfocused (#18) and
  // off the main thread (#22). It SELF-SCHEDULES with a per-tick interval so tempo
  // changes retune smoothly (no stop/start starve — #36/#38) and swing bends the
  // intervals (#39). Falls back to a fixed setInterval where Worker is absent
  // (Node tests) — swing there stays in the sequencer's own swingDelay.
  let workerTimer = null, workerTried = false;
  function makeWorkerTimer() {
    if (workerTried) return workerTimer; workerTried = true;
    try {
      const src = [
        'var id=null,tick=0,cfg={base:20,swing:50,syncTicks:6};',
        'function next(){var b=cfg.base,d=b;',
        ' if(cfg.swing!==50&&cfg.syncTicks){var f=Math.max(0,Math.min(0.5,Math.abs(cfg.swing-50)/50));',
        '  var firstHalf=Math.floor(tick/cfg.syncTicks)%2===0;var sign=cfg.swing>50?1:-1;',
        '  d=b*(1+sign*(firstHalf?f:-f));}',
        ' id=setTimeout(function(){tick++;postMessage(0);next();},Math.max(2,d));}',
        'onmessage=function(e){var m=e.data;',
        ' if(m.cmd==="start"){cfg=m;if(m.reset){tick=0;}if(id)clearTimeout(id);next();}',
        ' else if(m.cmd==="config"){cfg=m;}',
        ' else{if(id)clearTimeout(id);id=null;}};',
      ].join('');
      workerTimer = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
      workerTimer.onmessage = () => clockTick();
    } catch (e) { workerTimer = null; }
    return workerTimer;
  }
  function startClock() {
    const w = makeWorkerTimer();
    if (w) { w.postMessage(Object.assign({ cmd: 'start', reset: true }, clockConfig())); st.clock = w; if (st.seqRt) st.seqRt.clockSwing = true; }
    else st.clock = setInterval(clockTick, tickInterval());
  }
  // Update tempo/swing WITHOUT restarting the timer (avoids the interval-reset
  // starve that dramatically slowed the sequencer while dragging tempo — #36 —
  // and the clock gap that made the SL lose sync — #38).
  function retuneClock() {
    if (!st.clock) return;
    if (st.clock === workerTimer) workerTimer.postMessage(Object.assign({ cmd: 'config' }, clockConfig()));
    else { clearInterval(st.clock); st.clock = setInterval(clockTick, tickInterval()); }
  }
  function stopClock() {
    if (st.clock && st.clock === workerTimer) workerTimer.postMessage({ cmd: 'stop' });
    else if (st.clock) clearInterval(st.clock);
    if (st.seqRt) st.seqRt.clockSwing = false;
    st.clock = null;
  }
  // MIDI real-time clock to the SL so its arp/tempo features sync (#26): FA start,
  // FC stop, F8 timing clock at 24 PPQN (once per clockTick).
  // Send MIDI real-time clock to every SL port that could be driving a tempo-synced
  // feature: the InControl out AND the SL's main port (whose keyboard arp follows
  // external clock). The SL must have its Clock Source set to receive external clock.
  function sendClock(byte) {
    if (st.slOutId) midi.sendToOutput(st.slOutId, [byte]);
    if (st.keysOutId && st.keysOutId !== st.slOutId) midi.sendToOutput(st.keysOutId, [byte]);
  }
  // ---- Metronome (#14) ----
  // MIDI is NEVER delayed. Instead the click is scheduled EARLY on the Web-Audio
  // clock, using look-ahead, so that after the audio output latency it is *heard*
  // exactly on the beat — coinciding with the realtime MIDI note.
  const metroOn = () => { const m = model(); return !!(m && m.sequencer && m.sequencer.metronome && m.sequencer.metronome.on); };
  // Extra manual lead (ms): positive plays the click even earlier. Blank = 0.
  function extraLeadMs() { return st.metroSyncMs != null ? st.metroSyncMs : 0; }

  // Create (and keep warm) the metronome's AudioContext at the chosen latency
  // hint / output device, and cache its output latency for look-ahead scheduling.
  function ensureAudio() {
    try {
      const AC = global.AudioContext || global.webkitAudioContext; if (!AC) return null;
      if (!st.audioCtx) {
        const hint = st.audioLatencyHint || 'interactive';
        try { st.audioCtx = new AC({ latencyHint: hint }); } catch (e) { st.audioCtx = new AC(); }
        if (st.audioSinkId && st.audioCtx.setSinkId) { try { st.audioCtx.setSinkId(st.audioSinkId); } catch (e) {} }
      }
      const ac = st.audioCtx;
      if (ac.state === 'suspended' && ac.resume) ac.resume();
      st.audioLatencyMs = Math.round(((ac.baseLatency || 0) + (ac.outputLatency || 0)) * 1000);
      return ac;
    } catch (e) { return null; }
  }
  // Rebuild the audio context (after a latency-mode / output-device change).
  function resetAudio() { try { if (st.audioCtx && st.audioCtx.close) st.audioCtx.close(); } catch (e) {} st.audioCtx = null; st.metro = null; if (metroOn()) ensureAudio(); }

  // Look-ahead scheduler: schedule every beat click whose audio time falls inside
  // the look-ahead window, at (predicted beat audio time − audio latency − extra
  // lead) so the sound is *heard* on the beat. Driven off the live (audioNow,
  // currentTick) mapping so it tracks tempo changes automatically.
  function scheduleMetronome(curTick) {
    if (!metroOn() || !st.seqRt) return;
    const ac = ensureAudio(); if (!ac) return;
    const m = model(); const met = m.sequencer.metronome;
    const p = gridPattern(); if (!p) return;
    const tempo = m.sequencer.tempo || 120;
    const secPerTick = 60 / tempo / 24;
    const leadSec = ((st.audioLatencyMs || 0) + extraLeadMs()) / 1000; // how early to fire the oscillator
    const pt = patternTicks(p);                                        // ticks per pattern loop (accent period)
    const audioNow = ac.currentTime;
    if (!st.metro || st.metro.tempo !== tempo) st.metro = { nextBeat: Math.ceil(curTick / 24) * 24, tempo }; // (re)anchor
    const LOOK = Math.max(0.18, leadSec + 2 * secPerTick); // seconds of look-ahead
    // schedule all beats coming due within the window
    while ((st.metro.nextBeat - curTick) * secPerTick <= LOOK) {
      const beat = st.metro.nextBeat;
      const beatAudioTime = audioNow + (beat - curTick) * secPerTick; // when the beat is *heard*-target
      const when = Math.max(audioNow, beatAudioTime - leadSec);       // fire the osc this early
      const accent = pt > 0 ? (((beat % pt) + pt) % pt) === 0 : (beat % 96 === 0);
      playClick(ac, when, accent, met.sound || 'Ping');
      st.metro.nextBeat += 24; // steady quarter-note pulse
    }
  }
  // Grid LED flash on the *actual* beat (realtime), so the visual matches the grid.
  function metronomeFlash(tick) {
    if (!metroOn() || !st.slOutId || tick % 24 !== 0) return;
    ledHex(64, '#00ff00'); clearTimeout(st.gridFlashTimer); st.gridFlashTimer = setTimeout(() => ledHex(64, dim('#ffffff')), 90);
  }
  function playClick(ac, when, accent, sound) {
    try {
      const t = Math.max(ac.currentTime, when), gain = ac.createGain(); gain.connect(ac.destination);
      const osc = ac.createOscillator(); osc.connect(gain);
      if (sound === 'Tick') { osc.type = 'square'; osc.frequency.value = accent ? 2200 : 1600; gain.gain.setValueAtTime(accent ? 0.4 : 0.25, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03); }
      else if (sound === 'Pop') { osc.type = 'sine'; osc.frequency.value = accent ? 520 : 380; gain.gain.setValueAtTime(accent ? 0.6 : 0.4, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.11); }
      else { osc.type = 'sine'; osc.frequency.value = accent ? 1320 : 880; gain.gain.setValueAtTime(accent ? 0.5 : 0.35, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18); } // Ping
      osc.start(t); osc.stop(t + 0.2);
    } catch (e) {}
  }

  function clockTick() {
    sendClock(0xf8); // 24-PPQN timing clock
    const beatTick = st.seqRt.tick;
    // Schedule any upcoming metronome click BEFORE processing notes so the audio
    // gets maximum lead time. MIDI is always sent in realtime (never delayed).
    scheduleMetronome(beatTick);
    const events = SEQ().onTick(st.seqRt);
    events.forEach((e) => {
      // Drop the sequencer's own echo of a note we just recorded + monitored live
      // this cycle, so the fresh note isn't heard twice (bug: double key on record).
      const ek = e.channel + ':' + e.note, until = st.recEcho.get(ek);
      if (until != null) {
        if (st.seqRt.tick < until) return;      // still within the cycle it was recorded in
        st.recEcho.delete(ek);                   // window elapsed — play normally from now on
      }
      const msg = e.type === 'on' ? [0x90 | e.channel, e.note & 0x7f, e.velocity & 0x7f] : [0x80 | e.channel, e.note & 0x7f, 0];
      sendMusic(st.destId, msg); // realtime — MIDI is never delayed
      if (channelAudible(e.channel + 1)) keyPlay(e.note, e.type === 'on'); // playing keys of a part = green (#48)
    });
    playAutomation();
    metronomeFlash(beatTick); // grid LED flash on the actual beat (realtime, visual)
    // Only repaint the pad grid when the play-head STEP actually changes, not every
    // tick — repainting 16 pads 24×/beat floods the SL, lagging the knob screens
    // (#55) and glitching the step LED at high swing (#56).
    if (st.rt && st.rt.padMode === 'sequencer') {
      const head = st.seqRt.pos[st.gridTrack] ? st.seqRt.pos[st.gridTrack].pad : -1;
      if (head !== st.lastGridHead) { st.lastGridHead = head; refreshGrid(); }
    }
    st.stepCbs.forEach((cb) => { try { cb(); } catch (e) {} });
  }

  // ---- Automation (record/replay control moves per pattern, up to 8 lanes) ----
  const autoKey = (group, index) => group + ':' + (group === 'knob' ? st.rt.knobBank : group === 'button' ? st.rt.buttonBank : 0) + ':' + index;
  const patternTicks = (p) => (Math.abs((p.end || 0) - (p.start || 0)) + 1) * (SEQ().SYNC[p.syncRate] || 6);
  function recordAutomation(group, index, bytes) {
    if (!st.recording || !seqIsPlaying() || !bytes || !bytes.length || !st.seqRt) return;
    const t = curTrack(); const p = t && t.patterns[t.activePattern]; if (!p) return;
    p.automation = p.automation || {};
    const key = autoKey(group, index);
    if (!p.automation[key] && Object.keys(p.automation).length >= 8) { log('automation lanes full'); return; }
    (p.automation[key] = p.automation[key] || {})[st.seqRt.tick % patternTicks(p)] = bytes.slice();
  }
  function playAutomation() {
    const m = model(); if (!m || !m.sequencer || !st.seqRt) return;
    m.sequencer.tracks.forEach((t, ti) => {
      const p = t.patterns[t.activePattern]; if (!p || !p.automation) return;
      const at = st.seqRt.tick % patternTicks(p);
      Object.keys(p.automation).forEach((key) => {
        const bytes = p.automation[key][at]; if (!bytes) return;
        sendMusic(st.destId, bytes);
        if (ti === st.gridTrack && !st.optionsMode) animateAutomation(key, bytes); // reflect on the SL (#23)
      });
    });
  }
  // Animate a playing automation lane on the SL: knob glyph value / fader brightness.
  function animateAutomation(key, bytes) {
    const parts = key.split(':'); const group = parts[0], bank = +parts[1], index = +parts[2];
    const val = bytes[bytes.length - 1] & 0x7f;
    if (group === 'knob' && bank === (st.rt.knobBank || 0) && index < 8 && st.slOutId && sysex) {
      send(sysex.screenValue(index, 0, val)); send(sysex.screenText(index, 1, String(val)));
    } else if (group === 'fader' && index < 8) {
      refreshFaderLed(index, val);
    }
  }
  // All-Notes-Off (CC123) to every channel on the destination — flushes anything
  // left hanging. Bypasses the mute gate.
  function panicAllChannels() { if (!st.destId) return; for (let ch = 0; ch < 16; ch++) midi.sendToOutput(st.destId, [0xb0 | ch, 123, 0]); }
  function seqPlay() {
    const rt = ensureSeqRt(); if (!rt) return;
    // Clear any hung notes on all 16 channels BEFORE the clock starts, so this
    // never lands on top of (and cuts off) the sequencer's first note (#29).
    panicAllChannels();
    st.metro = null;              // re-anchor the metronome scheduler to the new start
    if (metroOn()) ensureAudio(); // warm the click's audio + measure latency before step 1
    SEQ().start(rt);
    // NOTE: we deliberately do NOT send MIDI Start (FA) to the SL. FA launches the
    // SL's own internal sequencer, which then plays its loaded session's notes
    // (a phantom C at each pattern start) and lights the keybed (#34). The arp
    // only needs the F8 timing clock (sent every tick) to lock tempo — no transport.
    stopClock();
    startClock();
    if (st.running) { refreshTransport(); if (st.rt.padMode === 'sequencer') refreshGrid(); }
    notify();
  }
  function seqStop() {
    stopClock();
    st.recEcho.clear();
    // No MIDI Stop (FC) to the SL either — see seqPlay (#34).
    if (st.seqRt) SEQ().stop(st.seqRt).forEach((e) => { if (st.destId) midi.sendToOutput(st.destId, [0x80 | e.channel, e.note & 0x7f, 0]); });
    if (st.running) { refreshTransport(); if (st.rt.padMode === 'sequencer') refreshGrid(); }
    notify();
  }
  const seqIsPlaying = () => !!st.clock;
  function notify() { st.stepCbs.forEach((cb) => { try { cb(); } catch (e) {} }); }
  // Fired when the sequence *content* changes (a note added/removed/edited) so the
  // on-screen UI can re-render, not just repaint play-heads (#16).
  function contentChanged() { notify(); st.changeCbs.forEach((cb) => { try { cb(); } catch (e) {} }); }
  // Re-channel a channel-voice message to a given MIDI channel (0-15).
  function rechannel(bytes, ch) { const s = bytes[0] & 0xf0; return (s >= 0x80 && s <= 0xe0) ? [s | (ch & 0x0f)].concat(Array.prototype.slice.call(bytes, 1)) : bytes; }

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
  // Page the two visible Parts in Patterns view without changing the active Part (#17).
  function pagePart(dir) {
    const next = st.partTop + dir;
    if (next < 0 || next > SEQ().TRACKS - 2) return; // clamp so two rows always fit
    st.partTop = next;
    refreshPatternPads(); refreshArrowLeds(); notify(); log('parts ' + (st.partTop + 1) + '-' + (st.partTop + 2));
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
  // `when` (optional) schedules delivery for metronome latency-alignment.
  function sendMusic(id, msg, when) {
    if (!id) return;
    const s = msg[0] & 0xf0;
    if (s >= 0x80 && s <= 0xef) {
      // Always let note-offs through so nothing hangs (#21); gate everything else
      // (note-ons, CC, etc.) on a muted / soloed-out channel.
      const isNoteOff = s === 0x80 || (s === 0x90 && msg[2] === 0);
      if (!isNoteOff && !channelAudible((msg[0] & 0x0f) + 1)) return;
    }
    midi.sendToOutput(id, msg, when);
  }
  // Send All-Notes-Off (CC 123) to a channel — bypasses the mute gate.
  function allNotesOff(ch0) { if (st.destId) midi.sendToOutput(st.destId, [0xb0 | (ch0 & 0x0f), 123, 0]); }
  // Silence any channel that just became inaudible so sustained notes don't hang (#21).
  function silenceInaudible() { for (let ch = 1; ch <= 16; ch++) if (!channelAudible(ch)) allNotesOff(ch - 1); }
  function refreshMuteSolo() {
    const bank = msBank();
    for (let i = 0; i < 8; i++) {
      const a = bank[i]; if (!a) continue; // Soft 9-16 = Mute 1-8
      const muted = st.mute.has(a.channel);
      const silencedBySolo = !muted && st.solo.size && !st.solo.has(a.channel);
      if (silencedBySolo) ledHex(12 + i, a.led.idle, 'pulse'); // pulse when silenced by another solo (manual p.12)
      else ledHex(12 + i, muted ? a.led.pressed : a.led.idle);
    }
    for (let i = 0; i < 8; i++) { const a = bank[8 + i]; if (a) ledHex(20 + i, st.solo.has(a.channel) ? a.led.pressed : a.led.idle); } // Soft 17-24 = Solo
  }
  // Paint the 16 above-fader soft buttons (ids 12-27) for the current button bank:
  // bank 0 is the fixed Mute/Solo bank; banks ≥1 show that bank's own button
  // colours so paging actually changes what's lit (#31).
  function refreshButtonArea() {
    const bank = (st.rt && st.rt.buttonBank) || 0;
    if (bank === 0) return refreshMuteSolo();
    const b = (st.rt && st.rt.model.buttonBanks && st.rt.model.buttonBanks[bank]) || [];
    for (let i = 0; i < 16; i++) {
      const a = b[i];
      ledHex(12 + i, (a && a.enabled && a.led && a.led.idle) ? a.led.idle : '#000000');
    }
  }
  function toggleMute(ch) { if (st.mute.has(ch)) st.mute.delete(ch); else st.mute.add(ch); silenceInaudible(); refreshMuteSolo(); notify(); log((st.mute.has(ch) ? 'mute ' : 'unmute ') + ch); }
  function toggleSolo(ch) { if (st.solo.has(ch)) st.solo.delete(ch); else st.solo.add(ch); silenceInaudible(); refreshMuteSolo(); notify(); log((st.solo.has(ch) ? 'solo ' : 'unsolo ') + ch); }

  // ---- Channel / instrument select (Soft 1-8 below the screens), in Part colours ----
  function refreshChannelLeds() {
    const m = model(); const tracks = (m && m.sequencer && m.sequencer.tracks) || [];
    for (let i = 0; i < 8; i++) {
      const color = (tracks[i] && tracks[i].color) || '#3bd0ff';
      ledHex(4 + i, (i + 1) === st.activeChannel ? '#ffffff' : opts().scaleColor(color, 0.4)); // active white, others dim part colour
    }
  }
  function selectChannel(ch) {
    const padMode = st.rt ? st.rt.padMode : 'sequencer';
    st.activeChannel = ch;
    st.gridTrack = ch - 1;                 // the sequencer track follows the channel
    st.rt = runtimeForChannel(ch);         // swap in this channel's control mapping (own template if assigned)
    st.rt.padMode = padMode;
    st.rt.channel = ch;                    // 'default'-channel controls now emit on this channel
    refreshChannelLeds();
    if (st.rt.padMode === 'sequencer') refreshGrid(); else refreshNotePads();
    refreshArrowLeds(); refreshKnobScreens(); refreshKeyGuide(); // key guide follows the Part colour (#51)
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

  // ---- Colour helpers (issue #12: dim resting, white/bright active) ----
  const dim = (hex) => opts().scaleColor(hex, 0.28);
  function blackout() { for (let id = 0; id <= 67; id++) ledHex(id, '#000000'); } // all LEDs off (#12: nothing lit unless stated)
  const PRESS = '#f0f0f0'; // near-white press feedback
  // Transport: Play/Record/Stop dim when idle, bright when active; Loop/FFW/RWD unlit (#12).
  function refreshTransport() {
    ledHex(36, seqIsPlaying() ? '#00ff00' : dim('#00ff00'));   // Play
    ledHex(32, st.recording ? '#ff0000' : dim('#ff0000'));     // Record
    ledHex(35, seqIsPlaying() ? dim('#ffffff') : '#ffffff');   // Stop (bright when stopped)
    ledHex(37, '#000000');                                     // Loop — unlit/unmapped
    ledHex(34, '#000000');                                     // Fast Forward — unlit
    ledHex(33, '#000000');                                     // Rewind — unlit
  }
  // Function buttons: resting colours per #12 (white on press handled separately).
  const FUNC_REST = { Duplicate: [66, dim('#00ff00')], Clear: [67, dim('#ff0000')], Grid: [64, dim('#ffffff')], 'Track Left': [30, dim('#0000ff')], 'Track Right': [31, dim('#0000ff')] };
  function refreshFunctionLeds() {
    Object.keys(FUNC_REST).forEach((k) => ledHex(FUNC_REST[k][0], FUNC_REST[k][1]));
    ledHex(65, st.optionsMode ? '#ffffff' : dim('#ffffff')); // Options: dim white, bright in options mode
  }

  // ---- Fader LED brightness tracks value (#2) ----
  function refreshFaderLed(index, value) {
    const m = model(); const a = m && m.faders && m.faders[index]; if (!a) return;
    ledHex(54 + index, opts().valueColor((a.led && a.led.idle) || '#20c0ff', value, 127));
  }

  // ---- Keybed light guide (palette-Note method) ----
  // The RGB LED-SysEx ids for keys overlap the fader/function LEDs, so we light
  // keys with the palette Note method instead (Note-On ch16 = Solid; data1 = key
  // note, data2 = palette colour). That addresses keys by note number and doesn't
  // collide with any LED SysEx id. Idle = the current Part's colour (#51); playing
  // = green (#48), auditioned/held = red (#49), pressed = white (#50).
  // Palette indices are best-effort for the SL MkIII colour table (tunable here).
  const KEY_PAL = { off: 0, white: 3, green: 21, red: 5 };
  const PART_PAL = [5, 9, 13, 21, 37, 45, 49, 53]; // per Part index (tunable)
  const KEY_LO = 36, KEY_HI = 96;                   // light-guide note range
  const partPalette = () => PART_PAL[(st.gridTrack || 0) % 8];
  function lightKey(note, palette) {
    if (!st.keyGuide || !st.slOutId || note < KEY_LO || note > KEY_HI) return;
    midi.sendToOutput(st.slOutId, [0x9f, note & 0x7f, palette & 0x7f]); // ch16 Note-On = Solid palette
  }
  // Paint the whole light guide in the current Part's colour (idle state, #51).
  function refreshKeyGuide() { for (let nt = KEY_LO; nt <= KEY_HI; nt++) lightKey(nt, partPalette()); }
  const keyPlay = (note, on) => lightKey(note, on ? KEY_PAL.green : partPalette());     // #48
  const keyAudition = (note, on) => lightKey(note, on ? KEY_PAL.red : partPalette());   // #49
  const keyPressed = (note, on) => lightKey(note, on ? KEY_PAL.white : partPalette());  // #50

  // ---- Press feedback (#5/#12): note pads show part colour (dim/bright), other buttons flash white ----
  function pressFlash(group, index, pressed) {
    if (group === 'pad') { // instrument-mode note pad: dim part idle, bright part pressed (#12)
      ledHex(38 + index, pressed ? opts().lighten(partColor(), 0.3) : dim(partColor()));
      return;
    }
    if (pressed) { const id = ledIdFor(group, index); if (id != null) ledHex(id, PRESS); }
    else restoreLed(group, index);
  }
  // Instrument-mode (Grid) note pads at rest: dim part colour (#12).
  function refreshNotePads() { const c = partColor(); for (let i = 0; i < 16; i++) ledHex(38 + i, dim(c)); }
  function ledIdFor(group, index) {
    if (group === 'pad') return 38 + index;
    if (group === 'button') return 4 + index;
    return null;
  }
  function restoreLed(group, index) {
    if (group === 'pad') { if (st.rt && st.rt.padMode === 'sequencer') refreshGrid(); else { const l = engine.ledOne(st.rt, 'pad', index); if (l) midi.sendToOutput(st.slOutId, l); } return; }
    if (group === 'button') {
      if (index < 8) refreshChannelLeds();
      else if (index < 24) refreshButtonArea();
      else { const l = engine.ledOne(st.rt, 'button', index); if (l) midi.sendToOutput(st.slOutId, l); }
    }
  }

  const partColor = () => { const t = curTrack(); return (t && t.color) || '#3bd0ff'; };
  function refreshGrid() {
    if (!st.slOutId || !global.SLMK.sysex) return;
    if (st.padView === 'patterns') return refreshPatternPads();
    const p = gridPattern(); if (!p) return;
    const head = st.seqRt ? st.seqRt.pos[st.gridTrack].pad : -1;
    const color = partColor();
    const lo = Math.min(p.start, p.end), hi = Math.max(p.start, p.end);
    const playing = seqIsPlaying();
    for (let i = 0; i < 16; i++) {
      const has = SEQ().stepHasNotes(p, i);
      const inRange = i >= lo && i <= hi;
      let hex, beh = 'solid';
      if (has) hex = inRange ? color : '#ff0000';           // used step: bright part colour (red if outside start/end, #14)
      else hex = dim(color);                                 // empty step: dim part colour (#12)
      if (st.optionsMenu === 'pattern' && st.optionsMode && i === p.start) hex = '#ffd000'; // start step yellow (#14)
      if (i === head) { hex = '#ffffff'; if (!playing) beh = 'pulse'; } // current step: white playing, white-pulse stopped (#12)
      ledHex(38 + i, hex, beh);
    }
  }
  // Patterns view (#4/#7): the 16 pads show/select the 8 patterns in the part colour.
  // Part mode (#17): the two pad rows show two Parts' patterns (top = partTop,
  // bottom = partTop+1), each row in its Part colour; up/down pages the Parts.
  function refreshPatternPads() {
    const m = model(); const tracks = m && m.sequencer && m.sequencer.tracks; if (!tracks) return;
    for (let row = 0; row < 2; row++) {
      const t = tracks[st.partTop + row];
      for (let col = 0; col < 8; col++) {
        const pad = row * 8 + col;
        if (!t) { ledHex(38 + pad, '#000000'); continue; }
        const pend = t.pending;
        if (pend && (col === pend.activePattern || (pend.chain && col >= pend.chain.from && col <= pend.chain.to))) { ledHex(38 + pad, '#ffffff', 'pulse'); continue; }
        const color = t.color || '#3bd0ff';
        let hex;
        if (col === t.activePattern) hex = '#ffffff';
        else if (t.chain && col >= t.chain.from && col <= t.chain.to) hex = opts().lighten(color, 0.4);
        else hex = opts().scaleColor(color, 0.35);
        ledHex(38 + pad, hex);
      }
    }
  }
  // Up/down arrow LEDs, all consistent (lit when there's somewhere to go, else off) (#12/#24).
  //   Pads Up/Down (0/1)      -> pattern list position.
  //   Screen Up/Down (62/63)  -> knob-bank position.
  //   Right Soft Up/Down (28/29) -> button-bank position.
  function refreshArrowLeds() {
    const t = curTrack(); if (!t) return;
    const AR = '#00aaff';
    // Pads Up/Down: Part-paging position in Patterns view, else pattern position.
    const a = st.padView === 'patterns'
      ? { up: st.partTop > 0, down: st.partTop < SEQ().TRACKS - 2 }
      : opts().arrowLeds(t.activePattern, SEQ().PATTERNS);
    ledHex(0, a.up ? AR : '#000000');
    ledHex(1, a.down ? AR : '#000000');
    const kbanks = (st.rt && st.rt.model.knobBanks && st.rt.model.knobBanks.length) || 1;
    const kb = (st.rt && st.rt.knobBank) || 0;
    ledHex(62, kb > 0 ? AR : '#000000');            // Screen Up
    ledHex(63, kb < kbanks - 1 ? AR : '#000000');   // Screen Down
    const bbanks = (st.rt && st.rt.model.buttonBanks && st.rt.model.buttonBanks.length) || 1;
    const bb = (st.rt && st.rt.buttonBank) || 0;
    ledHex(28, bb > 0 ? AR : '#000000');            // Right Soft Up
    ledHex(29, bb < bbanks - 1 ? AR : '#000000');   // Right Soft Down
  }
  // Scene 1 (Top) = Patterns view, Scene 2 (Bottom) = Steps view (#4).
  function refreshSceneLeds() {
    ledHex(2, st.padView === 'patterns' ? '#ffae00' : '#160f00');
    ledHex(3, st.padView === 'steps' ? '#3bd0ff' : '#001016');
  }
  // Options-mode soft-button LEDs + the Options button itself (#6).
  // The six micro-step buttons (Soft 9-14) show note presence for the selected
  // step when one is selected (bright = note, dim = empty), else light-orange.
  function refreshOptionLeds() {
    ledHex(65, st.optionsMode ? '#ffffff' : dim('#ffffff')); // Options button dim / bright in options
    if (!st.optionsMode) { refreshChannelLeds(); return; } // restore part-colour buttons when leaving options
    const leds = opts().softLeds(st.optionsMenu);
    Object.keys(leds).forEach((k) => ledHex(4 + Number(k), leds[k]));
    if (st.selStep != null) {
      const t = curTrack(); const p = t && t.patterns[t.activePattern];
      opts().MICROSTEP_BUTTONS.forEach((idx, micro) => {
        const on = p && SEQ().microHasNotes(p, st.selStep, micro);
        ledHex(4 + idx, on ? '#ffffff' : opts().scaleColor(opts().LIGHT_ORANGE, 0.25));
      });
    }
  }
  // Per-knob screen readout for the active options menu/page (#6): label above
  // the icon, the value on the graphic knob, and the reading below it. Assumes
  // the screens are already in knob layout (set on entering options mode) so we
  // don't re-send the layout on every knob turn (which would flicker).
  function refreshOptionScreens() {
    if (!st.slOutId || !sysex) return;
    const t = curTrack(); if (!t) return;
    const p = t.patterns[t.activePattern];
    const seq = model().sequencer;
    const cols = opts().columns(seq, p, st.optionsMenu, st.stepPage);
    // A knob glyph only appears where we actually send a value (type 3). So gate
    // (no value) shows just its text/# boxes with no knob (#37), and empty columns
    // (e.g. Tempo knobs 4-8) show no knob (#tempo-extra-glyphs). We keep the knob
    // layout for text; on a MENU change we re-init the layout (0→1) to wipe any
    // knobs left over from the previous menu.
    if (st.optScreenMenu !== st.optionsMenu) {
      send(sysex.screenLayout(0)); send(sysex.screenLayout(1)); // toggle clears stale widgets
      st.optScreenMenu = st.optionsMenu; st.optScreenLayout = 1;
    } else if (st.optScreenLayout !== 1) { send(sysex.screenLayout(1)); st.optScreenLayout = 1; }
    for (let i = 0; i < 8; i++) {
      const c = cols[i];
      send(sysex.screenText(i, 0, c ? c.top : ''));               // top: "Step N" / parameter name (blank if unused)
      if (c && c.glyph) { send(sysex.screenValue(i, 0, c.glyphValue || 0)); send(sysex.screenRgb(i, 1, 127, 127, 127)); } // white knob ONLY where there's a real value
      send(sysex.screenText(i, 1, c && c.mid != null ? c.mid : '')); // gate: whole number of steps
      send(sysex.screenText(i, 2, c ? (c.bottom || '') : ''));     // reading below: number / % / gate boxes
    }
    // Centre screen: menu name at the BOTTOM ("Velocity", "Gate", …), step page at the top (#6).
    const menu = opts().MENUS[st.optionsMenu];
    send(sysex.screenText(8, 0, menu && menu.perStep ? ('Steps ' + (st.stepPage ? '9-16' : '1-8')) : ''));
    send(sysex.screenText(8, 2, menu ? menu.label : ''));
  }
  // Tempo / swing / sync changed while playing → retune the running clock in place
  // (no stop/start), so it never starves or drops sync (#36/#38).
  function restartClockIfRunning() { retuneClock(); }
  // Coalesce the (heavy) option-screen redraw so spinning a knob doesn't flood the
  // SL with SysEx and bog things down (#22).
  let screenTimer = null;
  function scheduleOptionScreens() {
    if (screenTimer != null) return;
    screenTimer = setTimeout(() => { screenTimer = null; refreshOptionScreens(); }, 16);
  }
  // Coalesce control-surface feedback (fader-LED brightness, knob-glyph values) so
  // moving several faders/knobs at once can't flood the SL with SysEx and starve
  // the clock — only the latest value per control is sent, ~once per frame (#22).
  let surfaceTimer = null;
  const pendingFaderLed = new Map(); // fader index -> latest value
  const pendingKnobVal = new Set();  // knob indices needing a value redraw
  const raf = (cb) => (global.requestAnimationFrame ? global.requestAnimationFrame(cb) : setTimeout(cb, 16));
  function flushSurface() {
    surfaceTimer = null;
    pendingFaderLed.forEach((val, idx) => refreshFaderLed(idx, val)); pendingFaderLed.clear();
    pendingKnobVal.forEach((idx) => sendKnobValue(idx)); pendingKnobVal.clear();
  }
  function scheduleSurface() { if (surfaceTimer == null) surfaceTimer = raf(flushSurface); }
  // Coalesce only where a frame clock exists (browser/Electron); send straight
  // through otherwise (Node tests) so behaviour stays synchronous and testable.
  function queueFaderLed(index, value) { if (!global.requestAnimationFrame) return refreshFaderLed(index, value); pendingFaderLed.set(index, value); scheduleSurface(); }
  function queueKnobValue(index) { if (!global.requestAnimationFrame) return sendKnobValue(index); pendingKnobVal.add(index); scheduleSurface(); }
  // Repaint the whole control surface (used after an on-screen change like a Part colour).
  function refreshSurface() {
    if (!st.running || !st.slOutId) return;
    if (st.rt.padMode === 'sequencer') refreshGrid(); else refreshNotePads();
    refreshChannelLeds(); refreshButtonArea(); refreshTransport(); refreshFunctionLeds(); refreshSceneLeds(); refreshArrowLeds();
    for (let i = 0; i < 8; i++) refreshFaderLed(i, 0);
    if (st.optionsMode) { refreshOptionLeds(); refreshOptionScreens(); } else refreshKnobScreens();
  }
  function toggleOptions() {
    st.optionsMode = !st.optionsMode;
    if (st.optionsMode) { st.stepPage = 0; st.optScreenLayout = null; st.optScreenMenu = null; refreshOptionLeds(); refreshOptionScreens(); log('options on'); }
    else { st.selStep = null; st.heldMicros.clear(); st.optScreenLayout = null; st.optScreenMenu = null; refreshOptionLeds(); refreshSurface(); log('options off'); }
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
      keyAudition(n.note, on); // red while auditioning / holding a step (#49)
    });
  }
  function transposeCurrent(semi) { const p = gridPattern(); if (p && SEQ().transposePattern(p, semi)) { refreshGrid(); contentChanged(); log('transpose ' + (semi > 0 ? '+' : '') + semi); } }

  // Keyboard input (SL regular port). Three roles, exactly like the built-in
  // sequencer: assign notes to held steps, live-record, and monitor to output.
  function onKeys(bytes) {
    const status = bytes[0] & 0xf0;
    const note = bytes[1], vel = bytes[2];
    const isOn = status === 0x90 && vel > 0;
    const isOff = status === 0x80 || (status === 0x90 && vel === 0);
    sendMusic(st.destId, rechannel(bytes, trackChan())); // monitor through on the selected Part's channel (#15)
    if (isOn || isOff) keyPressed(note, isOn); // pressed keys light white, revert to Part colour on release (#50)
    if (isOn) {
      st.heldKeys.set(note, vel);
      // Micro-step entry: in options mode, hold a micro-step button + play keys to
      // toggle that note onto the selected step's micro-step(s) (#12).
      if (st.optionsMode && st.selStep != null && st.heldMicros.size) {
        const t = curTrack(); const p = t && t.patterns[t.activePattern];
        if (p) { st.heldMicros.forEach((micro) => SEQ().toggleMicroNote(p, st.selStep, micro, note, vel, 6)); refreshOptionLeds(); if (st.rt.padMode === 'sequencer') refreshGrid(); contentChanged(); log('micro note ' + note); }
        return;
      }
      // Hold pad(s) + press key -> toggle that note on those steps.
      if (st.heldPads.size && st.rt && st.rt.padMode === 'sequencer') {
        const p = gridPattern(); if (p) { st.heldPads.forEach((step) => SEQ().toggleStepNote(p, step, note, vel, 6)); refreshGrid(); contentChanged(); log('note ' + note + ' -> steps'); }
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
    const pos = st.seqRt ? st.seqRt.pos[st.gridTrack] : { pad: 0, counter: 0 };
    const stepTicks = SEQ().SYNC[p.syncRate] || 6;
    let step = pos.pad; // current play-head step (correct for any direction/length)
    let micro = 0;
    const m = model();
    // st.seqRt.tick points at the *next* tick to be processed; the tick that just
    // sounded — what the player hears as "now" — is one behind it. Quantise against
    // that so a note played on the beat lands on the beat, not a tick late.
    const now = st.seqRt ? Math.max(0, st.seqRt.tick - 1) : 0;
    const sub = ((now % stepTicks) + stepTicks) % stepTicks; // 0..stepTicks-1 into the current step
    const nextStep = () => SEQ().stepIndexFor(pos.counter + 1, p.start, p.end, p.direction, p.shift, Math.random);
    if (m && m.sequencer && m.sequencer.quantizeRecord === false && st.seqRt) {
      // Non-quantised: place the note on the nearest micro-step; rounding past the
      // end of the step advances to micro 0 of the next step (not back to this one).
      const microRaw = Math.round((sub / stepTicks) * 6);
      if (microRaw >= 6) { step = nextStep(); micro = 0; } else micro = microRaw;
    } else if (st.seqRt) {
      // Plain nearest-step quantise: round symmetrically to the closer step
      // boundary — but don't round a note played near the END of the pattern
      // FORWARD across the loop, or it lands on step 1 as a phantom note (#44).
      const hi = Math.max(p.start, p.end == null ? 15 : p.end);
      if (sub * 2 >= stepTicks && pos.pad !== hi) step = nextStep();
    }
    const s = p.steps[step];
    let n = s.notes.find((x) => x.note === note && (x.micro || 0) === micro);
    if (!n) { n = { note, velocity, gate: 6, micro }; s.notes.push(n); }
    st.recRef.set(note, { n, startTick: st.seqRt.tick });
    // We already monitored this key live. Suppress ONLY the immediate re-trigger
    // (within ~1 step) so we don't hear the same hit twice back-to-back; a note
    // recorded onto a step further ahead still plays this cycle when the head
    // reaches it — no waiting a whole loop to hear the edit (#43).
    const t = curTrack(); const ch = t ? (t.channel - 1) & 0x0f : 0;
    st.recEcho.set(ch + ':' + note, st.seqRt.tick + stepTicks);
    if (st.rt && st.rt.padMode === 'sequencer') refreshGrid();
    contentChanged(); log('● rec ' + note + ' @step ' + (step + 1));
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
  function toggleRecord() { st.recording = !st.recording; if (st.running) refreshTransport(); notify(); }

  function onMsg(bytes) {
    const ev = incontrol.resolve(bytes);
    if (!ev) return;
    // Per-pad pressure → pad LED brightness (lighter/darker with pressure, #12),
    // and forward the mapped pad-pressure message if one is assigned.
    if (ev.kind === 'pressure') {
      const cp = mapControl(ev.control);
      if (cp && cp.group === 'pad') {
        if (st.rt && st.rt.padMode !== 'sequencer') ledHex(38 + cp.index, opts().valueColor(partColor(), ev.value, 127));
        const pa = model() && model().pads && model().pads.pressures[cp.index];
        if (pa && pa.enabled && st.destId) {
          const ch = ((pa.channel === 'default' ? (st.rt && st.rt.channel) || 1 : pa.channel) - 1) & 0x0f;
          sendMusic(st.destId, pa.message_type === 'Channel Pressure' ? [0xd0 | ch, ev.value & 0x7f] : [0xa0 | ch, (pa.note || 0) & 0x7f, ev.value & 0x7f]);
        }
      }
      return;
    }
    // Transport controls the sequencer
    if (ev.value > 0 && (ev.control === 'Play' || ev.control === 'Stop' || ev.control === 'Record')) {
      if (ev.control === 'Play') seqPlay();
      else if (ev.control === 'Stop') seqStop();
      else if (ev.control === 'Record') {
        if (st.shift) { // Shift+Record toggles record quantise (non-quantised record)
          const m = model(); if (m && m.sequencer) { m.sequencer.quantizeRecord = m.sequencer.quantizeRecord === false; log('quantise ' + (m.sequencer.quantizeRecord === false ? 'off' : 'on')); }
        } else { st.recording = !st.recording; refreshTransport(); notify(); }
      }
      log('⏵ ' + ev.control); return;
    }
    // Shift modifier
    if (ev.control === 'Shift') { st.shift = ev.value > 0; return; }
    // Options button: toggle the options-editing surface (#6)
    if (ev.control === 'Options') { if (ev.value > 0) toggleOptions(); return; }
    // Scene 1 (Top) -> Patterns view, Scene 2 (Bottom) -> Steps view (#4)
    if (ev.control === 'Scene Top' || ev.control === 'Scene Bottom') { if (ev.value > 0) setPadView(ev.control === 'Scene Top' ? 'patterns' : 'steps'); return; }
    // Track Left/Right select the previous/next Part (like Soft 1-8, but stepping).
    if (ev.control === 'Track Left' || ev.control === 'Track Right') {
      if (ev.value > 0) { const ch = Math.max(1, Math.min(8, st.activeChannel + (ev.control === 'Track Right' ? 1 : -1))); selectChannel(ch); }
      return;
    }
    // Grid toggles pad function between playable pads and the step grid
    if (ev.control === 'Grid') { ledHex(64, ev.value > 0 ? PRESS : dim('#ffffff')); if (ev.value > 0) { engine.nav(st.rt, 'grid'); if (st.rt.padMode === 'sequencer') refreshGrid(); else refreshNotePads(); log('grid: ' + st.rt.padMode); } return; }
    // In options mode the screen arrows page between steps 1-8 and 9-16 (#6)
    if (st.optionsMode && (ev.control === 'Screen Up' || ev.control === 'Screen Down')) {
      if (ev.value > 0) { st.stepPage = ev.control === 'Screen Down' ? 1 : 0; refreshOptionScreens(); log('steps ' + (st.stepPage ? '9-16' : '1-8')); }
      return;
    }
    // Pads Up/Down: in Patterns view page the Parts (#17); in Steps view page
    // patterns (or Shift-transpose an octave).
    if (ev.control === 'Pads Up' || ev.control === 'Pads Down') {
      if (ev.value > 0) {
        if (st.padView === 'patterns') { pagePart(ev.control === 'Pads Down' ? 1 : -1); }
        else if (st.shift) transposeCurrent(ev.control === 'Pads Up' ? 12 : -12);
        else pagePattern(ev.control === 'Pads Down' ? 1 : -1);
      }
      return;
    }
    // Screen Up/Down page the knob banks (#24) — options mode's step-paging is handled above.
    if (ev.control === 'Screen Up' || ev.control === 'Screen Down') {
      if (ev.value > 0) { engine.nav(st.rt, ev.control === 'Screen Up' ? 'knobBank-' : 'knobBank+'); refreshKnobScreens(); refreshArrowLeds(); log('knob bank ' + ((st.rt.knobBank || 0) + 1)); }
      return;
    }
    // Clear / Duplicate held modifiers (for step editing); white on press, dim resting (#12)
    if (ev.control === 'Clear') { ledHex(67, ev.value > 0 ? PRESS : dim('#ff0000')); st.mod = ev.value > 0 ? 'clear' : (st.mod === 'clear' ? null : st.mod); return; }
    if (ev.control === 'Duplicate') { ledHex(66, ev.value > 0 ? PRESS : dim('#00ff00')); st.mod = ev.value > 0 ? 'dup' : (st.mod === 'dup' ? null : st.mod); if (ev.value === 0) st.dupFrom = null; return; }

    const c = mapControl(ev.control);

    // ---- Options mode intercepts knobs + soft buttons (#6) ----
    if (st.optionsMode && c) {
      if (c.group === 'button') {
        const microPos = opts().MICROSTEP_BUTTONS.indexOf(c.index);
        if (microPos >= 0) { // micro-step buttons: held while playing keys to enter notes (#12)
          if (ev.value > 0) st.heldMicros.add(microPos); else st.heldMicros.delete(microPos);
          return;
        }
        if (ev.value > 0) {
          const menu = opts().menuForButton(c.index);
          if (menu) { st.optionsMenu = menu; refreshOptionLeds(); refreshOptionScreens(); if (st.rt.padMode === 'sequencer') refreshGrid(); log('menu: ' + menu); }
        }
        return;
      }
      // In options mode, pressing a pad selects that step for micro-step editing (#12).
      if (c.group === 'pad' && st.padView === 'steps' && c.index < 16) {
        if (ev.value > 0) { st.selStep = c.index; refreshOptionLeds(); notify(); log('step ' + (c.index + 1) + ' selected'); }
        return;
      }
      if (c.group === 'knob') {
        const t = curTrack(); if (t) {
          const seq = model().sequencer;
          const delta = engine.knobDelta(ev.value);
          const desc = opts().applyKnob(seq, t.patterns[t.activePattern], st.optionsMenu, c.index, delta, st.stepPage, st.shift);
          // Tempo, swing, and swing-sync all change the clock's per-tick timing —
          // retune the running clock for any of them, not just tempo, so swing
          // updates immediately without needing a tempo nudge.
          if (desc) { scheduleOptionScreens(); if (st.rt.padMode === 'sequencer') refreshGrid(); contentChanged(); if (/tempo|swing/.test(desc)) restartClockIfRunning(); log(desc); }
        }
        return;
      }
    }

    // Patterns view (#17): top row = Part `partTop`, bottom row = `partTop+1`.
    // A pad selects that Part + pattern; two+ in the same row chain them (#11/#3).
    if (c && c.group === 'pad' && st.padView === 'patterns' && st.rt && st.rt.padMode === 'sequencer') {
      const m = model(); const tracks = m && m.sequencer && m.sequencer.tracks;
      const row = Math.floor(c.index / 8), col = c.index % 8, ti = st.partTop + row;
      const t = tracks && tracks[ti];
      if (ev.value > 0 && col < SEQ().PATTERNS && t) {
        if (st.mod === 'clear') { SEQ().clearPattern(t.patterns[col]); refreshPatternPads(); contentChanged(); return; }
        if (st.mod === 'dup') { if (st.dupFrom == null) st.dupFrom = col; else SEQ().copyPattern(t, st.dupFrom, col); refreshPatternPads(); contentChanged(); return; }
        if (ti + 1 !== st.activeChannel) selectChannel(ti + 1); // pressing a Part's pad makes it the active Part
        st.heldPatterns.add(c.index);
        const sameRow = [...st.heldPatterns].filter((p) => Math.floor(p / 8) === row).map((p) => p % 8);
        const instant = st.shift || !seqIsPlaying();
        let sel;
        if (sameRow.length >= 2) { sel = { activePattern: Math.min(...sameRow), chain: { from: Math.min(...sameRow), to: Math.max(...sameRow) } }; log((instant ? 'chain ' : 'queued chain ') + (sel.chain.from + 1) + '-' + (sel.chain.to + 1)); }
        else { sel = { activePattern: col, chain: null }; log((instant ? 'pattern ' : 'queued pattern ') + (col + 1)); }
        if (instant) { t.activePattern = sel.activePattern; t.chain = sel.chain; t.pending = null; }
        else t.pending = sel;
        refreshPatternPads(); refreshArrowLeds(); if (st.optionsMode) refreshOptionScreens(); notify();
      } else if (ev.value === 0) { st.heldPatterns.delete(c.index); }
      return;
    }

    // Soft buttons: 1-8 (below the screens) select the channel/instrument;
    // 9-24 (above the faders) are the fixed Mute/Solo bank. Press-to-lighten (#5).
    if (c && c.group === 'button') {
      const bank = (st.rt && st.rt.buttonBank) || 0;
      pressFlash('button', c.index, ev.value > 0);
      if (c.index >= 8 && c.index < 24 && bank > 0) {
        // Non-Mute/Solo button bank: the 16 buttons emit their mapped MIDI (#31).
        const idx = c.index - 8;
        const res = engine.handle(st.rt, { group: 'button', index: idx, value: ev.value });
        res.out.forEach((mb) => sendMusic(st.destId, mb));
        if (res.out.length) { recordAutomation('button', idx, res.out[res.out.length - 1]); log('▶ Soft ' + (c.index + 1)); }
        return;
      }
      if (ev.value > 0) {
        if (c.index < 8) selectChannel(c.index + 1);              // Soft 1-8 -> channel 1-8 (#7)
        else if (c.index < 24) { const a = msBank()[c.index - 8]; if (a) (c.index < 16 ? toggleMute : toggleSolo)(a.channel); } // Soft 9-16 Mute, 17-24 Solo (#1)
      }
      return;
    }

    const navAction = engine.NAV_MAP[ev.control];
    if (navAction) { if (ev.value > 0) { engine.nav(st.rt, navAction); if (/knobBank/.test(navAction)) refreshKnobScreens(); else { if (/buttonBank/.test(navAction)) refreshButtonArea(); refreshCentreScreen(); } refreshArrowLeds(); log('⇄ ' + ev.control); } return; }
    if (!c) return;

    // Pad in the step sequencer: hold-pad + keys note entry, clear/duplicate, audition
    if (c.group === 'pad' && st.rt.padMode === 'sequencer') {
      const p = gridPattern(); if (!p) return;
      if (ev.value > 0) { // press
        if (st.mod === 'clear') { SEQ().clearStep(p, c.index); refreshGrid(); contentChanged(); return; }
        if (st.mod === 'dup') { if (st.dupFrom == null) st.dupFrom = c.index; else SEQ().copyStep(p, st.dupFrom, c.index); refreshGrid(); contentChanged(); return; }
        st.heldPads.add(c.index);
        if (st.heldKeys.size) st.heldKeys.forEach((vel, note) => SEQ().toggleStepNote(p, c.index, note, vel, 6)); // reverse order: keys already held
        else if (!seqIsPlaying()) auditionStep(p, c.index, true); // audition when stopped
        refreshGrid(); ledHex(38 + c.index, '#ff0000'); notify(); // pressed sequencer pad -> red (#12)
      } else { // release
        st.heldPads.delete(c.index);
        if (!seqIsPlaying()) auditionStep(p, c.index, false);
        refreshGrid();
      }
      return;
    }

    // Hold Clear + move a control to clear that control's automation (User Guide p.11).
    if (st.mod === 'clear' && ev.value > 0 && (c.group === 'knob' || c.group === 'fader' || c.group === 'button')) {
      const t = curTrack(); const p = t && t.patterns[t.activePattern];
      const key = autoKey(c.group, c.index);
      if (p && p.automation && p.automation[key]) { delete p.automation[key]; notify(); log('cleared automation ' + key); }
      return;
    }
    const res = engine.handle(st.rt, { group: c.group, index: c.index, value: ev.value });
    res.out.forEach((mb) => sendMusic(st.destId, mb));
    // Automation: while recording+playing, capture the emitted value for this control (#automation).
    if (res.out.length && res.out[0]) recordAutomation(c.group, c.index, res.out[res.out.length - 1]);
    if (c.group === 'knob') queueKnobValue(c.index); // show adjustment on the SL screens (coalesced #22)
    if (c.group === 'fader') queueFaderLed(c.index, ev.value); // LED brightness tracks value (#2), coalesced (#22)
    if (c.group === 'pad') pressFlash('pad', c.index, ev.value > 0); // press-to-lighten in instrument mode (#5)
    else if (res.ledDirty) { const led = engine.ledOne(st.rt, c.group, c.index); if (led) midi.sendToOutput(st.slOutId, led); }
    if (res.out.length) log('▶ ' + ev.control);
  }

  function start() {
    if (st.running) return;
    if (!midi.snapshot().connected) { log('Connecting…'); return; }
    if (!st.slInId) { log('SL MkIII not found — plug it in and enable InControl.'); return; } // destination optional (LEDs still work)
    st.baseRt = engine.makeRuntime(global.SLMK.studioState.getModel());
    st.channelRt = {};
    st.rt = runtimeForChannel(st.activeChannel);
    blackout(); // clear every LED so nothing overlaps (#12)
    refreshKnobScreens();
    if (st.rt.padMode === 'sequencer') refreshGrid(); else refreshNotePads(); // pads show grid or dim part colour (#7/#12)
    refreshSceneLeds();
    refreshArrowLeds();
    refreshOptionLeds();
    refreshFunctionLeds();
    refreshTransport();
    refreshButtonArea();
    refreshChannelLeds();
    refreshKeyGuide(); // light the keybed in the current Part's colour (#51)
    for (let i = 0; i < 8; i++) refreshFaderLed(i, 0); // faders start dim (value unknown until moved)
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
    initTheme();
    initSettings();
    refreshPorts();
    midi.onChange(() => { if (!st.running) { refreshPorts(); autoStart(); } });
    $('#se-in').addEventListener('change', (e) => (st.slInId = e.target.value));
    $('#se-out').addEventListener('change', (e) => { st.slOutId = e.target.value; if (st.running) refreshSurface(); });
    $('#se-dest').addEventListener('change', (e) => (st.destId = e.target.value));
    if ($('#se-keys')) $('#se-keys').addEventListener('change', (e) => (st.keysInId = e.target.value));
    $('#se-start').addEventListener('click', () => (st.running ? stop() : start()));
    // Native MIDI (Electron) or Web MIDI: connect automatically, then auto-start.
    if (global.electronMIDI || (global.navigator && global.navigator.requestMIDIAccess)) {
      midi.connect().then(() => { refreshPorts(); autoStart(); }).catch((e) => log('MIDI: ' + e.message));
    }
  }
  // Auto-start the engine once the SL MkIII input is detected (#8).
  function autoStart() {
    if (st.running) return;
    if (!st.slInId) st.slInId = midi.guessDefaultInputId();
    if (!st.slOutId) st.slOutId = midi.guessDefaultOutputId();
    if (!st.keysInId) st.keysInId = midi.guessDefaultKeysInputId();
    if (!st.keysOutId && midi.guessDefaultKeysOutputId) st.keysOutId = midi.guessDefaultKeysOutputId();
    if (st.slInId && midi.snapshot().connected) start();
  }
  // Settings drawer (cog top-right) + theme toggle (#8, #10).
  function initSettings() {
    const panel = $('#settings-panel');
    const toggle = (show) => { if (panel) panel.hidden = show == null ? !panel.hidden : !show; };
    if ($('#settings-btn')) $('#settings-btn').addEventListener('click', () => toggle());
    if ($('#settings-close')) $('#settings-close').addEventListener('click', () => toggle(false));
    if ($('#theme-toggle')) $('#theme-toggle').addEventListener('click', toggleTheme);
  }
  function initTheme() {
    let t = 'dark';
    try { t = localStorage.getItem('slmkiii-theme') || 'dark'; } catch (e) {}
    applyTheme(t);
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const b = $('#theme-toggle'); if (b) b.textContent = t === 'dark' ? 'Switch to light' : 'Switch to dark';
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('slmkiii-theme', next); } catch (e) {}
  }

  // Public API for the Sequencer UI tab.
  global.SLMK.studioRuntime = {
    seqPlay, seqStop, seqIsPlaying, recording: () => st.recording, toggleRecord,
    onStep: (cb) => st.stepCbs.push(cb),
    onChange: (cb) => st.changeCbs.push(cb),
    playhead: () => (st.seqRt ? st.seqRt.pos[st.gridTrack].pad : -1),
    setGridTrack: (i) => { st.gridTrack = i; if (st.rt && st.rt.padMode === 'sequencer') refreshGrid(); notify(); },
    gridTrack: () => st.gridTrack,
    restartClock: () => retuneClock(),
    // Inject a resolved-control MIDI message (used by tests and future on-screen control).
    handleControl: (bytes) => onMsg(bytes),
    handleKeys: (bytes) => onKeys(bytes),
    tick: () => clockTick(), // drive one 24-PPQN tick (tests)
    // Extra metronome lead (ms): plays the click even earlier. MIDI is never
    // delayed; only the audio click is scheduled ahead. Blank/null = 0 (auto
    // latency compensation still applies from the measured audio latency).
    setMetroLead: (ms) => { st.metroSyncMs = ms == null || ms === '' ? null : Math.max(-200, Math.min(200, +ms || 0)); },
    metroLead: () => (st.metroSyncMs != null ? st.metroSyncMs : 0),
    audioLatency: () => st.audioLatencyMs || 0,
    // Metronome audio output selection (low-latency driver / device, #ask).
    setAudioLatencyHint: (h) => { if (h && h !== st.audioLatencyHint) { st.audioLatencyHint = h; resetAudio(); } },
    audioLatencyHint: () => st.audioLatencyHint,
    setAudioSink: (id) => { st.audioSinkId = id || null; if (st.audioCtx && st.audioCtx.setSinkId) { try { st.audioCtx.setSinkId(id || ''); } catch (e) {} } else resetAudio(); },
    audioSink: () => st.audioSinkId,
    listAudioOutputs: async () => {
      try {
        if (!global.navigator || !global.navigator.mediaDevices || !global.navigator.mediaDevices.enumerateDevices) return [];
        const devs = await global.navigator.mediaDevices.enumerateDevices();
        return devs.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, name: d.label || 'Output' }));
      } catch (e) { return []; }
    },
    setKeyGuide: (on) => { const was = st.keyGuide; st.keyGuide = !!on; if (on && !was) refreshKeyGuide(); else if (!on && st.slOutId) { for (let nt = KEY_LO; nt <= KEY_HI; nt++) midi.sendToOutput(st.slOutId, [0x9f, nt & 0x7f, KEY_PAL.off]); } },
    refreshSurface,
    state: () => st,
  };

  document.addEventListener('DOMContentLoaded', init);
})(window);
