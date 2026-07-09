/*
 * studio-ui.js — InControl Studio editor (P2): the 7 Components-style tabs
 * (Rotary, Faders, Buttons, Pads, Wheels, Pedals, Keys) editing the studio
 * model. Unlimited knob/button banks with paging; per-state LED colours; import
 * from a Components .syx; save/load JSON. The live engine (P3) reads this model.
 */
(function (global) {
  'use strict';
  const S = global.SLMK.studio;
  const T = global.SLMK.sltemplate;

  let model = S.newModel();
  const ui = { tab: 'rotary', knobBank: 0, buttonBank: 1, padMode: 'hits', sel: null };
  let pack = null, packSlot = -1; // loaded pack + which template slot is in the editor

  const $ = (s) => document.querySelector(s);
  const el = (t, p = {}, c = []) => {
    const n = document.createElement(t);
    const { dataset, ...rest } = p;
    Object.assign(n, rest);
    if (dataset) Object.entries(dataset).forEach(([k, v]) => (n.dataset[k] = v));
    (Array.isArray(c) ? c : [c]).forEach((x) => n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    return n;
  };

  const TABS = [
    { key: 'rotary', label: 'Rotary' }, { key: 'faders', label: 'Faders' },
    { key: 'buttons', label: 'Buttons' }, { key: 'pads', label: 'Pads' },
    { key: 'wheels', label: 'Wheels' }, { key: 'pedals', label: 'Pedals' }, { key: 'keys', label: 'Keys' },
    { key: 'sequencer', label: 'Sequencer' },
  ];

  // Which controls does the current tab expose? Returns [{ref, label, sub}]
  function currentControls() {
    switch (ui.tab) {
      case 'rotary': return model.knobBanks[ui.knobBank].map((a, i) => ({ ref: a, label: a.name || 'Knob ' + (i + 1) }));
      case 'faders': return model.faders.map((a, i) => ({ ref: a, label: a.name || 'Fader ' + (i + 1) }));
      case 'buttons': return model.buttonBanks[ui.buttonBank].map((a, i) => ({ ref: a, label: a.name || 'Button ' + (i + 1) }));
      case 'pads': return model.pads[ui.padMode].map((a, i) => ({ ref: a, label: a.name || 'Pad ' + (i + 1) }));
      case 'wheels': return [{ ref: model.wheels.pitch, label: 'Pitch' }, { ref: model.wheels.mod, label: 'Mod' }];
      case 'pedals': return [{ ref: model.pedals.sustain, label: 'Sustain' }, { ref: model.pedals.footswitch, label: 'Footswitch' }, { ref: model.pedals.expression, label: 'Expression' }];
      case 'keys': return [{ ref: model.keys.aftertouch, label: 'Aftertouch' }];
    }
    return [];
  }

  function render() {
    const host = $('#studio-body');
    if (!host) return;
    host.innerHTML = '';
    // sub-tab bar
    const bar = el('div', { className: 'studio-tabs' });
    TABS.forEach((t) => { const b = el('button', { className: 'stab' + (ui.tab === t.key ? ' active' : '') }, t.label); b.addEventListener('click', () => { ui.tab = t.key; ui.sel = null; render(); }); bar.appendChild(b); });
    host.appendChild(bar);

    // Sequencer sub-tab is rendered by its own module.
    if (ui.tab === 'sequencer') { if (global.SLMK.sequencerUI) global.SLMK.sequencerUI.render(host); return; }

    // bank / mode controls
    const controlsBar = el('div', { className: 'studio-subbar' });
    if (ui.tab === 'rotary') controlsBar.appendChild(bankNav('Knob bank', model.knobBanks.length, ui.knobBank, (i) => { ui.knobBank = i; ui.sel = null; render(); }, () => { ui.knobBank = S.addKnobBank(model); render(); }));
    if (ui.tab === 'buttons') controlsBar.appendChild(bankNav('Button bank', model.buttonBanks.length, ui.buttonBank, (i) => { ui.buttonBank = i; ui.sel = null; render(); }, () => { ui.buttonBank = S.addButtonBank(model); render(); }, (i) => i === 0 ? 'Mute/Send (fixed)' : 'Bank ' + i));
    if (ui.tab === 'pads') {
      ['hits', 'pressures'].forEach((mode) => { const b = el('button', { className: 'btn' + (ui.padMode === mode ? ' primary' : '') }, mode === 'hits' ? 'Pad Hit' : 'Pad Pressure'); b.addEventListener('click', () => { ui.padMode = mode; ui.sel = null; render(); }); controlsBar.appendChild(b); });
    }
    if (controlsBar.children.length) host.appendChild(controlsBar);

    // split: control grid + inspector
    const split = el('div', { className: 'studio-split' });
    const grid = el('div', { className: 'studio-grid' });
    const controls = currentControls();
    controls.forEach((c, i) => {
      const on = c.ref.led && c.ref.led.idle && c.ref.led.idle !== '#000000';
      const cell = el('button', { className: 'studio-ctrl' + (ui.sel === i ? ' selected' : '') + (c.ref.enabled ? ' enabled' : '') });
      if (on) cell.style.setProperty('--c', c.ref.led.idle);
      cell.appendChild(el('span', { className: 'sc-name' }, c.label));
      cell.appendChild(el('span', { className: 'sc-sub' }, summary(c.ref)));
      cell.addEventListener('click', () => { ui.sel = i; render(); });
      grid.appendChild(cell);
    });
    split.appendChild(grid);
    split.appendChild(inspector(controls[ui.sel] ? controls[ui.sel].ref : null));
    host.appendChild(split);
  }

  function bankNav(label, count, cur, onSel, onAdd, namer) {
    const wrap = el('div', { className: 'bank-nav' });
    wrap.appendChild(el('span', { className: 'bank-label' }, label));
    const prev = el('button', { className: 'btn' }, '‹'); prev.addEventListener('click', () => onSel((cur - 1 + count) % count));
    const sel = el('select', {});
    for (let i = 0; i < count; i++) sel.appendChild(el('option', { value: i, selected: i === cur }, namer ? namer(i) : 'Bank ' + (i + 1)));
    sel.addEventListener('change', () => onSel(+sel.value));
    const next = el('button', { className: 'btn' }, '›'); next.addEventListener('click', () => onSel((cur + 1) % count));
    const add = el('button', { className: 'btn', title: 'Add bank' }, '+'); add.addEventListener('click', onAdd);
    wrap.append(prev, sel, next, add);
    return wrap;
  }

  function summary(a) {
    if (!a.enabled) return 'off';
    const mt = a.message_type;
    const nf = numberField(mt);
    if (nf) return mt + ' ' + (nf.key === 'note' ? a.note : a.cc);
    return mt;
  }

  // Which number field (if any) applies to a message type.
  function numberField(mt) {
    if (mt === 'CC' || mt === 'NRPN' || mt === 'Bank Change' || mt === 'Sub Bank Change') return { key: 'cc', label: mt === 'CC' ? 'CC #' : mt === 'NRPN' ? 'NRPN #' : 'Bank #' };
    if (mt === 'Note' || mt === 'Poly Aftertouch') return { key: 'note', label: 'Note #' };
    return null; // Program Change / Song Position / Pitch Bend / Channel Pressure / Seq
  }
  const isSwitch = (cls) => cls === 'button' || cls === 'footswitch' || cls === 'pad_hit';
  const hasPressureLed = (cls) => cls === 'pad_hit' || cls === 'pad_pressure' || cls === 'keys';

  function inspector(a) {
    const panel = el('aside', { className: 'studio-insp panel' });
    if (!a) { panel.appendChild(el('p', { className: 'hint' }, 'Select a control to edit it.')); return panel; }
    const rerender = () => render();
    const field = (lbl, node) => { const f = el('div', { className: 'field' }, [el('label', {}, lbl)]); f.appendChild(node); return f; };
    const num = (k, min, max) => { const n = el('input', { type: 'number', min, max, value: a[k] }); n.addEventListener('change', () => { a[k] = Math.max(min, Math.min(max, parseInt(n.value, 10) || 0)); render(); }); return n; };
    const txt = (k, ml) => { const n = el('input', { type: 'text', value: a[k], maxLength: ml }); n.addEventListener('change', () => { a[k] = n.value; render(); }); return n; };
    const chk = (k) => { const n = el('input', { type: 'checkbox', checked: a[k] }); n.addEventListener('change', () => { a[k] = n.checked; render(); }); return n; };
    const sel = (k, opts) => { const n = el('select', {}); opts.forEach((o) => n.appendChild(el('option', { value: o, selected: o === a[k] }, o))); n.addEventListener('change', () => { a[k] = n.value; render(); }); return n; };

    panel.appendChild(el('div', { className: 'insp-title' }, (a.name || a.cls) + (a.fixed ? '  (fixed)' : '')));
    panel.appendChild(field('Enabled', chk('enabled')));
    panel.appendChild(field('Name', txt('name', 9)));
    panel.appendChild(field('Message', sel('message_type', S.MSG[a.cls])));
    const chOpts = ['default'].concat(Array.from({ length: 16 }, (_, i) => String(i + 1)));
    const chSel = el('select', {}); chOpts.forEach((o) => chSel.appendChild(el('option', { value: o, selected: String(a.channel) === o }, o === 'default' ? 'Default' : 'Ch ' + o))); chSel.addEventListener('change', () => { a.channel = chSel.value === 'default' ? 'default' : +chSel.value; }); panel.appendChild(field('Channel', chSel));

    const nf = numberField(a.message_type);
    if (nf) panel.appendChild(field(nf.label, num(nf.key, 0, 127)));

    if (a.cls === 'knob') {
      panel.appendChild(field('Mode', sel('mode', S.KNOB_MODES)));
      panel.appendChild(field('Resolution', num('resolution', 0, 16383)));
      panel.appendChild(field('Step', num('step', 0, 127)));
      panel.appendChild(field('Pivot', num('pivot', 0, 127)));
      panel.appendChild(field('Bank paging', sel('combined', S.COMBINED)));
    }
    if (isSwitch(a.cls)) panel.appendChild(field('Behaviour', sel('behavior', S.BEHAVIORS)));

    if (isSwitch(a.cls)) {
      panel.appendChild(field('Down value', num('down_value', 0, 127)));
      panel.appendChild(field('Up value', num('up_value', 0, 127)));
    } else {
      panel.appendChild(field('Start', num('start', 0, 16383)));
      panel.appendChild(field('End', num('end', 0, 16383)));
      panel.appendChild(field('Bit depth', sel('bit_depth', S.BIT_DEPTHS)));
    }
    if (a.cls === 'pad_hit') {
      panel.appendChild(field('Vel min', num('vel_min', 0, 127)));
      panel.appendChild(field('Vel max', num('vel_max', 0, 127)));
      panel.appendChild(field('Vel curve', sel('vel_curve', S.VEL_CURVES)));
    }
    if (a.cls === 'pad_pressure' && a.message_type === 'Poly Aftertouch') panel.appendChild(field('Note #', num('note', 0, 127)));

    // LED colours per state
    const ledWrap = el('div', { className: 'insp-color' });
    ledWrap.appendChild(el('h4', {}, 'LED colour'));
    const states = hasPressureLed(a.cls) ? ['idle', 'pressed', 'pressure'] : ['idle', 'pressed'];
    states.forEach((st) => {
      const c = el('input', { type: 'color', value: a.led[st] === '#000000' ? '#000000' : a.led[st] });
      c.addEventListener('input', () => { a.led[st] = c.value; render(); });
      ledWrap.appendChild(field(st[0].toUpperCase() + st.slice(1), c));
    });
    panel.appendChild(ledWrap);
    return panel;
  }

  // ---- file actions ----
  function setStatus(m, cls) { const s = $('#studio-status'); if (s) { s.textContent = m; s.className = 'status ' + (cls || ''); } }
  function importTemplate(file) {
    const r = new FileReader();
    r.onload = () => { try { model = S.fromTemplate(T.parse(Array.from(new Uint8Array(r.result)))); ui.knobBank = 0; ui.buttonBank = 1; ui.sel = null; syncName(); render(); setStatus('Imported "' + model.name + '" ✓', 'ok'); } catch (e) { setStatus(e.message, 'warn'); } };
    r.readAsArrayBuffer(file);
  }
  function loadJson(file) {
    const r = new FileReader();
    r.onload = () => { try { model = S.fromJSON(r.result); ui.knobBank = 0; ui.buttonBank = Math.min(1, model.buttonBanks.length - 1); ui.sel = null; syncName(); render(); setStatus('Loaded setup ✓', 'ok'); } catch (e) { setStatus(e.message, 'warn'); } };
    r.readAsText(file);
  }
  function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type: type || 'application/json' })); const a = el('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function syncName() { const n = $('#studio-name'); if (n) n.value = model.name; }

  function init() {
    if (!$('#view-studio')) return;
    syncName();
    render();
    $('#studio-new').addEventListener('click', () => { model = S.newModel(); ui.knobBank = 0; ui.buttonBank = 1; ui.sel = null; syncName(); render(); setStatus('New setup.', 'ok'); });
    $('#studio-import').addEventListener('change', (e) => { if (e.target.files[0]) importTemplate(e.target.files[0]); e.target.value = ''; });
    $('#studio-load').addEventListener('change', (e) => { if (e.target.files[0]) loadJson(e.target.files[0]); e.target.value = ''; });
    $('#studio-save').addEventListener('click', () => { model.name = $('#studio-name').value || 'Studio Setup'; download((model.name).replace(/[^\w -]/g, '') + '.json', S.toJSON(model)); setStatus('Saved setup JSON.', 'ok'); });
    $('#studio-export-syx').addEventListener('click', () => {
      model.name = $('#studio-name').value || 'Template';
      const bytes = T.exportSysex(S.toTemplate(model));
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
      const a = el('a', { href: url, download: (model.name).replace(/[^\w -]/g, '') + '.syx' }); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Exported Components .syx template.', 'ok');
    });
    $('#studio-name').addEventListener('change', () => { model.name = $('#studio-name').value; });
    if ($('#studio-pack-in')) $('#studio-pack-in').addEventListener('change', (e) => { if (e.target.files[0]) importPack(e.target.files[0]); e.target.value = ''; });
    if ($('#pack-load')) $('#pack-load').addEventListener('click', loadPackTemplate);
    if ($('#pack-export')) $('#pack-export').addEventListener('click', exportPack);
    // expose for the future engine
    global.SLMK.studioState = { getModel: () => model };
  }

  // ---- Components packs (.slmkiiipack) ----
  function importPack(file) {
    const r = new FileReader();
    r.onload = async () => {
      try {
        pack = await global.SLMK.pack.parsePack(new Uint8Array(r.result));
        packSlot = -1;
        const sel = $('#pack-templates'); sel.innerHTML = '';
        pack.templates.forEach((t, i) => sel.appendChild(el('option', { value: i }, (i + 1) + '. ' + (t.name || 'Template'))));
        $('#pack-name').textContent = pack.name + ' (' + pack.product + ')';
        $('#pack-sessions').textContent = pack.sessions.length + ' sessions carried through';
        $('#studio-pack-bar').style.display = '';
        setStatus('Pack loaded — ' + pack.templates.length + ' templates, ' + pack.sessions.length + ' sessions.', 'ok');
      } catch (e) { setStatus(e.message, 'warn'); }
    };
    r.readAsArrayBuffer(file);
  }
  function loadPackTemplate() {
    if (!pack) return;
    const i = +$('#pack-templates').value;
    const t = pack.templates[i]; if (!t) return;
    model = S.fromTemplate(T.parse(Array.from(t.bytes)));
    packSlot = i; ui.knobBank = 0; ui.buttonBank = 1; ui.sel = null; syncName(); render();
    setStatus('Loaded "' + (t.name || model.name) + '" from pack.', 'ok');
  }
  function exportPack() {
    if (!pack) return;
    // Write the current editor's template back into its pack slot before export.
    if (packSlot >= 0) {
      const bytes = T.exportSysex(S.toTemplate(model)); // full .syx
      const body = bodyFromSyx(bytes); // packs hold the raw 3408-byte body
      if (body) { pack.templates[packSlot].bytes = body; pack.templates[packSlot].name = model.name; }
    }
    const out = global.SLMK.pack.buildPack(pack);
    const url = URL.createObjectURL(new Blob([out], { type: 'application/zip' }));
    const a = el('a', { href: url, download: (pack.name || 'pack').replace(/[^\w -]/g, '') + '.slmkiiipack' });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Exported pack (' + pack.templates.length + ' templates, ' + pack.sessions.length + ' sessions).', 'ok');
  }
  // Extract the 3408-byte decoded body from a full template .syx (packs store bodies).
  function bodyFromSyx(bytes) {
    try { const tpl = T.parse(bytes); return new Uint8Array(T.toBody(tpl)); } catch (e) { return null; }
  }
  document.addEventListener('DOMContentLoaded', init);
})(window);
