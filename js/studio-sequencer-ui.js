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
      // Re-render live when the sequence content changes from the hardware — e.g.
      // steps recorded on the SL while it plays (#16) — as long as the Sequencer
      // tab is on screen. No stop/start needed to see recorded steps.
      RT().onChange(() => { const v = document.querySelector('#view-sequencer'); const h = document.querySelector('#sequencer-body'); if (v && v.classList.contains('active') && h) render(h); });
      hooked = true;
    }
    const prev = host.querySelector('.seq-wrap'); // replace our own content, keep the sub-tab bar
    if (prev) prev.remove();
    const c = ctx();
    const wrap = el('div', { className: 'seq-wrap' });
    // The session library now lives in the shared left sidebar beside the tabs
    // (#77); this view renders only the sequencer itself.
    const main = el('div', { className: 'seq-main' });
    wrap.appendChild(main);

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
    bar.appendChild(el('label', { className: 'seq-f' }, ['Part color ', col]));
    bar.appendChild(selField('Swing', [['On', 'On'], ['Off', 'Off']], c.track.swing || 'On', (v) => { c.track.swing = v; }));
    // Time signature (#83): limits how many steps of the grid are usable.
    bar.appendChild(selField('Signature', Q().SIG_ORDER.map((s) => [s, s]), c.m.sequencer.signature || '4/4', (v) => { c.m.sequencer.signature = v; if (RT()) RT().restartClock(); render(host); }));
    main.appendChild(bar);

    // pattern settings
    const set = el('div', { className: 'seq-bar' });
    set.appendChild(selField('Sync', Q().SYNC_ORDER.map((s) => [s, s]), c.pat.syncRate, (v) => { c.pat.syncRate = v; if (RT()) RT().restartClock(); }));
    set.appendChild(selField('Direction', Q().DIRECTIONS.map((d) => [d, d]), c.pat.direction, (v) => { c.pat.direction = v; }));
    const spbMax = Q().stepsPerBar(c.m.sequencer) - 1; // signature cap (#83)
    set.appendChild(numField('Start', c.pat.start, 0, spbMax, (v) => { c.pat.start = v; render(host); }));
    set.appendChild(numField('End', c.pat.end, 0, spbMax, (v) => { c.pat.end = v; render(host); }));
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
    // MIDI is never delayed. The click is scheduled EARLY on the audio clock by
    // the measured output latency; this extra Lead nudges it earlier/later to taste.
    const leadInp = el('input', { type: 'number', min: -100, max: 200, value: met.leadMs == null ? '' : met.leadMs, placeholder: '0' });
    leadInp.addEventListener('change', () => { const v = leadInp.value === '' ? null : Math.max(-100, Math.min(200, parseInt(leadInp.value, 10) || 0)); met.leadMs = v; if (RT() && RT().setMetroLead) RT().setMetroLead(v); });
    set.appendChild(el('label', { className: 'seq-f', title: 'Play the click this many ms earlier (+) or later (−). MIDI is never delayed.' }, ['Lead ms ', leadInp]));
    if (RT() && RT().setMetroLead && met.leadMs != null) RT().setMetroLead(met.leadMs);
    // Low-latency audio: latency mode + output device (an ASIO / low-latency
    // Windows device shows up here as an output; select it for the tightest click).
    set.appendChild(selField('Latency', [['interactive', 'Interactive (low)'], ['balanced', 'Balanced'], ['playback', 'Playback']], met.latencyHint || 'interactive', (v) => { met.latencyHint = v; if (RT() && RT().setAudioLatencyHint) RT().setAudioLatencyHint(v); }));
    const outSel = el('select', {}); outSel.appendChild(el('option', { value: '' }, 'System default'));
    outSel.addEventListener('change', () => { met.audioSink = outSel.value || null; if (RT() && RT().setAudioSink) RT().setAudioSink(outSel.value); });
    set.appendChild(el('label', { className: 'seq-f', title: 'Send the metronome click to a specific (e.g. ASIO / low-latency) audio output.' }, ['Audio out ', outSel]));
    if (RT() && RT().listAudioOutputs) RT().listAudioOutputs().then((outs) => {
      outs.forEach((o) => outSel.appendChild(el('option', { value: o.id, selected: o.id === met.audioSink }, o.name)));
    });
    if (RT() && met.latencyHint && RT().setAudioLatencyHint) RT().setAudioLatencyHint(met.latencyHint);
    if (RT() && met.audioSink && RT().setAudioSink) RT().setAudioSink(met.audioSink);
    main.appendChild(set);

    // 16-step grid (2 rows of 8)
    const grid = el('div', { className: 'seq-grid' });
    const spb = Q().stepsPerBar(c.m.sequencer); // steps the signature allows (#83)
    for (let i = 0; i < 16; i++) {
      const disabled = i >= spb; // steps beyond the time signature are unavailable
      const has = Q().stepHasNotes(c.pat, i);
      const inRange = !disabled && i >= Math.min(c.pat.start, c.pat.end) && i <= Math.max(c.pat.start, c.pat.end);
      const cell = el('button', { className: 'seq-step' + (has ? ' on' : '') + (selStep === i ? ' sel' : '') + (disabled ? ' disabled' : inRange ? '' : ' oob'), dataset: { step: i } });
      cell.appendChild(el('span', { className: 'ss-n' }, String(i + 1)));
      cell.appendChild(el('span', { className: 'ss-note' }, has ? noteName(c.pat.steps[i].notes[0].note) + (c.pat.steps[i].notes.length > 1 ? '+' : '') : '·'));
      if (!disabled) cell.addEventListener('click', (e) => {
        selStep = i;
        if (e.shiftKey || e.metaKey) { pushUndo(c.m); Q().toggleStepNote(c.pat, i, Q().DEFAULT_NOTE, 100, 6); }
        render(host);
      });
      grid.appendChild(cell);
    }
    main.appendChild(grid);
    main.appendChild(el('p', { className: 'fineprint' }, 'Click a step to select it; Shift/⌘-click toggles a note. Edit the selected step below.'));

    // selected-step editor
    main.appendChild(stepEditor(c.pat, host));
    host.appendChild(wrap);
    paintHeads();
  }

  // Left column (#33): the session library. A session holds the full sequencer
  // state + which template maps to each Part. New/snapshot at top, sorting, then
  // the list — click to load & play back. Imported Components sessions land here.
  let sessionSort = 'recent';
  // Re-render the whole app (library sidebar + active view) after a session action.
  const rerender = () => { if (global.SLMK.studioUI) global.SLMK.studioUI.render(); else { const h = document.querySelector('#sequencer-body'); if (h) render(h); } };
  function sessionColumn() {
    const m = model(); S().ensureSessions(m);
    const aside = el('aside', { className: 'lib-col panel' });
    const head = el('div', { className: 'lib-head' });
    head.appendChild(el('div', { className: 'lib-title' }, 'Sessions'));
    const nu = el('button', { className: 'btn primary lib-new', title: 'Save the current sequencer + Part mapping as a session' }, '+ Save');
    nu.addEventListener('click', () => { const s = S().snapshotSession(m); const n = prompt('Session name', s.name); if (n) S().renameSession(m, s.id, n.slice(0, 24)); rerender(); });
    head.appendChild(nu);
    aside.appendChild(head);
    const sortSel = el('select', { className: 'lib-sort' });
    [['recent', 'Sort: Recent'], ['name', 'Sort: Name']].forEach(([v, t]) => sortSel.appendChild(el('option', { value: v, selected: v === sessionSort }, t)));
    sortSel.addEventListener('change', () => { sessionSort = sortSel.value; rerender(); });
    aside.appendChild(sortSel);

    const list = el('div', { className: 'lib-scroll' });
    const sessions = (m.sessions || []).slice();
    if (sessionSort === 'name') sessions.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else sessions.sort((a, b) => (b.order || 0) - (a.order || 0));
    if (!sessions.length) list.appendChild(el('p', { className: 'fineprint' }, 'No sessions yet. Save one, or import a Components session from File ▸ Import sessions.'));
    sessions.forEach((s) => {
      const row = el('div', { className: 'lib-item' });
      const nm = el('button', { className: 'lib-name', title: 'Load & play this session' }, s.name + (s.imported ? ' ♪' : ''));
      nm.addEventListener('click', () => { S().loadSession(m, s.id); if (RT()) RT().refreshSurface(); selStep = 0; rerender(); });
      row.appendChild(nm);
      const tools = el('div', { className: 'lib-tools' });
      const ren = el('button', { className: 'lib-mini', title: 'Rename' }, '✎'); ren.addEventListener('click', () => { const n = prompt('Session name', s.name); if (n) { S().renameSession(m, s.id, n.slice(0, 24)); rerender(); } });
      const del = el('button', { className: 'lib-mini', title: 'Delete' }, '🗑'); del.addEventListener('click', () => { S().removeSession(m, s.id); rerender(); });
      tools.append(ren, del); row.appendChild(tools);
      // part->template mapping summary
      const parts = (s.partTemplates || []).map((tid, i) => tid ? (i + 1) : null).filter((x) => x);
      row.appendChild(el('div', { className: 'lib-sub fineprint' }, parts.length ? 'Parts: ' + parts.join(',') : 'no part map'));
      list.appendChild(row);
    });
    aside.appendChild(list);
    return aside;
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
  global.SLMK.sequencerUI = { render, libraryColumn: sessionColumn };
})(window);
