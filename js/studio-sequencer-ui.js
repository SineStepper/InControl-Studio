/*
 * studio-sequencer-ui.js — the Sequencer sub-tab of InControl Studio.
 * On-screen 16-step grid editor + transport + pattern settings, so the
 * sequencer is usable and testable without hardware. Playback + note output run
 * in studio-runtime.js; this drives/reflects it.
 */
(function (global) {
  'use strict';
  const Q = () => global.SLMK.sequencer;
  const S = () => global.SLMK.studio;
  const RT = () => global.SLMK.studioRuntime;

  let selStep = 0;
  let hooked = false;
  let undoStack = [], redoStack = [];
  function pushUndo(m) { undoStack.push(JSON.stringify(m.sequencer)); if (undoStack.length > 50) undoStack.shift(); redoStack = []; }
  function restore(host, from, to) { const m = model(); if (!from.length) return; to.push(JSON.stringify(m.sequencer)); m.sequencer = JSON.parse(from.pop()); render(host); }

  const el = (t, p = {}, c = []) => {
    const n = document.createElement(t);
    const { dataset, ...rest } = p;
    Object.assign(n, rest);
    if (dataset) Object.entries(dataset).forEach(([k, v]) => (n.dataset[k] = v));
    (Array.isArray(c) ? c : [c]).forEach((x) => n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    return n;
  };

  function model() { const m = global.SLMK.studioState.getModel(); S().ensureSequencer(m); return m; }
  function ctx() {
    const m = model();
    const ti = RT() ? RT().gridTrack() : 0;
    const track = m.sequencer.tracks[ti];
    return { m, ti, track, pat: track.patterns[track.activePattern] };
  }

  function render(host) {
    if (!hooked && RT()) {
      RT().onStep(() => paintHeads());
      // Re-render when the sequence content changes from the hardware (#16), but
      // only while the Sequencer sub-tab is on screen.
      RT().onChange(() => { const h = document.querySelector('#studio-body'); if (h && h.querySelector('.seq-wrap')) render(h); });
      hooked = true;
    }
    const prev = host.querySelector('.seq-wrap'); // replace our own content, keep the sub-tab bar
    if (prev) prev.remove();
    const c = ctx();
    const wrap = el('div', { className: 'seq-wrap' });

    // transport + global
    const bar = el('div', { className: 'seq-bar' });
    const play = el('button', { className: 'btn primary', id: 'seq-play' }, RT() && RT().seqIsPlaying() ? '■ Stop' : '▶ Play');
    play.addEventListener('click', () => { if (!RT()) return; RT().seqIsPlaying() ? RT().seqStop() : RT().seqPlay(); render(host); });
    const rec = el('button', { className: 'btn' + (RT() && RT().recording() ? ' running' : ''), title: 'Record from the SL MkIII keyboard while playing' }, '● Rec');
    rec.addEventListener('click', () => { if (RT()) { RT().toggleRecord(); render(host); } });
    const undo = el('button', { className: 'btn', title: 'Undo' }, '↶'); undo.addEventListener('click', () => restore(host, undoStack, redoStack));
    const redo = el('button', { className: 'btn', title: 'Redo' }, '↷'); redo.addEventListener('click', () => restore(host, redoStack, undoStack));
    bar.append(play, rec, undo, redo);
    bar.appendChild(numField('Tempo', c.m.sequencer.tempo, 20, 300, (v) => { c.m.sequencer.tempo = v; if (RT()) RT().restartClock(); }));
    bar.appendChild(selField('Track', range(8).map((i) => [i, 'Track ' + (i + 1)]), c.ti, (v) => { if (RT()) RT().setGridTrack(+v); selStep = 0; render(host); }));
    bar.appendChild(selField('Pattern', range(8).map((i) => [i, 'Pat ' + (i + 1)]), c.track.activePattern, (v) => { c.track.activePattern = +v; render(host); }));
    bar.appendChild(selField('Channel', range(16).map((i) => [i + 1, 'Ch ' + (i + 1)]), c.track.channel, (v) => { c.track.channel = +v; }));
    const col = el('input', { type: 'color', value: c.track.color || '#3bd0ff' });
    col.addEventListener('input', () => { c.track.color = col.value; if (RT()) RT().refreshSurface(); render(host); });
    bar.appendChild(el('label', { className: 'seq-f' }, ['Part colour ', col]));
    bar.appendChild(selField('Swing', [['On', 'On'], ['Off', 'Off']], c.track.swing || 'On', (v) => { c.track.swing = v; }));
    wrap.appendChild(bar);

    // pattern settings
    const set = el('div', { className: 'seq-bar' });
    set.appendChild(selField('Sync', Q().SYNC_ORDER.map((s) => [s, s]), c.pat.syncRate, (v) => { c.pat.syncRate = v; if (RT()) RT().restartClock(); }));
    set.appendChild(selField('Direction', Q().DIRECTIONS.map((d) => [d, d]), c.pat.direction, (v) => { c.pat.direction = v; }));
    set.appendChild(numField('Start', c.pat.start, 0, 15, (v) => { c.pat.start = v; render(host); }));
    set.appendChild(numField('End', c.pat.end, 0, 15, (v) => { c.pat.end = v; render(host); }));
    set.appendChild(el('button', { className: 'btn' }, 'Clear pattern')).addEventListener('click', () => { pushUndo(c.m); Q().clearPattern(c.pat); render(host); });
    set.appendChild(el('button', { className: 'btn' }, 'Oct +')).addEventListener('click', () => { pushUndo(c.m); Q().transposePattern(c.pat, 12); render(host); });
    set.appendChild(el('button', { className: 'btn' }, 'Oct -')).addEventListener('click', () => { pushUndo(c.m); Q().transposePattern(c.pat, -12); render(host); });
    const qz = el('input', { type: 'checkbox', checked: c.m.sequencer.quantizeRecord !== false });
    qz.addEventListener('change', () => { c.m.sequencer.quantizeRecord = qz.checked; });
    set.appendChild(el('label', { className: 'seq-f' }, ['Quantize rec ', qz]));
    // Metronome (#14): on/off + sound
    c.m.sequencer.metronome = c.m.sequencer.metronome || { on: false, sound: 'Ping' };
    const met = c.m.sequencer.metronome;
    const mOn = el('input', { type: 'checkbox', checked: !!met.on });
    mOn.addEventListener('change', () => { met.on = mOn.checked; });
    set.appendChild(el('label', { className: 'seq-f' }, ['Metronome ', mOn]));
    set.appendChild(selField('Sound', [['Ping', 'Ping'], ['Tick', 'Tick'], ['Pop', 'Pop']], met.sound || 'Ping', (v) => { met.sound = v; }));
    wrap.appendChild(set);

    // 16-step grid (2 rows of 8)
    const grid = el('div', { className: 'seq-grid' });
    for (let i = 0; i < 16; i++) {
      const has = Q().stepHasNotes(c.pat, i);
      const inRange = i >= Math.min(c.pat.start, c.pat.end) && i <= Math.max(c.pat.start, c.pat.end);
      const cell = el('button', { className: 'seq-step' + (has ? ' on' : '') + (selStep === i ? ' sel' : '') + (inRange ? '' : ' oob'), dataset: { step: i } });
      cell.appendChild(el('span', { className: 'ss-n' }, String(i + 1)));
      cell.appendChild(el('span', { className: 'ss-note' }, has ? noteName(c.pat.steps[i].notes[0].note) + (c.pat.steps[i].notes.length > 1 ? '+' : '') : '·'));
      cell.addEventListener('click', (e) => {
        selStep = i;
        if (e.shiftKey || e.metaKey) { pushUndo(c.m); Q().toggleStepNote(c.pat, i, Q().DEFAULT_NOTE, 100, 6); }
        render(host);
      });
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    wrap.appendChild(el('p', { className: 'fineprint' }, 'Click a step to select it; Shift/⌘-click toggles a note. Edit the selected step below.'));

    // selected-step editor
    wrap.appendChild(stepEditor(c.pat, host));
    host.appendChild(wrap);
    paintHeads();
  }

  function stepEditor(pat, host) {
    const step = pat.steps[selStep];
    const box = el('div', { className: 'seq-editor panel' });
    box.appendChild(el('div', { className: 'insp-title' }, 'Step ' + (selStep + 1)));
    const first = step.notes[0];
    const addBtn = el('button', { className: 'btn' }, step.notes.length ? 'Remove note' : 'Add note');
    addBtn.addEventListener('click', () => { pushUndo(model()); Q().toggleStepNote(pat, selStep, first ? first.note : Q().DEFAULT_NOTE, 100, 6); render(host); });
    box.appendChild(addBtn);
    if (first) {
      box.appendChild(numField('Note', first.note, 0, 127, (v) => { first.note = v; render(host); }));
      box.appendChild(numField('Velocity', first.velocity, 1, 127, (v) => { first.velocity = v; }));
      box.appendChild(numField('Gate (⅙)', first.gate, 1, 192, (v) => { first.gate = v; }));
    }
    box.appendChild(numField('Chance %', step.chance == null ? 100 : step.chance, 0, 100, (v) => { Q().setStepChance(pat, selStep, v); }));
    return box;
  }

  function paintHeads() {
    const head = RT() ? RT().playhead() : -1;
    document.querySelectorAll('.seq-step').forEach((cell) => cell.classList.toggle('head', +cell.dataset.step === head && RT() && RT().seqIsPlaying()));
  }

  // helpers
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  function numField(label, val, min, max, on) {
    const inp = el('input', { type: 'number', min, max, value: val });
    inp.addEventListener('change', () => on(Math.max(min, Math.min(max, parseInt(inp.value, 10) || 0))));
    return el('label', { className: 'seq-f' }, [label + ' ', inp]);
  }
  function selField(label, opts, val, on) {
    const sel = el('select', {});
    opts.forEach(([v, t]) => sel.appendChild(el('option', { value: String(v), selected: String(v) === String(val) }, t)));
    sel.addEventListener('change', () => on(sel.value));
    return el('label', { className: 'seq-f' }, [label + ' ', sel]);
  }
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (n) => NOTES[n % 12] + (Math.floor(n / 12) - 2);

  global.SLMK = global.SLMK || {};
  global.SLMK.sequencerUI = { render };
})(window);
