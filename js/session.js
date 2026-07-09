/*
 * session.js — read/write SL MkIII session SysEx dumps (.syx) and the raw
 * session bodies found inside Components packs (.slmkiiisession).
 *
 * A session .syx is a sequence of 64 session dumps, each using the same
 * container as templates but with type byte 0x01 (vs 0x02 for templates) and a
 * per-session slot byte: start / N data chunks (256 decoded bytes each, 7-to-8
 * encoded, nibble-indexed) / end (with a CRC-32 of the body as 8 nibbles). The
 * decoded body is the 94208-byte "USER" session blob (name at offset 0x20).
 *
 * Verified: decoding then re-encoding the real 64-session dump is bit-exact.
 */
(function (global) {
  'use strict';
  const T = () => global.SLMK.sltemplate; // reuse sevenToEight/eightToSeven/crc32
  const HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x03];
  const TYPE_SESSION = 0x01;
  const nib = (v) => { const n = []; for (let i = 7; i >= 0; i--) n.push((v >>> (4 * i)) & 0xf); return n; };

  function split(bytes) {
    const b = Array.isArray(bytes) ? bytes : Array.from(bytes);
    const out = []; let i = 0;
    while (i < b.length) { const s = b.indexOf(0xf0, i); if (s < 0) break; const e = b.indexOf(0xf7, s); if (e < 0) break; out.push(b.slice(s, e + 1)); i = e + 1; }
    return out;
  }
  function readName(body) { let s = ''; for (let i = 0x20; i < 0x40; i++) { const c = body[i]; if (!c) break; if (c >= 32 && c < 127) s += String.fromCharCode(c); } return s.replace(/\s+$/, ''); }

  /** Decode a session .syx into [{ slot, name, body: Uint8Array }]. */
  function decodeSyx(bytes) {
    const t = T();
    const msgs = split(bytes);
    const out = []; let body = [], slot = 0;
    for (const m of msgs) {
      if (m[7] === 1) { body = []; slot = m[17]; }
      else if (m[7] === 2) { const dec = t.sevenToEight(m.slice(18, m.length - 1)); for (const x of dec) body.push(x); }
      else if (m[7] === 3) { out.push({ slot, name: readName(body), body: new Uint8Array(body) }); }
    }
    return out;
  }

  /** Encode one session body (Uint8Array/array) into its container messages. */
  function encodeOne(body, slot) {
    const t = T();
    const b = Array.isArray(body) ? body : Array.from(body);
    const out = []; const push = (a) => { for (const x of a) out.push(x); };
    push(HEADER); push([1, ...nib(0), TYPE_SESSION, slot, 1, 0xf7]);
    let crc = 0, block = 0;
    while (block * 256 < b.length) {
      const chunk = b.slice(block * 256, (block + 1) * 256);
      crc = t.crc32(chunk, crc);
      push(HEADER); push([2, ...nib(block + 1), TYPE_SESSION, slot, ...t.eightToSeven(chunk), 0xf7]);
      block++;
    }
    push(HEADER); push([3, ...nib(block + 1), TYPE_SESSION, slot, ...nib(crc >>> 0), 0xf7]);
    return out;
  }

  /** Encode [{ body, slot? }] (or raw bodies) into a full session .syx byte array. */
  function encodeSyx(sessions) {
    const out = [];
    sessions.forEach((s, i) => { const body = s.body || s; const slot = s.slot != null ? s.slot : i; for (const x of encodeOne(body, slot)) out.push(x); });
    return out;
  }

  /*
   * Sequence layout inside the 94208-byte USER body (reverse-engineered from
   * controlled single-note ground-truth sessions and cross-checked against the
   * factory Demo/Red Moon sessions — see docs/SESSION-FORMAT.md).
   *
   *   8 tracks x 8 patterns x 16 steps, each step a 36-byte (0x24) record.
   *   gridOffset(track,pattern) = 0x13c + track*0x2d98 + pattern*0x5ac
   *   step record: [+0]=slot-active bitmask [+1]=chance(0-100) then 8 note-slots
   *     of 4 bytes at +4: slot k at step+4+k*4 = [note, velocity, gate|tie, 0];
   *     empty slot = [0,0x60,0,0]. A slot is a real note iff its note byte != 0.
   *   pattern footer at gridOffset+0x240: [+0]=length-1 [+1]=syncIdx [+2]=direction.
   *   globals: tempo LE @0x40, swing @0x42; per-track channel @0x115+track*0x2d98.
   */
  const GRID = { base: 0x13c, track: 0x2d98, pattern: 0x5ac, step: 0x24, steps: 16, slots: 8, tracks: 8, patterns: 8 };
  const gridOffset = (t, p) => GRID.base + t * GRID.track + p * GRID.pattern;
  // Session-body field offsets (see docs/SESSION-FORMAT.md), all pinned from
  // controlled single-field ground-truth captures.
  const OFF = { tempoLo: 0x40, tempoHi: 0x41, swing: 0x42, chan: 0x115, chain: 0x119 };
  const patFooter = (t, p) => gridOffset(t, p) + 0x240; // [+0]=length-1 [+1]=syncIdx [+2]=dir
  const trackHdr = (t) => GRID.base - GRID.pattern + t * GRID.track; // start of track t header block
  // Enums indexed by the raw byte value (mirror studio-sequencer.js).
  const SYNC_ORDER = ['1/32 Triplet', '1/32', '1/16 Triplet', '1/16', '1/8 Triplet', '1/8', '1/4 Triplet', '1/4'];
  const DIRECTIONS = ['Forward', 'Backwards', 'Ping-Pong', 'Random'];
  const GATE_PER_STEP = 6; // gate byte units: 6 == one full step

  /** Decode a session body's step sequence into a studio-sequencer object. */
  function readSequence(body) {
    const seq = {
      tempo: body[OFF.tempoLo] | (body[OFF.tempoHi] << 8),
      swing: body[OFF.swing], // raw hardware value (50 == straight/off)
      swingSync: '1/16',
      tracks: [],
    };
    if (!seq.tempo) seq.tempo = 120;
    const PART_COLORS = ['#ff2d2d', '#ff8c00', '#ffd000', '#38d430', '#00c8c8', '#2b7bff', '#8a4bff', '#ff3bce'];
    for (let t = 0; t < GRID.tracks; t++) {
      const track = { channel: (body[OFF.chan + t * GRID.track] & 0x0f) + 1, activePattern: 0, color: PART_COLORS[t % 8], swing: 'On', chain: null, patterns: [] };
      for (let p = 0; p < GRID.patterns; p++) {
        const g = gridOffset(t, p);
        const steps = [];
        for (let s = 0; s < GRID.steps; s++) {
          const step = g + s * GRID.step;
          const notes = [];
          for (let k = 0; k < GRID.slots; k++) {
            const so = step + 4 + k * 4;
            const raw = body[so];
            if (raw !== 0) {
              const gt = body[so + 2];
              const nt = { note: raw & 0x7f, velocity: body[so + 1], gate: gt & 0x7f };
              if (gt & 0x80) nt.tie = true; // gate bit 7 = tied/held note (extends past the step)
              notes.push(nt);
            }
          }
          steps.push({ notes, chance: body[step + 1] });
        }
        const f = patFooter(t, p);
        track.patterns.push({
          steps,
          start: 0,
          end: body[f] & 0x0f,
          direction: DIRECTIONS[body[f + 2]] || 'Forward',
          syncRate: SYNC_ORDER[body[f + 1]] || '1/16',
          shift: 0,
        });
      }
      seq.tracks.push(track);
    }
    return seq;
  }

  /** True if a session body carries any sequenced note (across every pattern). */
  function sequenceHasNotes(body) {
    for (let t = 0; t < GRID.tracks; t++)
      for (let p = 0; p < GRID.patterns; p++) {
        const g = gridOffset(t, p);
        for (let s = 0; s < GRID.steps; s++)
          for (let k = 0; k < GRID.slots; k++)
            if (body[g + s * GRID.step + 4 + k * 4] !== 0) return true;
      }
    return false;
  }

  /**
   * Write a studio-sequencer object into a copy of an existing session body,
   * overwriting only the step note-slots (and per-step flag) and leaving every
   * other byte untouched — so re-encoding an unmodified session stays bit-exact.
   */
  function writeSequence(baseBody, seq) {
    const body = new Uint8Array(baseBody);
    if (seq.tempo) { body[OFF.tempoLo] = seq.tempo & 0xff; body[OFF.tempoHi] = (seq.tempo >> 8) & 0xff; }
    if (seq.swing != null) body[OFF.swing] = seq.swing & 0xff;
    for (let t = 0; t < GRID.tracks; t++) {
      const track = seq.tracks && seq.tracks[t];
      if (track && track.channel != null) body[OFF.chan + t * GRID.track] = (track.channel - 1) & 0x0f;
      for (let p = 0; p < GRID.patterns; p++) {
        const pat = track && track.patterns && track.patterns[p];
        const g = gridOffset(t, p);
        if (pat) {
          const f = patFooter(t, p);
          if (pat.end != null) body[f] = pat.end & 0x0f;
          const si = SYNC_ORDER.indexOf(pat.syncRate); if (si >= 0) body[f + 1] = si; // else preserve
          const di = DIRECTIONS.indexOf(pat.direction); if (di >= 0) body[f + 2] = di;
        }
        for (let s = 0; s < GRID.steps; s++) {
          const step = g + s * GRID.step;
          const stepObj = pat && pat.steps && pat.steps[s];
          const notes = (stepObj && stepObj.notes) || [];
          if (stepObj && stepObj.chance != null) body[step + 1] = Math.max(0, Math.min(100, stepObj.chance));
          // Build the new 32-byte slot region; note whether it changed from the base.
          const before = body.slice(step + 4, step + 4 + GRID.slots * 4);
          let mask = 0;
          for (let k = 0; k < GRID.slots; k++) {
            const so = step + 4 + k * 4;
            if (k < notes.length) {
              const n = notes[k];
              body[so] = n.note & 0x7f;
              body[so + 1] = (n.velocity == null ? 100 : n.velocity) & 0x7f;
              body[so + 2] = ((n.gate == null ? 6 : n.gate) & 0x7f) | (n.tie ? 0x80 : 0);
              body[so + 3] = 0;
              mask |= 1 << k;
            } else {
              body[so] = 0; body[so + 1] = 0x60; body[so + 2] = 0; body[so + 3] = 0;
            }
          }
          // The step flag is a per-slot active bitmask on the hardware (bit 0 is
          // cleared for tied notes). Preserve it when the slots are untouched so
          // an unmodified session re-encodes bit-exact; otherwise recompute it.
          let changed = false;
          for (let i = 0; i < before.length; i++) if (before[i] !== body[step + 4 + i]) { changed = true; break; }
          if (changed) body[step] = mask;
        }
      }
    }
    return body;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.session = { decodeSyx, encodeSyx, encodeOne, readName, GRID, gridOffset, patFooter, OFF, SYNC_ORDER, DIRECTIONS, GATE_PER_STEP, readSequence, writeSequence, sequenceHasNotes };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.session;
})(typeof window !== 'undefined' ? window : globalThis);
