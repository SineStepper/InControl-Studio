/*
 * template-editor.js — full SL MkIII template editor (Components-style mapping)
 * fused with the LED colour system.
 *
 * Edits every mapping field the template format carries (message type, channel,
 * CC/Note number, value range, button/pad behaviour, velocity, knob resolution),
 * and for the LED-bearing controls (pads, faders, the 8×2 buttons) also assigns
 * a colour that flows into the shared Live Colours config (and thus the Bridge).
 */
(function (global) {
  'use strict';
  const T = global.SLMK.sltemplate;
  const sysex = global.SLMK.sysex;
  const midi = global.SLMK.midi;
  const COLOR_KEY = 'slmkiii-customizer-config-v1';

  // Map template controls -> LED SysEx id for the ones that have an RGB LED.
  function ledId(sectionKey, i) {
    if (sectionKey === 'pad_hits') return 38 + i;
    if (sectionKey === 'faders') return 54 + i;
    if (sectionKey === 'buttons') return 4 + i; // 8×2 soft buttons -> Soft 1..16
    return null;
  }

  const BEHAVIORS = ['Momentary', 'Toggle', 'Inc/Dec', 'Trigger'];
  const RANGE_METHODS = ['None', 'Clip', 'Scale'];

  let model = T.newTemplate();
  let sel = { section: 'pad_hits', index: 0 };

  const $ = (s) => document.querySelector(s);
  const el = (t, p = {}, c = []) => {
    const n = document.createElement(t);
    const { dataset, ...rest } = p;
    Object.assign(n, rest);
    if (dataset) Object.entries(dataset).forEach(([k, v]) => (n.dataset[k] = v));
    (Array.isArray(c) ? c : [c]).forEach((x) => n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    return n;
  };

  // ---- shared colour config ----
  function colors() { try { return JSON.parse(localStorage.getItem(COLOR_KEY)) || {}; } catch (e) { return {}; } }
  function setColor(id, hex) {
    const c = colors();
    if (!hex || hex === '#000000') delete c[id]; else c[id] = { hex, behavior: (c[id] && c[id].behavior) || 'solid' };
    localStorage.setItem(COLOR_KEY, JSON.stringify(c));
    if (midi.snapshot().connected) { try { midi.send(sysex.ledFromConfig(id, c[id] || { hex: '#000000', behavior: 'solid' })); } catch (e) {} }
  }
  const colorOf = (id) => { const c = colors()[id]; return c ? c.hex : '#000000'; };

  // ---- control selector ----
  function renderControls() {
    const host = $('#te-controls');
    host.innerHTML = '';
    T.SECTIONS.forEach((s) => {
      const items = model.sections[s.key];
      const section = el('div', { className: 'te-section' });
      section.appendChild(el('h3', {}, s.label));
      const grid = el('div', { className: 'te-secgrid' });
      items.forEach((it, i) => {
        const lid = ledId(s.key, i);
        const on = lid != null && colorOf(lid) !== '#000000';
        const cell = el('button', {
          className: 'te-ctrl' + (sel.section === s.key && sel.index === i ? ' selected' : '') + (it.enabled ? ' enabled' : '') + (on ? ' lit' : ''),
          title: (it.name || label(s, i)) + (lid != null ? ' · LED ' + lid : ''),
          dataset: { s: s.key, i },
        });
        if (on) cell.style.setProperty('--c', colorOf(lid));
        cell.appendChild(el('span', { className: 'te-cname' }, it.name || label(s, i)));
        cell.appendChild(el('span', { className: 'te-cnum' }, numberSummary(s.type, it)));
        cell.addEventListener('click', () => { sel = { section: s.key, index: i }; renderControls(); renderInspector(); });
        grid.appendChild(cell);
      });
      section.appendChild(grid);
      host.appendChild(section);
    });
  }
  const label = (s, i) => s.label.replace(/s?( \(.*)?$/, '') + ' ' + (i + 1);
  function numberSummary(type, it) {
    if (!it.enabled) return 'off';
    const mt = T.MESSAGE_TYPES[it.message_type] || '';
    if (type === 'knob') return mt + ' ' + it.first_param;
    if (type === 'fader') return mt + ' ' + it.second_param;
    if (it.message_type === 2) return 'Note ' + it.third_param;
    return mt + ' ' + it.fourth_param;
  }

  // ---- inspector ----
  function renderInspector() {
    const host = $('#te-inspector');
    host.innerHTML = '';
    const s = T.SECTIONS.find((x) => x.key === sel.section);
    const it = model.sections[sel.section][sel.index];
    host.appendChild(el('div', { className: 'insp-title' }, (it.name || label(s, sel.index)) + '  —  ' + s.label));

    const field = (lbl, node) => { const f = el('div', { className: 'field' }, [el('label', {}, lbl)]); f.appendChild(node); return f; };
    const num = (val, min, max, on) => { const n = el('input', { type: 'number', min, max, value: val }); n.addEventListener('change', () => on(clampInt(n.value, min, max))); return n; };
    const text = (val, on, maxLength) => { const n = el('input', { type: 'text', value: val, maxLength }); n.addEventListener('change', () => on(n.value)); return n; };
    const check = (val, on) => { const n = el('input', { type: 'checkbox', checked: val }); n.addEventListener('change', () => on(n.checked)); return n; };
    const select = (opts, val, on) => { const n = el('select', {}); opts.forEach(([v, t]) => n.appendChild(el('option', { value: String(v), selected: String(v) === String(val) }, t))); n.addEventListener('change', () => on(n.value)); return n; };
    const upd = (k, v) => { it[k] = v; renderControls(); renderInspector(); };

    host.appendChild(field('Enabled', check(it.enabled, (v) => upd('enabled', v))));
    host.appendChild(field('Name', text(it.name, (v) => upd('name', v), 9)));
    host.appendChild(field('Message', select(T.MESSAGE_TYPES.map((m, i) => [i, m]), it.message_type, (v) => upd('message_type', +v))));
    const chOpts = [['default', 'Default']].concat(Array.from({ length: 16 }, (_, i) => [i + 1, 'Ch ' + (i + 1)]));
    host.appendChild(field('Channel', select(chOpts, it.channel, (v) => upd('channel', v === 'default' ? 'default' : +v))));

    // Number field(s) by type / message type
    if (s.type === 'knob') {
      host.appendChild(field(it.message_type === 2 ? 'Note' : 'CC #', num(it.first_param, 0, 127, (v) => upd('first_param', v))));
      host.appendChild(field('Min', num(it.from_value, 0, 16383, (v) => upd('from_value', v))));
      host.appendChild(field('Max', num(it.to_value, 0, 16383, (v) => upd('to_value', v))));
      host.appendChild(field('Resolution', num(it.resolution, 0, 16383, (v) => upd('resolution', v))));
    } else if (s.type === 'fader') {
      host.appendChild(field(it.message_type === 2 ? 'Note' : 'CC #', num(it.second_param, 0, 127, (v) => upd('second_param', v))));
      host.appendChild(field('Min', num(it.from_value, 0, 16383, (v) => upd('from_value', v))));
      host.appendChild(field('Max', num(it.to_value, 0, 16383, (v) => upd('to_value', v))));
    } else { // button / pad_hit
      if (it.message_type === 2) host.appendChild(field('Note', num(it.third_param, 0, 127, (v) => upd('third_param', v))));
      else host.appendChild(field('CC #', num(it.fourth_param, 0, 127, (v) => upd('fourth_param', v))));
      host.appendChild(field('Behaviour', select(BEHAVIORS.map((b, i) => [i, b]), it.behavior, (v) => upd('behavior', +v))));
      host.appendChild(field('On value', num(it.first_param, 0, 16383, (v) => upd('first_param', v))));
      host.appendChild(field('Off value', num(it.second_param, 0, 16383, (v) => upd('second_param', v))));
      if (s.type === 'pad_hit') {
        host.appendChild(field('Vel max', num(it.max_velocity, 0, 127, (v) => upd('max_velocity', v))));
        host.appendChild(field('Vel min', num(it.min_velocity, 0, 127, (v) => upd('min_velocity', v))));
        host.appendChild(field('Vel curve', select(RANGE_METHODS.map((m, i) => [i, m]), it.range_method, (v) => upd('range_method', +v))));
      }
    }

    // Colour (LED controls only)
    const lid = ledId(sel.section, sel.index);
    if (lid != null) {
      const wrap = el('div', { className: 'insp-color' });
      wrap.appendChild(el('h4', {}, 'LED colour (live / Bridge)'));
      const color = el('input', { type: 'color', value: colorOf(lid) === '#000000' ? '#000000' : colorOf(lid) });
      const hex = el('input', { type: 'text', className: 'hex', value: colorOf(lid).toUpperCase(), maxLength: 7 });
      const apply = (v) => { setColor(lid, v); color.value = v === '#000000' ? '#000000' : v; hex.value = v.toUpperCase(); renderControls(); };
      color.addEventListener('input', () => apply(color.value));
      hex.addEventListener('change', () => { if (/^#?[0-9a-f]{6}$/i.test(hex.value)) apply('#' + hex.value.replace('#', '')); });
      const off = el('button', { className: 'btn' }, 'Off'); off.addEventListener('click', () => apply('#000000'));
      wrap.appendChild(el('div', { className: 'field' }, [el('label', {}, 'Colour'), color, hex, off]));
      wrap.appendChild(el('p', { className: 'fineprint' }, 'Colour is stored in Live Colours (LED ' + lid + ') and sent by the Bridge. Templates themselves can’t hold colours.'));
      host.appendChild(wrap);
    } else {
      host.appendChild(el('p', { className: 'fineprint' }, 'This control has no RGB LED, so no colour.'));
    }
  }
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));

  // ---- file / template actions ----
  function setStatus(msg, cls) { const s = $('#te-status'); s.textContent = msg; s.className = 'status ' + (cls || ''); }
  function loadFile(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        model = T.parse(Array.from(new Uint8Array(r.result)));
        $('#te-name').value = model.name;
        sel = { section: 'pad_hits', index: 0 };
        renderControls(); renderInspector();
        setStatus('Loaded "' + model.name + '" ✓', 'ok');
      } catch (e) { setStatus(e.message, 'warn'); }
    };
    r.readAsArrayBuffer(file);
  }
  function download(name, bytes) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
    const a = el('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportSyx() {
    model.name = $('#te-name').value || 'Template';
    const bytes = T.exportSysex(model);
    download((model.name || 'template').replace(/[^\w -]/g, '') + '.syx', bytes);
    setStatus('Exported ' + bytes.length + '-byte template.', 'ok');
  }

  function init() {
    if (!$('#view-template')) return;
    $('#te-name').value = model.name;
    renderControls(); renderInspector();
    $('#te-new').addEventListener('click', () => { model = T.newTemplate(); $('#te-name').value = model.name; sel = { section: 'pad_hits', index: 0 }; renderControls(); renderInspector(); setStatus('New template.', 'ok'); });
    $('#te-file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
    $('#te-name').addEventListener('change', () => { model.name = $('#te-name').value; });
    $('#te-export').addEventListener('click', exportSyx);
  }
  document.addEventListener('DOMContentLoaded', init);
})(window);
