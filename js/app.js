/*
 * app.js — UI, state, live sending, and template import/export.
 */
(function (global) {
  'use strict';

  const { sysex, controls, midi } = global.SLMK;
  const { CONTROLS, GROUPS, PRESETS, byId } = controls;

  const STORAGE_KEY = 'slmkiii-customizer-config-v1';

  // ---- State ---------------------------------------------------------------
  // config: { [ledId]: { hex: '#RRGGBB', behavior: 'solid'|'flash'|'pulse' } }
  let config = {};
  const selected = new Set(); // ledIds currently selected in the editor
  let autoSend = true;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    const { dataset, ...rest } = props;
    Object.assign(node, rest);
    if (dataset) Object.entries(dataset).forEach(([k, v]) => (node.dataset[k] = v));
    (Array.isArray(children) ? children : [children]).forEach((c) =>
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    );
    return node;
  };

  function entry(id) {
    return config[id] || { hex: '#000000', behavior: 'solid' };
  }

  // ---- Persistence ---------------------------------------------------------
  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      /* storage may be unavailable (private mode / file://) */
    }
  }
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) config = JSON.parse(raw);
    } catch (e) {
      config = {};
    }
  }

  // ---- Rendering: the control grid ----------------------------------------
  function renderGrid() {
    const host = $('#grid');
    host.innerHTML = '';
    GROUPS.forEach((g) => {
      const section = el('section', { className: 'group' });
      section.appendChild(el('h2', {}, g.label));
      const wrap = el('div', { className: 'group-grid' });
      wrap.style.setProperty('--cols', g.cols);
      CONTROLS.filter((c) => c.group === g.key).forEach((c) => {
        const e = entry(c.id);
        const on = e.hex && e.hex !== '#000000';
        const cell = el('button', {
          className:
            'led' +
            (selected.has(c.id) ? ' selected' : '') +
            (on ? ' on' : '') +
            (e.behavior && e.behavior !== 'solid' ? ' anim-' + e.behavior : ''),
          title: c.name + ' — LED id ' + c.id,
          dataset: { id: c.id },
        });
        cell.style.setProperty('--c', on ? e.hex : 'transparent');
        cell.appendChild(el('span', { className: 'led-label' }, c.name));
        cell.appendChild(el('span', { className: 'led-id' }, '#' + c.id));
        cell.addEventListener('click', (ev) => onCellClick(c.id, ev));
        wrap.appendChild(cell);
      });
      section.appendChild(wrap);
      host.appendChild(section);
    });
  }

  function onCellClick(id, ev) {
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    } else {
      const only = selected.size === 1 && selected.has(id);
      selected.clear();
      if (!only) selected.add(id);
    }
    renderGrid();
    renderEditor();
  }

  // ---- Rendering: the editor panel ----------------------------------------
  function renderEditor() {
    const panel = $('#editor');
    if (selected.size === 0) {
      panel.innerHTML = '';
      panel.appendChild(
        el('p', { className: 'hint' }, 'Select one or more controls to colour them.')
      );
      updateSelectionInfo();
      return;
    }

    // Use the first selected control as the editor's reference values.
    const refId = selected.values().next().value;
    const ref = entry(refId);

    panel.innerHTML = '';
    panel.appendChild(el('div', { className: 'sel-count' },
      selected.size === 1 ? byId[refId].name : selected.size + ' controls selected'));

    // Native colour picker + hex field.
    const color = el('input', { type: 'color', value: ref.hex || '#000000' });
    const hex = el('input', { type: 'text', className: 'hex', value: (ref.hex || '#000000').toUpperCase(), maxLength: 7 });
    color.addEventListener('input', () => { hex.value = color.value.toUpperCase(); applyColor(color.value); });
    hex.addEventListener('change', () => {
      const v = /^#?[0-9a-f]{6}$/i.test(hex.value) ? '#' + hex.value.replace('#', '') : ref.hex;
      color.value = v; hex.value = v.toUpperCase(); applyColor(v);
    });

    const row1 = el('div', { className: 'field' }, [
      el('label', {}, 'Colour'), color, hex,
    ]);

    // 7-bit R/G/B readout (what actually goes to the device).
    const { r, g, b } = sysex.hexTo7bit(ref.hex || '#000000');
    const rgb7 = el('div', { className: 'rgb7' },
      'Device RGB (7-bit): ' + r + ' / ' + g + ' / ' + b);

    // Behaviour selector.
    const beh = el('select', {});
    ['solid', 'flash', 'pulse'].forEach((v) =>
      beh.appendChild(el('option', { value: v, selected: (ref.behavior || 'solid') === v },
        v[0].toUpperCase() + v.slice(1))));
    beh.addEventListener('change', () => applyBehavior(beh.value));
    const row2 = el('div', { className: 'field' }, [el('label', {}, 'Mode'), beh]);

    // Preset swatches.
    const swatches = el('div', { className: 'swatches' });
    PRESETS.forEach((p) => {
      const s = el('button', { className: 'swatch', title: p.name });
      s.style.background = p.hex;
      s.addEventListener('click', () => { color.value = p.hex; hex.value = p.hex.toUpperCase(); applyColor(p.hex); });
      swatches.appendChild(s);
    });

    panel.append(row1, rgb7, row2,
      el('div', { className: 'field' }, [el('label', {}, 'Presets'), swatches]));
    updateSelectionInfo();
  }

  // ---- Mutations -----------------------------------------------------------
  function applyColor(hex) {
    selected.forEach((id) => {
      const e = entry(id);
      config[id] = { hex, behavior: e.behavior || 'solid' };
    });
    afterChange();
  }
  function applyBehavior(behavior) {
    selected.forEach((id) => {
      const e = entry(id);
      config[id] = { hex: e.hex || '#000000', behavior };
    });
    afterChange();
  }

  function afterChange() {
    saveLocal();
    renderGrid();
    renderEditor();
    if (autoSend) sendSelected();
  }

  // ---- Sending -------------------------------------------------------------
  function guardOutput() {
    const snap = midi.snapshot();
    if (!snap.connected || !snap.selectedId) {
      toast('Connect a MIDI output first.');
      return false;
    }
    return true;
  }

  function sendSelected() {
    if (!guardOutput()) return;
    selected.forEach((id) => midi.send(sysex.ledFromConfig(id, entry(id))));
  }

  function sendAll() {
    if (!guardOutput()) return;
    // Send every defined control (offs included) so the board matches the app.
    const full = {};
    CONTROLS.forEach((c) => (full[c.id] = entry(c.id)));
    CONTROLS.forEach((c) => midi.send(sysex.ledFromConfig(c.id, full[c.id])));
    toast('Sent all ' + CONTROLS.length + ' LEDs.');
  }

  function blackout() {
    config = {};
    CONTROLS.forEach((c) => (config[c.id] = { hex: '#000000', behavior: 'solid' }));
    afterChange();
    if (guardOutput()) {
      CONTROLS.forEach((c) => midi.send(sysex.ledRgb(c.id, 0, 0, 0, 'solid')));
      toast('All LEDs off.');
    }
  }

  function fillSelected(hex) {
    if (selected.size === 0) { toast('Select controls first.'); return; }
    applyColor(hex);
  }

  function rainbowPads() {
    const pads = CONTROLS.filter((c) => c.group === 'pads');
    pads.forEach((c, i) => {
      const hue = Math.round((i / pads.length) * 360);
      config[c.id] = { hex: hslToHex(hue, 100, 50), behavior: 'solid' };
    });
    afterChange();
    if (autoSend && guardOutput()) pads.forEach((c) => midi.send(sysex.ledFromConfig(c.id, entry(c.id))));
    toast('Rainbow across pads.');
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const c = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0');
    return '#' + c(0) + c(8) + c(4);
  }

  // ---- Import / Export -----------------------------------------------------
  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const doc = { format: 'slmkiii-customizer', version: 1, config };
    download('slmkiii-template.json', new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  }

  function exportSyx() {
    const full = {};
    CONTROLS.forEach((c) => (full[c.id] = entry(c.id)));
    download('slmkiii-leds.syx', sysex.syxBlob(sysex.buildAll(full)));
  }

  function copyHex() {
    const full = {};
    CONTROLS.forEach((c) => (full[c.id] = entry(c.id)));
    const text = sysex.bytesToHexString(sysex.buildAll(full));
    navigator.clipboard
      ? navigator.clipboard.writeText(text).then(() => toast('SysEx hex copied.'), () => fallbackCopy(text))
      : fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = el('textarea', { value: text });
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('SysEx hex copied.'); } catch (e) { toast('Copy failed.'); }
    ta.remove();
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = JSON.parse(reader.result);
        const incoming = doc.config || doc; // accept bare config too
        config = {};
        Object.keys(incoming).forEach((id) => {
          const e = incoming[id] || {};
          if (byId[id]) config[id] = { hex: e.hex || '#000000', behavior: e.behavior || 'solid' };
        });
        selected.clear();
        afterChange();
        toast('Template loaded.');
      } catch (e) {
        toast('Could not read that file.');
      }
    };
    reader.readAsText(file);
  }

  // ---- MIDI UI -------------------------------------------------------------
  function refreshMidiUi(snap) {
    const sel = $('#outputs');
    sel.innerHTML = '';
    if (!snap.outputs.length) {
      sel.appendChild(el('option', {}, 'No MIDI outputs'));
      sel.disabled = true;
    } else {
      sel.disabled = false;
      snap.outputs.forEach((o) =>
        sel.appendChild(el('option', { value: o.id, selected: o.id === snap.selectedId }, o.name)));
    }
    const status = $('#midi-status');
    if (snap.selectedName) {
      status.textContent = 'Connected: ' + snap.selectedName;
      status.className = 'ok';
    } else if (snap.connected) {
      status.textContent = 'No SL MkIII port found';
      status.className = 'warn';
    } else {
      status.textContent = 'Not connected';
      status.className = '';
    }
  }

  async function connectMidi() {
    try {
      const snap = await midi.connect();
      refreshMidiUi(snap);
      if (!/incontrol/i.test(snap.selectedName || ''))
        toast('Tip: select the "InControl" port and press InControl on the unit.');
    } catch (e) {
      toast(e.message);
    }
  }

  // ---- Toast ---------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function updateSelectionInfo() {
    $('#sel-info').textContent = selected.size + ' selected';
  }

  // ---- Wire up -------------------------------------------------------------
  function init() {
    loadLocal();
    renderGrid();
    renderEditor();

    $('#connect').addEventListener('click', connectMidi);
    $('#outputs').addEventListener('change', (e) => {
      midi.selectOutputById(e.target.value);
      refreshMidiUi(midi.snapshot());
    });
    midi.onChange(refreshMidiUi);

    $('#autosend').addEventListener('change', (e) => (autoSend = e.target.checked));
    $('#send-all').addEventListener('click', sendAll);
    $('#send-selected').addEventListener('click', sendSelected);
    $('#blackout').addEventListener('click', blackout);
    $('#rainbow').addEventListener('click', rainbowPads);
    $('#select-all').addEventListener('click', () => {
      CONTROLS.forEach((c) => selected.add(c.id));
      renderGrid(); renderEditor();
    });
    $('#select-none').addEventListener('click', () => {
      selected.clear(); renderGrid(); renderEditor();
    });

    $('#export-json').addEventListener('click', exportJson);
    $('#export-syx').addEventListener('click', exportSyx);
    $('#copy-hex').addEventListener('click', copyHex);
    $('#import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = '';
    });

    // Try to connect automatically; browsers may require the button instead.
    if (navigator.requestMIDIAccess) connectMidi().catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
