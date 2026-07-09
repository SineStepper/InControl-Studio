/*
 * studio-sequencer.js — software step sequencer for InControl Studio (P4 core).
 *
 * Mirrors the SL MkIII's own sequencer (SL MkIII User Guide): 8 tracks, 8
 * patterns per track, 16 steps per pattern, velocity/gate/chance per step, four
 * play directions and eight sync rates, tempo/swing. Because InControl mode
 * takes over the pads, this runs the sequence in software and drives the pads as
 * the step grid via LEDs (the runtime does the I/O).
 *
 * Pure + tick-driven so it's unit-testable: a 24-PPQN clock calls onTick(), which
 * returns the note on/off events to emit. No MIDI, no DOM, no wall-clock.
 */
(function (global) {
  'use strict';

  const PPQN = 24;
  // Ticks per step at 24 PPQN for each sync rate.
  const SYNC = {
    '1/4': 24, '1/4 Triplet': 16, '1/8': 12, '1/8 Triplet': 8,
    '1/16': 6, '1/16 Triplet': 4, '1/32': 3, '1/32 Triplet': 2,
  };
  const SYNC_ORDER = ['1/32 Triplet', '1/32', '1/16 Triplet', '1/16', '1/8 Triplet', '1/8', '1/4 Triplet', '1/4'];
  const DIRECTIONS = ['Forward', 'Backwards', 'Ping-Pong', 'Random'];
  const STEPS = 16, TRACKS = 8, PATTERNS = 8;

  function newStep() { return { notes: [], chance: 100 }; }
  function newPattern() {
    return { steps: Array.from({ length: STEPS }, newStep), start: 0, end: 15, direction: 'Forward', syncRate: '1/16', shift: 0 };
  }
  function newTrack(i) { return { channel: i + 1, activePattern: 0, patterns: Array.from({ length: PATTERNS }, newPattern) }; }
  function newSequencer() {
    return { tempo: 120, swing: 0, tracks: Array.from({ length: TRACKS }, (_, i) => newTrack(i)) };
  }

  // ---- playback runtime ----
  function makeSeqRuntime(seq) {
    return {
      seq,
      playing: false,
      recording: false,
      tick: 0,
      pos: seq.tracks.map(() => ({ counter: -1, pad: 0, pending: [] })), // per-track
    };
  }

  // Map a monotonically increasing step counter to a pad index for a pattern.
  function stepIndexFor(counter, start, end, direction, shift, rng) {
    const lo = Math.min(start, end), hi = Math.max(start, end);
    const len = hi - lo + 1;
    if (len <= 1) return lo;
    let pos;
    switch (direction) {
      case 'Backwards': pos = (len - 1) - (counter % len); break;
      case 'Ping-Pong': { const period = 2 * len - 2; const p = counter % period; pos = p < len ? p : period - p; break; }
      case 'Random': pos = Math.floor((rng ? rng() : Math.random()) * len); break;
      default: pos = counter % len; // Forward
    }
    return lo + ((pos + shift) % len);
  }

  const gateTicks = (gateSixths, stepTicks) => Math.max(1, Math.round(((gateSixths || 6) / 6) * stepTicks));

  /**
   * Advance one 24-PPQN tick. Returns [{type:'on'|'off', channel, note, velocity}].
   * rng is injectable for deterministic tests (defaults to Math.random).
   */
  function onTick(rt, rng) {
    const events = [];
    if (!rt.playing) return events;
    rt.seq.tracks.forEach((track, ti) => {
      const p = track.patterns[track.activePattern];
      const stepTicks = SYNC[p.syncRate] || 6;
      const pstate = rt.pos[ti];
      // fire due note-offs
      for (let i = pstate.pending.length - 1; i >= 0; i--) {
        if (pstate.pending[i].offTick <= rt.tick) { const n = pstate.pending[i]; events.push({ type: 'off', channel: n.ch, note: n.note, velocity: 0 }); pstate.pending.splice(i, 1); }
      }
      // step boundary
      if (rt.tick % stepTicks === 0) {
        pstate.counter++;
        const idx = stepIndexFor(pstate.counter, p.start, p.end, p.direction, p.shift, rng);
        pstate.pad = idx;
        const step = p.steps[idx];
        if (step && step.notes.length) {
          const roll = (rng ? rng() : Math.random()) * 100;
          if (roll < (step.chance == null ? 100 : step.chance)) {
            const ch = (track.channel - 1) & 0x0f;
            step.notes.forEach((nt) => {
              events.push({ type: 'on', channel: ch, note: nt.note, velocity: nt.velocity || 100 });
              pstate.pending.push({ ch, note: nt.note, offTick: rt.tick + gateTicks(nt.gate, stepTicks) });
            });
          }
        }
      }
    });
    rt.tick++;
    return events;
  }

  // flush all sounding notes (on stop) — returns note-off events
  function allNotesOff(rt) {
    const events = [];
    rt.pos.forEach((pstate) => { pstate.pending.forEach((n) => events.push({ type: 'off', channel: n.ch, note: n.note, velocity: 0 })); pstate.pending = []; });
    return events;
  }
  function start(rt) { rt.playing = true; rt.tick = 0; rt.pos.forEach((p) => { p.counter = -1; p.pending = []; }); }
  function stop(rt) { rt.playing = false; return allNotesOff(rt); }

  // ---- editing ----
  const DEFAULT_NOTE = 60;
  function toggleStepNote(pattern, stepIdx, note, velocity, gate) {
    const step = pattern.steps[stepIdx];
    const i = step.notes.findIndex((n) => n.note === note);
    if (i >= 0) step.notes.splice(i, 1);
    else step.notes.push({ note: note == null ? DEFAULT_NOTE : note, velocity: velocity || 100, gate: gate || 6 });
    return step.notes.length > 0;
  }
  const stepHasNotes = (pattern, i) => pattern.steps[i].notes.length > 0;
  function clearStep(pattern, i) { pattern.steps[i] = newStep(); }
  function copyStep(pattern, from, to) { pattern.steps[to] = JSON.parse(JSON.stringify(pattern.steps[from])); }
  function clearPattern(pattern) { for (let i = 0; i < STEPS; i++) pattern.steps[i] = newStep(); }
  function copyPattern(track, from, to) { track.patterns[to] = JSON.parse(JSON.stringify(track.patterns[from])); }
  function setStepField(pattern, stepIdx, field, value) { pattern.steps[stepIdx].notes.forEach((n) => (n[field] = value)); }
  function setStepChance(pattern, stepIdx, chance) { pattern.steps[stepIdx].chance = Math.max(0, Math.min(100, chance)); }
  function transposePattern(pattern, semitones) {
    const notes = pattern.steps.flatMap((s) => s.notes);
    if (notes.some((n) => n.note + semitones < 0 || n.note + semitones > 127)) return false;
    notes.forEach((n) => (n.note += semitones));
    return true;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.sequencer = {
    PPQN, SYNC, SYNC_ORDER, DIRECTIONS, STEPS, TRACKS, PATTERNS, DEFAULT_NOTE,
    newSequencer, newPattern, newTrack, makeSeqRuntime, stepIndexFor, gateTicks, onTick,
    start, stop, allNotesOff, toggleStepNote, stepHasNotes, clearStep, copyStep, clearPattern, copyPattern,
    setStepField, setStepChance, transposePattern,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.sequencer;
})(typeof window !== 'undefined' ? window : globalThis);
