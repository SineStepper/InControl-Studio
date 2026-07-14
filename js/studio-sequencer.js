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

  // Default Part colours (one per track), echoing the SL MkIII's coloured Parts.
  const PART_COLORS = ['#ff2d2d', '#ff8c00', '#ffd000', '#38d430', '#00c8c8', '#2b7bff', '#8a4bff', '#ff3bce'];

  function newStep() { return { notes: [], chance: 100 }; }
  function newPattern() {
    return { steps: Array.from({ length: STEPS }, newStep), start: 0, end: 15, direction: 'Forward', syncRate: '1/16', shift: 0 };
  }
  function newTrack(i) {
    return { channel: i + 1, activePattern: 0, color: PART_COLORS[i % 8], swing: 'On', chain: null, pending: null, patterns: Array.from({ length: PATTERNS }, newPattern) };
  }
  function newSequencer() {
    return { tempo: 120, swing: 50, swingSync: '1/16', metronome: { on: false, sound: 'Ping' }, tracks: Array.from({ length: TRACKS }, (_, i) => newTrack(i)) };
  }

  // ---- playback runtime ----
  function makeSeqRuntime(seq) {
    return {
      seq,
      playing: false,
      recording: false,
      tick: 0,
      pos: seq.tracks.map(() => ({ counter: -1, pad: 0, pending: [], pendingOn: [] })), // per-track
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

  // Swing offset (in ticks) for the note firing at rt.tick on this track. Swing
  // pushes the off-beat of the swing sync-rate pair later (positive swing) or the
  // on-beat later (negative swing). Per-track On/Off; global 20-80%, 50 = none.
  function swingDelay(rt, track) {
    // When the runtime clock itself is swinging the whole timeline (hardware
    // playback, so the SL arp swings too — #39), don't also offset the note here
    // or swing would double up.
    if (rt.clockSwing) return 0;
    const s = rt.seq.swing;
    if (track.swing === 'Off' || s == null || s === 50) return 0;
    const swingStepTicks = SYNC[rt.seq.swingSync] || 6;
    const odd = Math.floor(rt.tick / swingStepTicks) % 2 === 1; // off-beat of the pair
    if (s > 50 && odd) return Math.round(((s - 50) / 50) * swingStepTicks);
    if (s < 50 && !odd) return Math.round(((50 - s) / 50) * swingStepTicks);
    return 0;
  }

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
      // fire due micro-step note-ons (scheduled within a step)
      for (let i = pstate.pendingOn.length - 1; i >= 0; i--) {
        const o = pstate.pendingOn[i];
        if (o.onTick <= rt.tick) { events.push({ type: 'on', channel: o.ch, note: o.note, velocity: o.velocity }); pstate.pending.push({ ch: o.ch, note: o.note, offTick: rt.tick + o.gateT }); pstate.pendingOn.splice(i, 1); }
      }
      // step boundary
      if (rt.tick % stepTicks === 0) {
        pstate.counter++;
        // At the end of a pattern cycle, apply a queued change (deferred pattern
        // switch, tempo-synced) or advance the chain (User Guide: "Pattern
        // changes will take effect when playback reaches the end of the Pattern").
        {
          const cur = track.patterns[track.activePattern];
          const len = Math.abs((cur.end || 0) - (cur.start || 0)) + 1;
          if (pstate.counter > 0 && pstate.counter % len === 0) {
            if (track.pending) {
              track.activePattern = track.pending.activePattern;
              track.chain = track.pending.chain || null;
              track.pending = null;
              pstate.counter = 0;
            } else if (track.chain) {
              let ap = track.activePattern + 1;
              if (ap > track.chain.to || ap < track.chain.from) ap = track.chain.from;
              track.activePattern = ap;
              pstate.counter = 0;
            }
          }
        }
        const p2 = track.patterns[track.activePattern]; // may have changed at the boundary
        const idx = stepIndexFor(pstate.counter, p2.start, p2.end, p2.direction, p2.shift, rng);
        pstate.pad = idx;
        const step = p2.steps[idx];
        if (step && step.notes.length) {
          const roll = (rng ? rng() : Math.random()) * 100;
          if (roll < (step.chance == null ? 100 : step.chance)) {
            const ch = (track.channel - 1) & 0x0f;
            const swingOff = swingDelay(rt, track);
            step.notes.forEach((nt) => {
              const gateT = gateTicks(nt.gate, stepTicks);
              const microOff = Math.round(((nt.micro || 0) / 6) * stepTicks) + swingOff; // micro-step + swing offset
              if (microOff <= 0) {
                events.push({ type: 'on', channel: ch, note: nt.note, velocity: nt.velocity || 100 });
                pstate.pending.push({ ch, note: nt.note, offTick: rt.tick + gateT });
              } else {
                pstate.pendingOn.push({ onTick: rt.tick + microOff, ch, note: nt.note, velocity: nt.velocity || 100, gateT });
              }
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
  function start(rt) { rt.playing = true; rt.tick = 0; rt.pos.forEach((p) => { p.counter = -1; p.pending = []; p.pendingOn = []; }); }
  function stop(rt) {
    rt.playing = false;
    const offs = allNotesOff(rt);
    // #70: rewind every CHAINED track to the first pattern of its chain, positioned
    // at that pattern's first step, so a restart begins the chain from the top
    // instead of wherever it happened to stop. Non-chained tracks already restart
    // at step 1 via start().
    rt.seq.tracks.forEach((track, ti) => {
      if (!track.chain) return;
      track.activePattern = track.chain.from;
      const ps = rt.pos[ti];
      if (ps) { ps.counter = -1; ps.pending = []; ps.pendingOn = []; ps.pad = track.patterns[track.chain.from].start || 0; }
    });
    return offs;
  }

  // ---- editing ----
  const DEFAULT_NOTE = 60;
  function toggleStepNote(pattern, stepIdx, note, velocity, gate) {
    const step = pattern.steps[stepIdx];
    const i = step.notes.findIndex((n) => n.note === note);
    if (i >= 0) step.notes.splice(i, 1);
    else step.notes.push({ note: note == null ? DEFAULT_NOTE : note, velocity: velocity || 100, gate: gate || 6 });
    return step.notes.length > 0;
  }
  // Toggle a note on a specific micro-step (0-5) of a step. A note is identified
  // by (note, micro) so the same pitch can exist on different micro-steps.
  function toggleMicroNote(pattern, stepIdx, micro, note, velocity, gate) {
    const step = pattern.steps[stepIdx];
    const m = micro || 0;
    const i = step.notes.findIndex((n) => n.note === note && (n.micro || 0) === m);
    if (i >= 0) step.notes.splice(i, 1);
    else step.notes.push({ note: note == null ? DEFAULT_NOTE : note, velocity: velocity || 100, gate: gate || 6, micro: m });
    return step.notes.length > 0;
  }
  const microHasNotes = (pattern, stepIdx, micro) => pattern.steps[stepIdx].notes.some((n) => (n.micro || 0) === (micro || 0));
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
    PPQN, SYNC, SYNC_ORDER, DIRECTIONS, STEPS, TRACKS, PATTERNS, DEFAULT_NOTE, PART_COLORS,
    newSequencer, newPattern, newTrack, makeSeqRuntime, stepIndexFor, gateTicks, onTick,
    start, stop, allNotesOff, toggleStepNote, toggleMicroNote, microHasNotes, stepHasNotes, clearStep, copyStep, clearPattern, copyPattern,
    setStepField, setStepChance, transposePattern,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.sequencer;
})(typeof window !== 'undefined' ? window : globalThis);
