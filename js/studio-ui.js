/*
 * studio-ui.js — InControl Studio editor (P2).
 *
 * Layout (issue #30): a menu bar (File / Edit) top-left, Per-channel instrument
 * top-middle, Destination + engine + settings top-right; two top-level tabs
 * (Editor / Sequencer, issue #28). The Editor mirrors Novation Components: a row
 * of control glyphs (name above, current assignment below), a wide left column
 * with the full behaviour/assignment mappings, and a thin scrollable bank list
 * on the right (issue #30). Templates and setups are one and the same — importing
 * a template merges its parameters into the current setup (issue #27).
 */
(function (global) {
  'use strict';
  const S = global.SLMK.studio;
  const T = global.SLMK.sltemplate;

  let model = S.newModel();
  const ui = { view: 'editor', tab: 'rotary', knobBank: 0, buttonBank: 1, padMode: 'hits', sel: null, templateSort: 'recent', sessionSort: 'recent' };
  let pack = null, packSlot = -1, packSessionSlot = -1;
  let clipboard = null;               // Edit ▸ Copy/Cut/Paste: a cloned control assignment
  const undoStack = [], redoStack = [];

  const $ = (s) => document.querySelector(s);
  function pushLeds() { const RT = global.SLMK.studioRuntime; if (RT && RT.state && RT.state().running) RT.refreshSurface(); }
  const el = (t, p = {}, c = []) => {
    const n = document.createElement(t);
    const { dataset, ...rest } = p;
    Object.assign(n, rest);
    if (dataset) Object.entries(dataset).forEach(([k, v]) => (n.dataset[k] = v));
    (Array.isArray(c) ? c : [c]).forEach((x) => n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    return n;
  };

  // ---- undo / redo (whole-model snapshots) ----
  function snapshot() { undoStack.push(S.toJSON(model)); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; }
  function undo() { if (!undoStack.length) return; redoStack.push(S.toJSON(model)); model = S.fromJSON(undoStack.pop()); afterModelSwap(); setStatus('Undo.', 'ok'); }
  function redo() { if (!redoStack.length) return; undoStack.push(S.toJSON(model)); model = S.fromJSON(redoStack.pop()); afterModelSwap(); setStatus('Redo.', 'ok'); }
  // After a JSON round-trip (undo/redo/load) the active template's sections are
  // no longer the SAME objects as model.knobBanks/… — re-point them so editing
  // continues to write through to the template library (#32).
  function relinkTemplate() { S.ensureTemplates(model); if (model.activeTemplate) S.selectTemplate(model, model.activeTemplate); }
  function afterModelSwap() { relinkTemplate(); ui.sel = null; clampBanks(); syncName(); render(); pushLeds(); }
  function clampBanks() {
    ui.knobBank = Math.min(ui.knobBank, model.knobBanks.length - 1);
    ui.buttonBank = Math.min(ui.buttonBank, model.buttonBanks.length - 1);
  }

  const TABS = [
    { key: 'rotary', label: 'Encoders', kind: 'knob' }, { key: 'faders', label: 'Faders', kind: 'fader' },
    { key: 'buttons', label: 'Buttons', kind: 'button' }, { key: 'pads', label: 'Pads', kind: 'pad' },
    { key: 'wheels', label: 'Wheels', kind: 'wheel' }, { key: 'pedals', label: 'Pedals', kind: 'pedal' },
    { key: 'keys', label: 'Aftertouch', kind: 'key' },
  ];
  const kindForTab = (t) => (TABS.find((x) => x.key === t) || {}).kind || 'knob';

  function currentControls() {
    switch (ui.tab) {
      case 'rotary': return model.knobBanks[ui.knobBank].map((a, i) => ({ ref: a, label: a.name || 'Knob ' + (i + 1) }));
      case 'faders': return model.faders.map((a, i) => ({ ref: a, label: a.name || 'Fader ' + (i + 1) }));
      case 'buttons': return model.buttonBanks[ui.buttonBank].map((a, i) => ({ ref: a, label: a.name || 'Button ' + (i + 1) }));
      case 'pads': return model.pads.hits.map((a, i) => ({ ref: a, label: a.name || 'Pad ' + (i + 1), index: i }));
      case 'wheels': return [{ ref: model.wheels.pitch, label: 'Pitch' }, { ref: model.wheels.mod, label: 'Mod' }];
      case 'pedals': return [{ ref: model.pedals.sustain, label: 'Sustain' }, { ref: model.pedals.footswitch, label: 'Footswitch' }, { ref: model.pedals.expression, label: 'Expression' }];
      case 'keys': return [{ ref: model.keys.aftertouch, label: 'Aftertouch' }];
    }
    return [];
  }

  // ---- control glyphs (little Components-style icons) ----
  function glyph(kind) {
    const wrap = el('span', { className: 'glyph glyph-' + kind });
    wrap.innerHTML = GLYPHS[kind] || GLYPHS.knob;
    return wrap;
  }
  const GLYPHS = {
    knob: '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="2.4"/><line x1="20" y1="20" x2="20" y2="8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    fader: '<svg viewBox="0 0 40 40"><line x1="20" y1="6" x2="20" y2="34" stroke="currentColor" stroke-width="2.2"/><rect x="12" y="14" width="16" height="8" rx="2" fill="currentColor"/></svg>',
    button: '<svg viewBox="0 0 40 40"><rect x="9" y="12" width="22" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
    pad: '<svg viewBox="0 0 40 40"><rect x="9" y="9" width="22" height="22" rx="4" fill="currentColor" opacity="0.85"/></svg>',
    wheel: '<svg viewBox="0 0 40 40"><rect x="14" y="6" width="12" height="28" rx="6" fill="none" stroke="currentColor" stroke-width="2.4"/><line x1="14" y1="20" x2="26" y2="20" stroke="currentColor" stroke-width="2.2"/></svg>',
    pedal: '<svg viewBox="0 0 40 40"><rect x="10" y="16" width="20" height="12" rx="6" fill="none" stroke="currentColor" stroke-width="2.4"/><line x1="20" y1="10" x2="20" y2="16" stroke="currentColor" stroke-width="2.4"/></svg>',
    key: '<svg viewBox="0 0 40 40"><rect x="10" y="8" width="7" height="24" rx="1.5" fill="currentColor" opacity="0.85"/><rect x="19" y="8" width="7" height="24" rx="1.5" fill="currentColor" opacity="0.55"/><rect x="28" y="8" width="4" height="16" rx="1.5" fill="currentColor"/></svg>',
  };

  // ---- render ----
  function render() {
    // top-level tab state
    document.querySelectorAll('.mtab').forEach((b) => b.classList.toggle('active', b.dataset.view === ui.view));
    const evw = $('#view-editor'), svw = $('#view-sequencer');
    if (evw) evw.classList.toggle('active', ui.view === 'editor');
    if (svw) svw.classList.toggle('active', ui.view === 'sequencer');

    if ($('#chan-status')) refreshChanStatus();

    renderLibrary(); // the Templates / Sessions column beside the tabs (#77)
    if (ui.view === 'sequencer') { const host = $('#sequencer-body'); if (host && global.SLMK.sequencerUI) global.SLMK.sequencerUI.render(host); return; }
    renderEditor();
  }

  // #77: the left library column lives beside the tabs and shows Templates in the
  // Editor view, Sessions in the Sequencer view.
  function renderLibrary() {
    const col = $('#library-col'); if (!col) return;
    col.innerHTML = '';
    if (ui.view === 'sequencer') {
      if (global.SLMK.sequencerUI && global.SLMK.sequencerUI.libraryColumn) col.appendChild(global.SLMK.sequencerUI.libraryColumn());
    } else {
      S.ensureTemplates(model);
      col.appendChild(templateColumn());
    }
  }

  function renderEditor() {
    // sub-tab bar
    const bar = $('#editor-subtabs'); if (bar) {
      bar.innerHTML = '';
      TABS.forEach((t) => { const b = el('button', { className: 'stab' + (ui.tab === t.key ? ' active' : '') }, t.label); b.addEventListener('click', () => { ui.tab = t.key; ui.sel = null; render(); }); bar.appendChild(b); });
    }
    const host = $('#editor-body'); if (!host) return;
    host.innerHTML = '';
    S.ensureTemplates(model);

    const controls = currentControls();
    if (ui.sel == null && controls.length) ui.sel = 0;
    const kind = kindForTab(ui.tab);

    // Components-style layout: glyph row on top, then wide inspector (left) + bank list (right)
    const layout = el('div', { className: 'comp-layout' });

    const glyphRow = el('div', { className: 'glyph-row', dataset: { count: String(controls.length) } });
    controls.forEach((c, i) => {
      const on = c.ref.led && c.ref.led.idle && c.ref.led.idle !== '#000000';
      const cell = el('button', { className: 'glyph-cell' + (ui.sel === i ? ' selected' : '') + (c.ref.enabled ? ' enabled' : ' off') });
      if (on) cell.style.setProperty('--c', c.ref.led.idle);
      cell.appendChild(el('span', { className: 'gc-name' }, c.label));         // name above the glyph
      cell.appendChild(glyph(kind));                                            // the control glyph
      cell.appendChild(el('span', { className: 'gc-sub' }, summary(c.ref)));    // current assignment below
      cell.addEventListener('click', () => { ui.sel = i; render(); });
      glyphRow.appendChild(cell);
    });
    layout.appendChild(glyphRow);

    const banks = bankList();                                                   // thin scrollable bank list (right) — null when the control has no banks (#78)
    const cols = el('div', { className: 'comp-cols' + (banks ? '' : ' no-banks') });
    cols.appendChild(inspector(controls[ui.sel] || null)); // wide left column (grouped sections, #80)
    if (banks) cols.appendChild(banks);
    layout.appendChild(cols);
    host.appendChild(layout);
  }

  // Left column (#32): the template library. New Template + sorting at the top,
  // then the list of templates — click to edit, dots 1-8 map it to a Part.
  const PART_COLORS = ['#ff2d2d', '#ff8c00', '#ffd000', '#38d430', '#00c8c8', '#2b7bff', '#8a4bff', '#ff3bce'];
  function templateColumn() {
    const aside = el('aside', { className: 'lib-col panel' });
    const head = el('div', { className: 'lib-head' });
    head.appendChild(el('div', { className: 'lib-title' }, 'Templates'));
    const nu = el('button', { className: 'btn primary lib-new' }, '+ New'); nu.addEventListener('click', () => { snapshot(); S.addTemplate(model); ui.sel = null; syncName(); render(); pushLeds(); }); head.appendChild(nu);
    aside.appendChild(head);
    // sorting
    const sortSel = el('select', { className: 'lib-sort' });
    [['recent', 'Sort: Recent'], ['name', 'Sort: Name']].forEach(([v, t]) => sortSel.appendChild(el('option', { value: v, selected: v === ui.templateSort }, t)));
    sortSel.addEventListener('change', () => { ui.templateSort = sortSel.value; render(); });
    aside.appendChild(sortSel);

    model.partTemplates = model.partTemplates || new Array(8).fill(null);
    const list = el('div', { className: 'lib-scroll' });
    templatesSorted().forEach((t) => {
      const row = el('div', { className: 'lib-item' + (t.id === model.activeTemplate ? ' active' : '') });
      const nm = el('button', { className: 'lib-name', title: 'Edit this template' }, t.name);
      nm.addEventListener('click', () => { snapshot(); S.selectTemplate(model, t.id); ui.knobBank = 0; ui.buttonBank = 1; ui.sel = null; syncName(); render(); pushLeds(); });
      row.appendChild(nm);
      const tools = el('div', { className: 'lib-tools' });
      const ren = el('button', { className: 'lib-mini', title: 'Rename' }, '✎'); ren.addEventListener('click', () => { const n = prompt('Template name', t.name); if (n) { snapshot(); S.renameTemplate(model, t.id, n.slice(0, 24)); syncName(); render(); } });
      const del = el('button', { className: 'lib-mini', title: 'Delete' }, '🗑'); del.addEventListener('click', () => { if (model.templates.length > 1) { snapshot(); S.removeTemplate(model, t.id); ui.sel = null; syncName(); render(); pushLeds(); } });
      tools.append(ren, del); row.appendChild(tools);
      // part-map dots 1-8
      const dots = el('div', { className: 'lib-parts' });
      for (let p = 0; p < 8; p++) {
        const mapped = model.partTemplates[p] === t.id;
        const d = el('button', { className: 'lib-dot' + (mapped ? ' on' : ''), title: 'Map to Part ' + (p + 1) }, String(p + 1));
        d.style.setProperty('--pc', PART_COLORS[p]);
        d.addEventListener('click', () => { snapshot(); if (mapped) S.unmapPart(model, p); else S.mapTemplateToPart(model, t.id, p); render(); pushLeds(); });
        dots.appendChild(d);
      }
      row.appendChild(dots);
      list.appendChild(row);
    });
    aside.appendChild(list);
    aside.appendChild(el('p', { className: 'fineprint lib-hint' }, 'Click a template to edit it; numbers 1-8 map it to a Part.'));
    return aside;
  }
  function templatesSorted() {
    const arr = (model.templates || []).slice();
    if (ui.templateSort === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else arr.sort((a, b) => (b.order || 0) - (a.order || 0));
    return arr;
  }

  // Thin scrollable list of banks / modes for the current tab (replaces the old
  // dropdown-with-arrows). Rotary & Buttons have multiple banks (+ Add); Pads
  // switch Hit/Pressure; single-set tabs just show one entry.
  // Only Encoders and Buttons have real banks. Pads show Hit + Pressure in one
  // inspector (#80), so they don't need a banks column either (#78).
  const hasBanks = (tab) => tab === 'rotary' || tab === 'buttons';
  function bankList() {
    if (!hasBanks(ui.tab)) return null;
    const aside = el('aside', { className: 'bank-list panel' });
    aside.appendChild(el('div', { className: 'bl-title' }, 'Banks'));
    const list = el('div', { className: 'bl-scroll' });
    const item = (label, active, on) => { const b = el('button', { className: 'bl-item' + (active ? ' active' : '') }, label); b.addEventListener('click', on); return b; };

    if (ui.tab === 'rotary') {
      model.knobBanks.forEach((_, i) => list.appendChild(item('Knob bank ' + (i + 1), i === ui.knobBank, () => { ui.knobBank = i; ui.sel = null; render(); })));
      const add = el('button', { className: 'bl-add' }, '+ Add bank'); add.addEventListener('click', () => { snapshot(); ui.knobBank = S.addKnobBank(model); ui.sel = null; render(); }); aside.append(list, add); return aside;
    }
    if (ui.tab === 'buttons') {
      model.buttonBanks.forEach((_, i) => list.appendChild(item(i === 0 ? 'Mute / Solo (fixed)' : 'Bank ' + i, i === ui.buttonBank, () => { ui.buttonBank = i; ui.sel = null; render(); })));
      const add = el('button', { className: 'bl-add' }, '+ Add bank'); add.addEventListener('click', () => { snapshot(); ui.buttonBank = S.addButtonBank(model); ui.sel = null; render(); }); aside.append(list, add); return aside;
    }
    if (ui.tab === 'pads') {
      list.appendChild(item('Pad Hit', ui.padMode === 'hits', () => { ui.padMode = 'hits'; ui.sel = null; render(); }));
      list.appendChild(item('Pad Pressure', ui.padMode === 'pressures', () => { ui.padMode = 'pressures'; ui.sel = null; render(); }));
      aside.appendChild(list); return aside;
    }
    list.appendChild(item('All ' + (TABS.find((t) => t.key === ui.tab) || {}).label, true, () => {}));
    aside.appendChild(list); return aside;
  }

  function summary(a) {
    if (!a.enabled) return 'off';
    const mt = a.message_type;
    const nf = numberField(mt);
    if (nf) return mt + ' ' + (nf.key === 'note' ? a.note : a.cc);
    return mt;
  }

  function numberField(mt) {
    if (mt === 'CC' || mt === 'NRPN' || mt === 'Bank Change' || mt === 'Sub Bank Change') return { key: 'cc', label: mt === 'CC' ? 'CC #' : mt === 'NRPN' ? 'NRPN #' : 'Bank #' };
    if (mt === 'Note' || mt === 'Poly Aftertouch') return { key: 'note', label: 'Note #' };
    return null;
  }
  const isSwitch = (cls) => cls === 'button' || cls === 'footswitch' || cls === 'pad_hit';
  const hasPressureLed = (cls) => cls === 'pad_hit' || cls === 'pad_pressure' || cls === 'keys';

  const BIT_DEPTH_CLASSES = { knob: true, fader: true, button: true, footswitch: true, pad_pressure: true, sustain: true, pitch: true, mod: true, expression: false, keys: false, pad_hit: false };

  // Wide left column: the selected control's mappings, grouped into Name/Enabled,
  // Behaviour and Assignment section boxes with three-column rows (#80).
  function inspector(ctrl) {
    const panel = el('aside', { className: 'comp-insp panel' });
    if (!ctrl) { panel.appendChild(el('p', { className: 'hint' }, 'Select a control above to edit it.')); return panel; }
    const a = ctrl.ref;

    // ---- bound field builders (each setter snapshots for undo + pushes LEDs, #25) ----
    const num = (o, k, min, max) => { const n = el('input', { type: 'number', min, max, value: o[k] }); n.addEventListener('change', () => { snapshot(); o[k] = Math.max(min, Math.min(max, parseInt(n.value, 10) || 0)); render(); pushLeds(); }); return n; };
    const txt = (o, k, ml, also) => { const n = el('input', { type: 'text', value: o[k], maxLength: ml }); n.addEventListener('change', () => { snapshot(); o[k] = n.value; if (also) also.forEach((x) => (x[k] = n.value)); render(); pushLeds(); }); return n; };
    const chk = (o, k) => { const n = el('input', { type: 'checkbox', checked: !!o[k] }); n.addEventListener('change', () => { snapshot(); o[k] = n.checked; render(); pushLeds(); }); return n; };
    const sel = (o, k, opts) => { const n = el('select', {}); opts.forEach((v) => n.appendChild(el('option', { value: v, selected: v === o[k] }, v))); n.addEventListener('change', () => { snapshot(); o[k] = n.value; render(); pushLeds(); }); return n; };
    const chanSel = (o) => { const opts = ['default'].concat(Array.from({ length: 16 }, (_, i) => String(i + 1))); const n = el('select', {}); opts.forEach((v) => n.appendChild(el('option', { value: v, selected: String(o.channel) === v }, v === 'default' ? 'Default' : 'Ch ' + v))); n.addEventListener('change', () => { snapshot(); o.channel = n.value === 'default' ? 'default' : +n.value; }); return n; };

    // ---- layout primitives ----
    const cell = (label, node) => el('div', { className: 'insp-cell' }, node ? [el('label', {}, label), node] : []);
    const empty = () => el('div', { className: 'insp-cell' });
    const row = (...cells) => el('div', { className: 'insp-row' }, cells);
    const sec = (title, rows, enableObj) => {
      const s = el('div', { className: 'insp-sec' });
      if (title || enableObj) {
        const h = el('div', { className: 'insp-sechead' });
        h.appendChild(el('h4', {}, title || ''));
        if (enableObj) { const lab = el('label', { className: 'insp-enable' }); lab.append(chk(enableObj, 'enabled'), document.createTextNode('Enabled')); h.appendChild(lab); }
        s.appendChild(h);
      }
      rows.filter(Boolean).forEach((r) => s.appendChild(r));
      return s;
    };
    const msgCell = (o) => cell('Message', sel(o, 'message_type', S.MSG[o.cls]));
    const numCell = (o) => { const nf = numberField(o.message_type); return nf ? cell(nf.label, num(o, nf.key, 0, 127)) : empty(); };
    const bitRow = (o) => row(empty(), empty(), cell('Bit depth', sel(o, 'bit_depth', S.BIT_DEPTHS)));

    // Assignment rows: message/number/channel, then a value/range row, then bit depth.
    function valueRow(o) {
      if (isSwitch(o.cls)) {
        if (o.behavior === 'Toggle') return row(cell('On value', num(o, 'down_value', 0, 127)), cell('Off value', num(o, 'up_value', 0, 127)), empty());
        if (o.behavior === 'Inc/Dec') return row(cell('From value', num(o, 'start', 0, 127)), cell('To value', num(o, 'end', 0, 127)), empty());
        if (o.behavior === 'Trigger') return row(cell('Trigger value', num(o, 'down_value', 0, 127)), empty(), empty());
        return row(cell('Down value', num(o, 'down_value', 0, 127)), cell('Up value', num(o, 'up_value', 0, 127)), empty()); // Momentary
      }
      const third = o.cls === 'knob' ? cell('Pivot', num(o, 'pivot', 0, 127)) : empty();
      return row(cell('Start', num(o, 'start', 0, 16383)), cell('End', num(o, 'end', 0, 16383)), third);
    }
    function assignment(o, title, enableObj) {
      const rows = [row(msgCell(o), numCell(o), cell('Channel', chanSel(o))), valueRow(o)];
      if (BIT_DEPTH_CLASSES[o.cls]) rows.push(bitRow(o));
      if (o.cls === 'pad_hit') rows.push(row(cell('Vel min', num(o, 'vel_min', 0, 127)), cell('Vel max', num(o, 'vel_max', 0, 127)), cell('Vel curve', sel(o, 'vel_curve', S.VEL_CURVES))));
      return sec(title || 'Assignment', rows, enableObj);
    }
    function behaviourSection(o) {
      if (o.cls === 'knob') {
        return sec('Behaviour', [
          row(cell('Resolution', num(o, 'resolution', 0, 16383)), cell('Mode', sel(o, 'mode', S.KNOB_MODES)), cell('Step', num(o, 'step', 0, 127))),
          row(cell('Bank paging', sel(o, 'combined', S.COMBINED)), empty(), empty()),
        ]);
      }
      // switch behaviour: dropdown | action (push/release) | step (inc/dec) + wrap/pair
      const rows = [row(
        cell('Behaviour', sel(o, 'behavior', S.BEHAVIORS)),
        o.behavior === 'Momentary' ? empty() : cell('Action', sel(o, 'action', ['On Push', 'On Release'])),
        o.behavior === 'Inc/Dec' ? cell('Step', num(o, 'step_size', 1, 127)) : empty(),
      )];
      if (o.behavior === 'Inc/Dec') { const wp = row(cellChk('Wrap', chk(o, 'wrap')), cellChk('Pair', chk(o, 'pair')), empty()); rows.push(wp); }
      return sec('Behaviour', rows);
    }
    const cellChk = (label, node) => { const c = el('div', { className: 'insp-cell insp-cell-chk' }); const lab = el('label', {}); lab.append(node, document.createTextNode(' ' + label)); c.appendChild(lab); return c; };

    // ---- title ----
    panel.appendChild(el('div', { className: 'insp-title' }, (a.name || a.cls) + (a.fixed ? '  (fixed)' : '')));

    // ---- fixed Mute/Solo: colour only ----
    if (a.colorOnly) {
      panel.appendChild(el('p', { className: 'fineprint' }, (a.role === 'solo' ? 'Solo' : 'Mute') + ' — channel ' + a.channel + '. Sends no MIDI; only its colour is editable.'));
      const c = el('input', { type: 'color', value: a.led.idle });
      c.addEventListener('input', () => { a.led.idle = c.value; a.led.pressed = SLMK.studioOptions.lighten(c.value, 0.5); render(); pushLeds(); });
      const box = el('div', { className: 'insp-sec' }); box.appendChild(cell('Colour', c)); panel.appendChild(box);
      return panel;
    }

    if (ctrl.index != null && a.cls === 'pad_hit') {
      // Pads (#80): one shared Name, then the Hit and Pressure assignments, each
      // independently enable-able. Hit and Pressure share the name.
      const pressure = model.pads.pressures[ctrl.index];
      panel.appendChild(sec('', [row(cell('Name', txt(a, 'name', 9, [pressure])), empty(), empty())]));
      panel.appendChild(behaviourSection(a));
      panel.appendChild(assignment(a, 'Assignment (Hit)', a));
      panel.appendChild(assignment(pressure, 'Assignment (Pressure)', pressure));
      panel.appendChild(ledSection(a));
      return panel;
    }

    // ---- Name / Enabled ----
    panel.appendChild(sec('', [row(cell('Name', txt(a, 'name', 9)), cell('Enabled', chk(a, 'enabled')), empty())]));
    // ---- Behaviour (encoders + switches) ----
    if (a.cls === 'knob' || isSwitch(a.cls)) panel.appendChild(behaviourSection(a));
    // ---- Assignment ----
    panel.appendChild(assignment(a));
    // ---- LED colour ----
    panel.appendChild(ledSection(a));
    return panel;

    // LED colour section (kept from the previous inspector, in a section box).
    function ledSection(o) {
      const ledWrap = el('div', { className: 'insp-sec insp-color' });
      const field = (lbl, node) => { const f = el('div', { className: 'insp-cell' }, [el('label', {}, lbl), node]); return f; };
      if (o.colorMode === 'value') {
        ledWrap.appendChild(el('h4', {}, 'LED colour (brightness tracks value)'));
        const c = el('input', { type: 'color', value: o.led.idle });
        c.addEventListener('input', () => { o.led.idle = c.value; o.led.pressed = c.value; render(); pushLeds(); });
        ledWrap.appendChild(row(field('Colour', c)));
      } else if (o.cls === 'knob') {
        ledWrap.appendChild(el('h4', {}, 'Knob glyph colour'));
        const c = el('input', { type: 'color', value: o.led.idle });
        c.addEventListener('input', () => { o.led.idle = c.value; o.led.pressed = c.value; render(); pushLeds(); });
        ledWrap.appendChild(row(field('Colour', c)));
      } else {
        ledWrap.appendChild(el('h4', {}, 'LED colour'));
        const states = hasPressureLed(o.cls) ? ['idle', 'pressed', 'pressure'] : ['idle', 'pressed'];
        const cells = states.map((s) => { const c = el('input', { type: 'color', value: o.led[s] === '#000000' ? '#000000' : o.led[s] }); c.addEventListener('input', () => { o.led[s] = c.value; render(); pushLeds(); }); return field(s[0].toUpperCase() + s.slice(1), c); });
        ledWrap.appendChild(row.apply(null, cells));
      }
      return ledWrap;
    }
  }

  // ---- Edit menu: copy / cut / paste the selected control ----
  function selectedRef() { const cs = currentControls(); return cs[ui.sel] ? cs[ui.sel].ref : null; }
  function doCopy() { const a = selectedRef(); if (!a) return; clipboard = JSON.parse(JSON.stringify(a)); setStatus('Copied ' + (a.name || a.cls) + '.', 'ok'); }
  function doCut() { const a = selectedRef(); if (!a || a.fixed) return; doCopy(); snapshot(); const fresh = S.make(a.cls); Object.keys(a).forEach((k) => delete a[k]); Object.assign(a, fresh); render(); pushLeds(); setStatus('Cut.', 'ok'); }
  function doPaste() {
    const a = selectedRef(); if (!a || !clipboard || a.fixed) return;
    snapshot();
    const keep = a.cls; const src = JSON.parse(JSON.stringify(clipboard));
    delete src.cls; delete src.fixed; delete src.colorOnly; delete src.role;
    Object.assign(a, src); a.cls = keep;
    render(); pushLeds(); setStatus('Pasted onto ' + (a.name || a.cls) + '.', 'ok');
  }

  // ---- file actions ----
  function setStatus(m, cls) { const s = $('#studio-status'); if (s) { s.textContent = m; s.className = 'status ' + (cls || ''); } }
  // #27: importing a template MERGES its parameters into the current setup
  // (templates and setups are one and the same) — the sequencer, per-channel
  // assignments and extra banks are preserved.
  function importTemplate(file) {
    const r = new FileReader();
    r.onload = () => { try { snapshot(); const tpl = T.parse(Array.from(new Uint8Array(r.result))); const t = S.addTemplate(model, { from: S.fromTemplate(tpl), name: tpl.name || 'Imported' }); clampBanks(); ui.sel = null; syncName(); render(); pushLeds(); setStatus('Imported template "' + t.name + '" into the library ✓', 'ok'); } catch (e) { setStatus(e.message, 'warn'); } };
    r.readAsArrayBuffer(file);
  }
  function loadJson(file) {
    const r = new FileReader();
    r.onload = () => { try { snapshot(); model = S.fromJSON(r.result); relinkTemplate(); ui.knobBank = 0; ui.buttonBank = Math.min(1, model.buttonBanks.length - 1); ui.sel = null; syncName(); render(); pushLeds(); setStatus('Loaded setup ✓', 'ok'); } catch (e) { setStatus(e.message, 'warn'); } };
    r.readAsText(file);
  }
  function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type: type || 'application/json' })); const a = el('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function syncName() { const n = $('#studio-name'); if (n) n.value = model.name; }
  function saveJson() { model.name = ($('#studio-name') && $('#studio-name').value) || model.name || 'Studio Setup'; S.ensureSequencer(model); download((model.name).replace(/[^\w -]/g, '') + '.json', S.toJSON(model)); setStatus('Saved setup + sequencer JSON.', 'ok'); }
  function exportSyx() {
    model.name = ($('#studio-name') && $('#studio-name').value) || model.name || 'Template';
    const bytes = T.exportSysex(S.toTemplate(model));
    download((model.name).replace(/[^\w -]/g, '') + '.syx', new Uint8Array(bytes).buffer, 'application/octet-stream');
    setStatus('Exported Components .syx template.', 'ok');
  }
  function newSetup() { snapshot(); model = S.newModel(); ui.knobBank = 0; ui.buttonBank = 1; ui.sel = null; syncName(); render(); pushLeds(); setStatus('New setup.', 'ok'); }

  function init() {
    if (!$('#view-editor')) return;
    syncName();
    render();
    initMenus();
    initMainTabs();
    // hidden file inputs live in the File menu
    if ($('#studio-import')) $('#studio-import').addEventListener('change', (e) => { if (e.target.files[0]) importTemplate(e.target.files[0]); e.target.value = ''; closeMenus(); });
    if ($('#studio-load')) $('#studio-load').addEventListener('change', (e) => { if (e.target.files[0]) loadJson(e.target.files[0]); e.target.value = ''; closeMenus(); });
    const name = $('#studio-name'); if (name) name.addEventListener('change', () => { model.name = name.value; });
    if ($('#studio-pack-in')) $('#studio-pack-in').addEventListener('change', (e) => { if (e.target.files[0]) importPack(e.target.files[0]); e.target.value = ''; closeMenus(); });
    if ($('#studio-sessions-in')) $('#studio-sessions-in').addEventListener('change', (e) => { if (e.target.files[0]) importSessions(e.target.files[0]); e.target.value = ''; closeMenus(); });
    if ($('#pack-load')) $('#pack-load').addEventListener('click', loadPackTemplate);
    if ($('#pack-load-session')) $('#pack-load-session').addEventListener('click', loadPackSession);
    if ($('#pack-export')) $('#pack-export').addEventListener('click', exportPack);
    if ($('#pack-export-sessions')) $('#pack-export-sessions').addEventListener('click', exportSessions);
    initChannelBar();
    global.SLMK.studioState = { getModel: () => model };
  }

  // ---- menu bar (File / Edit dropdowns) ----
  const FILE_ACTS = { new: newSetup, save: saveJson, export: exportSyx };
  const EDIT_ACTS = { undo, redo, copy: doCopy, cut: doCut, paste: doPaste };
  function closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
  function initMenus() {
    document.querySelectorAll('.menu').forEach((menu) => {
      const btn = menu.querySelector('.menu-btn');
      if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); const wasOpen = menu.classList.contains('open'); closeMenus(); if (!wasOpen) menu.classList.add('open'); });
      menu.querySelectorAll('[data-act]').forEach((it) => it.addEventListener('click', () => { const fn = FILE_ACTS[it.dataset.act] || EDIT_ACTS[it.dataset.act]; if (fn) fn(); closeMenus(); }));
    });
    document.addEventListener('click', closeMenus);
    // keyboard shortcuts for Edit actions
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'c' && !isTyping(e)) { doCopy(); }
      else if (k === 'x' && !isTyping(e)) { doCut(); }
      else if (k === 'v' && !isTyping(e)) { doPaste(); }
    });
  }
  const isTyping = (e) => /input|textarea|select/i.test((e.target && e.target.tagName) || '');
  function initMainTabs() {
    document.querySelectorAll('.mtab').forEach((b) => b.addEventListener('click', () => { ui.view = b.dataset.view; render(); }));
  }

  // ---- per-channel instrument templates ----
  function initChannelBar() {
    const sel = $('#chan-sel'); if (!sel) return;
    for (let i = 1; i <= 8; i++) sel.appendChild(el('option', { value: i }, 'Ch ' + i));
    refreshChanStatus();
    $('#chan-assign').addEventListener('click', () => {
      const ch = +sel.value; snapshot();
      model.channelTemplates = model.channelTemplates || new Array(8).fill(null);
      model.channelTemplates[ch - 1] = JSON.parse(JSON.stringify({
        name: model.name, knobBanks: model.knobBanks, faders: model.faders, pads: model.pads, buttonBanks: model.buttonBanks,
      }));
      refreshChanStatus(); setStatus('Assigned current setup to channel ' + ch + '.', 'ok');
    });
    $('#chan-clear').addEventListener('click', () => {
      const ch = +sel.value; snapshot();
      if (model.channelTemplates) model.channelTemplates[ch - 1] = null;
      refreshChanStatus(); setStatus('Cleared channel ' + ch + '.', 'ok');
    });
    sel.addEventListener('change', refreshChanStatus);
  }
  function refreshChanStatus() {
    const s = $('#chan-status'); if (!s) return;
    const ct = model.channelTemplates || [];
    const assigned = ct.map((t, i) => (t ? i + 1 : null)).filter((x) => x);
    s.textContent = assigned.length ? 'Assigned: ' + assigned.join(', ') : 'all channels use this setup';
  }

  // ---- Components packs (.slmkiiipack) ----
  function showPackBar() {
    const sel = $('#pack-templates'); sel.innerHTML = '';
    (pack.templates || []).forEach((t, i) => sel.appendChild(el('option', { value: i }, (i + 1) + '. ' + (t.name || 'Template'))));
    $('#pack-name').textContent = (pack.name || 'Pack') + ' (' + (pack.product || 'sl-mkiii') + ')';
    $('#pack-load').style.display = (pack.templates || []).length ? '' : 'none';
    const ssel = $('#pack-sessions-sel');
    if (ssel) {
      ssel.innerHTML = '';
      (pack.sessions || []).forEach((s, i) => {
        const notes = s.bytes && global.SLMK.session.sequenceHasNotes(s.bytes);
        ssel.appendChild(el('option', { value: i }, (i + 1) + '. ' + (s.name || 'Session') + (notes ? ' ♪' : '')));
      });
      const has = (pack.sessions || []).length > 0;
      $('#pack-sessions-lbl').style.display = has ? '' : 'none';
      $('#pack-load-session').style.display = has ? '' : 'none';
    }
    $('#pack-sessions').textContent = (pack.sessions || []).length + ' sessions';
    $('#studio-pack-bar').style.display = '';
  }
  function importPack(file) {
    const r = new FileReader();
    r.onload = async () => {
      try {
        pack = await global.SLMK.pack.parsePack(new Uint8Array(r.result));
        packSlot = -1; packSessionSlot = -1; showPackBar();
        setStatus('Pack loaded — ' + pack.templates.length + ' templates, ' + pack.sessions.length + ' sessions.', 'ok');
      } catch (e) { setStatus(e.message, 'warn'); }
    };
    r.readAsArrayBuffer(file);
  }
  function importSessions(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const sessions = global.SLMK.session.decodeSyx(new Uint8Array(r.result));
        if (!pack) pack = { name: 'Sessions', product: 'sl-mkiii', version: '2.0', color: '', templates: [], sessions: [] };
        pack.sessions = sessions.map((s) => ({ name: s.name, bytes: s.body }));
        // Add each imported Components session to the library so it appears in the
        // Sequencer's Sessions column and can be played back (#33).
        S.ensureSessions(model);
        sessions.forEach((s) => { try { S.addImportedSession(model, s.name || 'Imported', s.body); } catch (e) {} });
        packSessionSlot = -1; showPackBar(); render();
        setStatus('Imported ' + sessions.length + ' Components sessions into the library.', 'ok');
      } catch (e) { setStatus(e.message, 'warn'); }
    };
    r.readAsArrayBuffer(file);
  }
  function writeBackSession() {
    if (packSessionSlot >= 0 && model.sequencer && pack.sessions[packSessionSlot]) {
      const base = pack.sessions[packSessionSlot].bytes;
      pack.sessions[packSessionSlot].bytes = global.SLMK.session.writeSequence(base, model.sequencer);
    }
  }
  function exportSessions() {
    if (!pack || !(pack.sessions || []).length) { setStatus('No sessions to export.', 'warn'); return; }
    writeBackSession();
    const bytes = global.SLMK.session.encodeSyx(pack.sessions.map((s, i) => ({ body: s.bytes, slot: i })));
    download((pack.name || 'sessions').replace(/[^\w -]/g, '') + '_sessions.syx', new Uint8Array(bytes).buffer, 'application/octet-stream');
    setStatus('Exported ' + pack.sessions.length + ' sessions as .syx.', 'ok');
  }
  function loadPackTemplate() {
    if (!pack) return;
    const i = +$('#pack-templates').value;
    const t = pack.templates[i]; if (!t) return;
    snapshot(); const tpl = T.parse(Array.from(t.bytes)); const added = S.addTemplate(model, { from: S.fromTemplate(tpl), name: tpl.name || t.name || 'Imported' });
    packSlot = i; clampBanks(); ui.sel = null; syncName(); render(); pushLeds();
    setStatus('Added "' + added.name + '" from pack to the template library.', 'ok');
  }
  function loadPackSession() {
    if (!pack) return;
    const i = +$('#pack-sessions-sel').value;
    const s = pack.sessions[i]; if (!s || !s.bytes) return;
    snapshot();
    S.ensureSequencer(model);
    model.sequencer = global.SLMK.session.readSequence(s.bytes);
    // #76: also bring the pack's templates into the library and map them onto the
    // Parts (template N -> Part N), so loading a session sets up each Part's
    // instrument too. Templates are de-duplicated by name across repeated loads.
    const mapped = loadPackTemplatesToParts();
    packSessionSlot = i;
    ui.view = 'sequencer'; render(); pushLeds();
    const notes = global.SLMK.session.sequenceHasNotes(s.bytes);
    setStatus('Loaded session "' + (s.name || 'Session') + '" into the sequencer' + (notes ? '' : ' (no notes)') + (mapped ? ' — mapped ' + mapped + ' Part templates.' : '.'), 'ok');
  }
  // Import each pack template (once) into the library and map it to a Part in
  // order (#76). Returns how many Parts were mapped.
  function loadPackTemplatesToParts() {
    if (!pack || !(pack.templates || []).length) return 0;
    S.ensureTemplates(model);
    let n = 0;
    pack.templates.slice(0, 8).forEach((pt, i) => {
      if (!pt.bytes) return;
      let tpl; try { tpl = T.parse(Array.from(pt.bytes)); } catch (e) { return; }
      const name = tpl.name || pt.name || ('Template ' + (i + 1));
      const existing = (model.templates || []).find((t) => t.name === name);
      const id = existing ? existing.id : S.addTemplate(model, { from: S.fromTemplate(tpl), name }).id;
      S.mapTemplateToPart(model, id, i);
      n++;
    });
    return n;
  }
  function exportPack() {
    if (!pack) return;
    if (packSlot >= 0) {
      const bytes = T.exportSysex(S.toTemplate(model));
      const body = bodyFromSyx(bytes);
      if (body) { pack.templates[packSlot].bytes = body; pack.templates[packSlot].name = model.name; }
    }
    writeBackSession();
    const out = global.SLMK.pack.buildPack(pack);
    download((pack.name || 'pack').replace(/[^\w -]/g, '') + '.slmkiiipack', out, 'application/zip');
    setStatus('Exported pack (' + pack.templates.length + ' templates, ' + pack.sessions.length + ' sessions).', 'ok');
  }
  function bodyFromSyx(bytes) {
    try { const tpl = T.parse(bytes); return new Uint8Array(T.toBody(tpl)); } catch (e) { return null; }
  }
  // Exposed so the Sequencer UI's session column (rendered into the shared library
  // sidebar, #77) can trigger a full re-render of the library + active view.
  global.SLMK = global.SLMK || {};
  global.SLMK.studioUI = { render };

  document.addEventListener('DOMContentLoaded', init);
})(window);
