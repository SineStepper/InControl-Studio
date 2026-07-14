/*
 * studio-options.js — pure logic for the SL MkIII standalone-style sequencer
 * control surface in InControl mode (GitHub issues #4, #6, #7).
 *
 * The live I/O (reading knobs/buttons, driving LEDs and screens) lives in
 * studio-runtime.js; everything here is a pure function of the model so it can
 * be unit-tested without MIDI or a DOM.
 *
 * Options mode (#6): pressing Options opens an editing surface. The row of soft
 * buttons below the screens selects a menu (Velocity / Gate / Chance / Tempo /
 * Pattern); knobs 1-8 edit the value(s); the screens show a per-knob readout.
 * The top six soft buttons are the microstep row and light light-orange.
 *
 * Scene mapping (#4): Scene 1 (Top) -> Patterns view, Scene 2 (Bottom) -> Steps
 * view. Pattern nav (#7): Pads Up/Down page the eight patterns, and the arrow
 * LEDs reflect the position in the list.
 *
 * SOFT-BUTTON LAYOUT: Soft 1-8 (indices 0-7) are the row below the screens and
 * select the menus; Soft 9-24 (indices 8-23) are the 16 buttons above the
 * faders (the Mute/Solo bank in normal mode). In options mode the first six of
 * those (indices 8-13) become the microstep row.
 */
(function (global) {
  'use strict';

  const DIRECTIONS = ['Forward', 'Backwards', 'Ping-Pong', 'Random'];
  // Slow -> fast, matching the sequencer core; index is the on-wire value.
  const SYNC_ORDER = ['1/32 Triplet', '1/32', '1/16 Triplet', '1/16', '1/8 Triplet', '1/8', '1/4 Triplet', '1/4'];
  // Displayed fast -> slow for the knob sweep (1/4 .. 1/32T), as the issue lists it.
  const SYNC_DISPLAY = ['1/4', '1/4 Triplet', '1/8', '1/8 Triplet', '1/16', '1/16 Triplet', '1/32', '1/32 Triplet'];

  // Per-menu definition. `field` is the per-step property the knobs edit.
  const MENUS = {
    velocity: { label: 'Velocity', color: '#ff0000', field: 'velocity', min: 1, max: 127, perStep: true },
    gate: { label: 'Gate', color: '#00ff00', field: 'gate', min: 1, max: 192, perStep: true }, // 1/6-step units, up to 32 steps
    chance: { label: 'Chance', color: '#ff6a00', field: 'chance', min: 0, max: 100, perStep: true, onStep: true },
    tempo: { label: 'Tempo', color: '#ffffff', perStep: false },
    pattern: { label: 'Pattern', color: '#0000ff', perStep: false },
  };
  const MENU_ORDER = ['velocity', 'gate', 'chance', 'tempo', 'pattern'];

  // Soft-button index (0-based) -> menu key (the row below the screens, Soft 1-8).
  const MENU_BUTTONS = { 0: 'velocity', 1: 'gate', 2: 'chance', 3: 'tempo', 7: 'pattern' };
  // The six microstep buttons (first six above-fader buttons) — light light-orange.
  const MICROSTEP_BUTTONS = [8, 9, 10, 11, 12, 13];
  const LIGHT_ORANGE = '#ff8c32';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const menuForButton = (index) => MENU_BUTTONS[index] || null;
  // Label of the menu a soft button (0-7) selects, for the screen row above it (#57).
  const menuLabelForButton = (index) => { const k = MENU_BUTTONS[index]; return k ? MENUS[k].label : ''; };

  // Notes carrying the edited field for one step (chord-aware).
  function stepNotes(pattern, stepIdx) {
    const s = pattern && pattern.steps && pattern.steps[stepIdx];
    return (s && s.notes) || [];
  }

  /**
   * Apply an endless-encoder delta from knob `knobIndex` (0-7) in the current
   * options menu. `page` is 0 (steps 1-8) or 1 (steps 9-16). When `shift` is
   * true, knob 1 edits every step at once (per the issue). Mutates seq/pattern
   * in place; returns a short description of what changed (or null).
   */
  function applyKnob(seq, pattern, menuKey, knobIndex, delta, page, shift) {
    if (!delta) return null;
    const menu = MENUS[menuKey];
    if (!menu) return null;

    if (menu.perStep) {
      const set = (stepIdx) => {
        if (menu.onStep) { // chance lives on the step, not the notes
          const s = pattern.steps[stepIdx];
          s.chance = clamp((s.chance == null ? 100 : s.chance) + delta, menu.min, menu.max);
        } else {
          // Velocity/Gate snap every note on the step to one uniform value, based on
          // the highest present value (User Guide: favours higher, snaps closest).
          const notes = stepNotes(pattern, stepIdx);
          if (!notes.length) return;
          const cur = Math.max.apply(null, notes.map((n) => (n[menu.field] == null ? menu.min : n[menu.field])));
          const nv = clamp(cur + delta, menu.min, menu.max);
          notes.forEach((n) => (n[menu.field] = nv));
        }
      };
      // Shift edits ALL steps at once, and is ALWAYS driven by Knob 1 (index 0),
      // regardless of which knob holds the first step (#6). Other knobs do nothing.
      if (shift) { if (knobIndex !== 0) return null; for (let i = 0; i < 16; i++) set(i); return 'all ' + menu.field; }
      if (knobIndex > 7) return null;
      const stepIdx = page * 8 + knobIndex;
      if (stepIdx > 15) return null;
      set(stepIdx);
      return menu.field + ' step ' + (stepIdx + 1);
    }

    if (menuKey === 'tempo') {
      const met = (seq.metronome = seq.metronome || { on: false, sound: 'Ping' });
      if (knobIndex === 0) { seq.tempo = clamp((seq.tempo || 120) + delta, 40, 240); return 'tempo ' + seq.tempo; }
      // Swing and the three discrete metronome controls were far too twitchy — a
      // single detent flipped them (user feedback). Accumulate raw encoder deltas
      // and only act once a threshold of detents is crossed, so a deliberate turn
      // is required. Swing halves its rate; the toggles need ~4 detents per change.
      if (knobIndex === 1) { const d = accumulate(seq, 'swing', delta, 2); if (!d) return null; seq.swing = clamp((seq.swing == null ? 50 : seq.swing) + d, 10, 80); return 'swing ' + seq.swing; }
      if (knobIndex === 2) { seq.swingSync = cycleIndex(SYNC_DISPLAY, seq.swingSync, delta); return 'swing sync ' + seq.swingSync; }
      if (knobIndex === 3) { const d = accumulate(seq, 'metOn', delta, 4); if (!d) return null; met.on = d > 0; return 'metronome ' + (met.on ? 'on' : 'off'); }        // #46 on/off
      if (knobIndex === 4) { const d = accumulate(seq, 'metSound', delta, 4); if (!d) return null; met.sound = cycleIndex(['Ping', 'Tick', 'Pop'], met.sound || 'Ping', d); return 'metro sound ' + met.sound; } // #47
      if (knobIndex === 5) { const d = accumulate(seq, 'metSilent', delta, 4); if (!d) return null; met.silent = d > 0; return 'metro ' + (met.silent ? 'blink only' : 'click'); } // #45 blink-only (no sound)
      return null;
    }

    if (menuKey === 'pattern') {
      if (knobIndex === 0) { pattern.start = clamp((pattern.start || 0) + delta, 0, 15); return 'start ' + pattern.start; }
      if (knobIndex === 1) { pattern.end = clamp((pattern.end == null ? 15 : pattern.end) + delta, 0, 15); return 'end ' + pattern.end; }
      if (knobIndex === 2) { pattern.direction = cycleIndex(DIRECTIONS, pattern.direction, delta); return 'dir ' + pattern.direction; }
      if (knobIndex === 3) { pattern.syncRate = cycleIndex(SYNC_DISPLAY, pattern.syncRate, delta); return 'sync ' + pattern.syncRate; }
      if (knobIndex === 4) { pattern.shift = ((pattern.shift || 0) + delta % 16 + 16) % 16; return 'shift ' + pattern.shift; } // wraps
      return null;
    }
    return null;
  }

  // Sensitivity limiter for the twitchy tempo-page knobs: accumulate raw encoder
  // deltas per control on `seq` and only emit a whole effective step once a
  // `threshold` of detents is reached, keeping the remainder for the next turn.
  function accumulate(seq, key, delta, threshold) {
    const acc = (seq.knobAccum = seq.knobAccum || {});
    const total = (acc[key] || 0) + delta;
    const steps = (total / threshold) | 0; // truncate toward zero
    acc[key] = total - steps * threshold;  // carry the remainder
    return steps;
  }

  // Step a value through a list by a signed delta (clamped, no wrap).
  function cycleIndex(list, current, delta) {
    let i = list.indexOf(current);
    if (i < 0) i = 0;
    return list[clamp(i + delta, 0, list.length - 1)];
  }

  // A one-row "graphic" of a track's 8 patterns for the top edge of the 5th screen
  // (#66, revised): the current/playing pattern is '#', chained patterns (members
  // of the active chain, other than the current one) are '+' (filled), and
  // unchained patterns are '-' (unfilled). The whole strip is drawn in white, so
  // per-character colour isn't needed — the glyphs carry the three states.
  function patternStrip(active, chain, count) {
    const n = count || 8;
    const lo = chain ? Math.min(chain.from, chain.to) : -1;
    const hi = chain ? Math.max(chain.from, chain.to) : -1;
    let s = '';
    for (let i = 0; i < n; i++) {
      if (i === active) s += '#';                 // current / playing — white
      else if (chain && i >= lo && i <= hi) s += '+'; // chained — filled box
      else s += '-';                              // unchained — unfilled box
    }
    return s;
  }

  // A two-row, 8-char-per-row "graphic" of a pattern's 16 steps for the SL column
  // screens (#66): the currently-playing step (`head`, 0-15, or -1 when stopped) is
  // marked '#', steps that hold notes 'o', and empty steps '-'. Row 0 = steps 1-8,
  // row 1 = steps 9-16, so the two rows together fill the bottom half of a screen.
  function stepBars(pattern, head) {
    const rows = ['', ''];
    const steps = (pattern && pattern.steps) || [];
    for (let i = 0; i < 16; i++) {
      const s = steps[i];
      const has = s && s.notes && s.notes.length;
      rows[i >> 3] += (i === head ? '#' : (has ? 'o' : '-'));
    }
    return rows;
  }

  // Average a list of #RRGGBB colours into one #RRGGBB (ignores blanks/black).
  // Used for the 5th/centre screen's button-bank edge bars (#68).
  function avgColor(hexes) {
    const list = (hexes || []).filter((h) => /^#?[0-9a-f]{6}$/i.test(h || '') && !/^#?0{6}$/.test(h || ''));
    if (!list.length) return '#000000';
    let r = 0, g = 0, b = 0;
    list.forEach((h) => { const n = parseInt(h.replace('#', ''), 16); r += (n >> 16) & 0xff; g += (n >> 8) & 0xff; b += n & 0xff; });
    const c = list.length;
    const hx = (v) => Math.round(v / c).toString(16).padStart(2, '0');
    return '#' + hx(r) + hx(g) + hx(b);
  }

  // A "small white box" for the gate readout (0-5 of them = the ⅙-step remainder).
  // The SL screen text is 7-bit ASCII, so we use the most box-like printable glyph.
  const boxes = (n) => Array(Math.max(0, Math.min(5, n)) + 1).join('#');
  const scale = (v, lo, hi) => clamp(Math.round(((v - lo) / (hi - lo)) * 127), 0, 127);

  /**
   * Per-knob screen descriptors (up to 8 columns) for the current menu/page.
   * Each column: { top, glyph, glyphValue (0-127), mid, bottom } — the runtime
   * draws the top label, an optional white knob glyph, and the reading below.
   * Matches the standalone sequencer's screens (#6).
   */
  function columns(seq, pattern, menuKey, page) {
    const menu = MENUS[menuKey];
    if (!menu) return [];
    if (menu.perStep) {
      const cols = [];
      for (let i = 0; i < 8; i++) {
        const stepIdx = page * 8 + i;
        const top = 'Step ' + (stepIdx + 1);                 // tops of each screen say "Step N"
        if (menuKey === 'chance') {
          const v = pattern.steps[stepIdx].chance == null ? 100 : pattern.steps[stepIdx].chance;
          cols.push({ top, glyph: true, glyphValue: scale(v, 0, 100), bottom: v + '%' }); // white knob glyph + %
        } else if (menuKey === 'velocity') {
          const notes = stepNotes(pattern, stepIdx);
          const v = notes.length ? Math.max.apply(null, notes.map((n) => (n.velocity == null ? 1 : n.velocity))) : null;
          cols.push({ top, glyph: v != null, glyphValue: clamp(v || 0, 0, 127), bottom: v == null ? '-' : String(v) }); // white knob glyph + number
        } else { // gate: whole number of steps + 0-5 small white boxes for the ⅙ remainder (never 0-192)
          const notes = stepNotes(pattern, stepIdx);
          const g = notes.length ? Math.max.apply(null, notes.map((n) => (n.gate == null ? 6 : n.gate))) : null;
          if (g == null) cols.push({ top, glyph: false, bottom: '-' });
          else cols.push({ top, glyph: false, bottom: Math.floor(g / 6) + ' ' + boxes(g % 6) }); // whole steps + # boxes
        }
      }
      return cols;
    }
    if (menuKey === 'tempo') {
      const t = seq.tempo || 120, sw = seq.swing == null ? 50 : seq.swing;
      const met = seq.metronome || { on: false, sound: 'Ping' };
      return [
        { top: 'Tempo', glyph: true, glyphValue: scale(t, 40, 240), bottom: String(t) },
        { top: 'Swing', glyph: true, glyphValue: scale(sw, 10, 80), bottom: sw + '%' },
        { top: 'Swing Sync Rate', glyph: false, bottom: seq.swingSync || '1/16' },
        { top: 'Metronome', glyph: false, bottom: met.on ? 'On' : 'Off' },   // #46
        { top: 'Click Sound', glyph: false, bottom: met.sound || 'Ping' },   // #47
        { top: 'Blink Only', glyph: false, bottom: met.silent ? 'Yes' : 'No' }, // #45
      ];
    }
    if (menuKey === 'pattern') {
      const s = pattern.start || 0, e = pattern.end == null ? 15 : pattern.end, sh = pattern.shift || 0;
      return [
        { top: 'Start', glyph: true, glyphValue: scale(s, 0, 15), bottom: String(s + 1) },
        { top: 'End', glyph: true, glyphValue: scale(e, 0, 15), bottom: String(e + 1) },
        { top: 'Direction', glyph: false, bottom: pattern.direction || 'Forward' },
        { top: 'Sync Rate', glyph: false, bottom: pattern.syncRate || '1/16' },
        { top: 'Shift', glyph: true, glyphValue: scale(sh, 0, 15), bottom: String(sh) },
      ];
    }
    return [];
  }

  /**
   * Soft-button LED colours for options mode: menu buttons in their colour
   * (the active one brightened), microstep row light-orange, others off.
   * Returns { softIndex: hex }.
   */
  function softLeds(activeMenu) {
    const leds = {};
    for (let i = 0; i < 8; i++) leds[i] = '#000000';  // unmapped menu buttons (Soft 1-8) unlit (#12)
    for (let i = 8; i < 24; i++) leds[i] = '#000000';  // the whole above-fader section goes dark (#6)…
    MICROSTEP_BUTTONS.forEach((i) => (leds[i] = LIGHT_ORANGE)); // …except the top 6 microstep buttons
    Object.keys(MENU_BUTTONS).forEach((k) => {
      const idx = +k;
      const menu = MENUS[MENU_BUTTONS[idx]];
      leds[idx] = MENU_BUTTONS[idx] === activeMenu ? menu.color : dim(menu.color);
    });
    return leds;
  }

  // Halve an #RRGGBB colour's brightness (for the un-selected menu buttons).
  function dim(hex) { return scaleColor(hex, 1 / 3); }

  /** Scale an #RRGGBB colour's brightness by `frac` (0..1). */
  function scaleColor(hex, frac) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#000000';
    const n = parseInt(m[1], 16);
    const f = Math.max(0, Math.min(1, frac));
    const h = (v) => Math.round(v * f).toString(16).padStart(2, '0');
    return '#' + h((n >> 16) & 0xff) + h((n >> 8) & 0xff) + h(n & 0xff);
  }
  // Brightness for a value-mode LED (fader/wheel): near-linear, with a small floor
  // so a fader at the bottom is dimly visible rather than looking dead.
  function valueColor(hex, value, max) { return scaleColor(hex, 0.1 + 0.9 * Math.max(0, Math.min(1, value / (max || 127)))); }

  /** Mix an #RRGGBB colour toward white by `frac` (0..1) — used for engaged/pressed states. */
  function lighten(hex, frac) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const f = Math.max(0, Math.min(1, frac));
    const h = (v) => Math.round(v + (255 - v) * f).toString(16).padStart(2, '0');
    return '#' + h((n >> 16) & 0xff) + h((n >> 8) & 0xff) + h(n & 0xff);
  }

  /** Pads Up/Down arrow LED states for the pattern list (#7). */
  function arrowLeds(activePattern, patternCount) {
    return { up: activePattern > 0, down: activePattern < (patternCount - 1) };
  }

  /** Pad colours (16) for the Patterns view (#4/#7): active pattern bright. */
  function patternPadLeds(activePattern, patternCount) {
    const out = [];
    for (let i = 0; i < 16; i++) {
      if (i >= patternCount) out.push('#000000');
      else out.push(i === activePattern ? '#ffffff' : '#101c3a');
    }
    return out;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.studioOptions = {
    MENUS, MENU_ORDER, MENU_BUTTONS, MICROSTEP_BUTTONS, LIGHT_ORANGE, DIRECTIONS, SYNC_ORDER, SYNC_DISPLAY,
    menuForButton, menuLabelForButton, applyKnob, columns, softLeds, arrowLeds, patternPadLeds, stepBars, patternStrip, avgColor, dim, scaleColor, valueColor, lighten,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.studioOptions;
})(typeof window !== 'undefined' ? window : globalThis);
