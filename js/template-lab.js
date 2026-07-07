/*
 * template-lab.js — EXPERIMENTAL editor for SL MkIII template .syx dumps.
 *
 * Templates do not have a documented LED-colour field (see docs/TEMPLATE-FORMAT.md).
 * This lab lets you poke the per-control "value" bytes and export a modified
 * template so you can test on real hardware whether any byte affects the LEDs.
 * Unchanged bytes are preserved bit-exactly by the codec in template.js.
 */
(function (global) {
  'use strict';
  const T = global.SLMK.template;

  // Canonical record map, derived from the default "MIDI" template. The 77
  // records always appear in this fixed order. `probe` lists the record-byte
  // offsets that hold this control type's value fields (the colour candidates).
  const MAP = [];
  const push = (n, group, probe) => MAP.push({ name: n, group, probe });
  for (let i = 1; i <= 16; i++) push('Button ' + i, 'button', [15, 22]);
  for (let i = 1; i <= 16; i++) push('Knob ' + i, 'knob', [20, 21, 25]);
  for (let i = 1; i <= 8; i++) push('Fader ' + i, 'fader', [16]);
  push('Pedal / Sustain A', 'pedal', [16]);
  push('Pedal (CC1)', 'pedal', [16]);
  push('Expression', 'pedal', [16]);
  push('Sustain', 'pedal', [16]);
  push('Footswitch', 'pedal', [15, 22]);
  for (let i = 1; i <= 16; i++) push('Pad ' + i + ' (hit)', 'pad', [15, 22, 29]);
  for (let i = 1; i <= 16; i++) push('Pad ' + i + ' (pressure)', 'pad-pressure', [16]);

  let model = null;
  let origBytes = null;
  const $ = (s) => document.querySelector(s);
  const el = (t, p = {}, c = []) => {
    const n = document.createElement(t);
    const { dataset, ...rest } = p;
    Object.assign(n, rest);
    if (dataset) Object.entries(dataset).forEach(([k, v]) => (n.dataset[k] = v));
    (Array.isArray(c) ? c : [c]).forEach((x) =>
      n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x)
    );
    return n;
  };

  function loadFile(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        origBytes = Array.from(new Uint8Array(r.result));
        model = T.parse(origBytes);
        // Round-trip check: confirm we understand this file before letting edits out.
        const re = T.encode(T.parse(origBytes));
        const exact = re.length === origBytes.length && re.every((b, i) => b === origBytes[i]);
        $('#file-info').innerHTML = '';
        $('#file-info').append(
          el('span', { className: 'ok' }, 'Loaded "' + model.name + '" — ' + model.records.length + ' controls'),
          el('span', { className: exact ? 'ok' : 'warn' }, exact ? ' · codec verified ✓' : ' · ⚠ round-trip mismatch')
        );
        render();
      } catch (e) {
        $('#file-info').innerHTML = '';
        $('#file-info').append(el('span', { className: 'warn' }, e.message));
        model = null;
        render();
      }
    };
    r.readAsArrayBuffer(file);
  }

  function render() {
    const host = $('#lab');
    host.innerHTML = '';
    if (!model) {
      host.appendChild(el('p', { className: 'hint' }, 'Load a template .syx exported from Novation Components to begin.'));
      return;
    }
    // Focus section: the 16 pads (what people most want to colour).
    host.appendChild(el('h2', {}, 'Pads (hit) — colour probe'));
    host.appendChild(el('p', { className: 'hint' }, 'Each pad exposes its value bytes at offsets 15 / 22 / 29. Set them (0–127) and export, then load onto the SL MkIII and watch whether the pad LEDs change.'));
    const grid = el('div', { className: 'lab-grid' });
    MAP.forEach((c, i) => {
      if (c.group !== 'pad') return;
      grid.appendChild(padCell(i, c));
    });
    host.appendChild(grid);

    // Advanced: full record table.
    const details = el('details', {});
    details.appendChild(el('summary', {}, 'All ' + model.records.length + ' controls (advanced raw-byte editing)'));
    const table = el('div', { className: 'rec-table' });
    MAP.forEach((c, i) => {
      const rec = model.records[i];
      if (!rec) return;
      const row = el('div', { className: 'rec-row' });
      row.appendChild(el('span', { className: 'rec-name' }, 'R' + String(i).padStart(2, '0') + ' ' + c.name));
      const hex = el('input', {
        className: 'rec-hex',
        value: rec.bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
        spellcheck: false,
      });
      hex.addEventListener('change', () => {
        const vals = hex.value.trim().split(/\s+/).map((h) => parseInt(h, 16));
        if (vals.length === T.REC && vals.every((v) => v >= 0 && v <= 0x7f)) {
          for (let k = 0; k < T.REC; k++) T.setRecordByte(model, i, k, vals[k]);
          render();
        } else {
          hex.classList.add('bad');
        }
      });
      row.appendChild(hex);
      table.appendChild(row);
    });
    details.appendChild(table);
    host.appendChild(details);
  }

  function padCell(recIndex, c) {
    const rec = model.records[recIndex];
    const b = rec.bytes;
    const cell = el('div', { className: 'pad-cell' });
    cell.appendChild(el('div', { className: 'pad-name' }, c.name.replace(' (hit)', '')));
    // Three byte inputs for the probe offsets.
    const inputs = el('div', { className: 'byte-inputs' });
    c.probe.forEach((off) => {
      const wrap = el('label', { className: 'byte-in' }, '@' + off);
      const inp = el('input', { type: 'number', min: 0, max: 127, value: b[off] });
      inp.addEventListener('change', () => {
        let v = Math.max(0, Math.min(127, parseInt(inp.value, 10) || 0));
        inp.value = v;
        T.setRecordByte(model, recIndex, off, v);
      });
      wrap.appendChild(inp);
      inputs.appendChild(wrap);
    });
    cell.appendChild(inputs);
    // Convenience: an RGB guess that writes R->@15, G->@22, B->@29 (7-bit).
    if (c.probe.length === 3) {
      const color = el('input', { type: 'color', value: '#000000', title: 'Guess: R→@15 G→@22 B→@29' });
      color.addEventListener('input', () => {
        const { r, g, b: bl } = SLMK.sysex.hexTo7bit(color.value);
        [ [15, r], [22, g], [29, bl] ].forEach(([o, v]) => T.setRecordByte(model, recIndex, o, v));
        render();
      });
      cell.appendChild(color);
    }
    return cell;
  }

  // ---- Probe generators: quick experiments to run on hardware ----
  function probeRainbow() {
    if (!model) return;
    let n = 0;
    MAP.forEach((c, i) => {
      if (c.group !== 'pad') return;
      const hue = Math.round((n / 16) * 360); n++;
      const hex = hslToHex(hue, 100, 50);
      const { r, g, b } = SLMK.sysex.hexTo7bit(hex);
      T.setRecordByte(model, i, 15, r);
      T.setRecordByte(model, i, 22, g);
      T.setRecordByte(model, i, 29, b);
    });
    render();
    toast('Pads set to a rainbow across offsets 15/22/29. Export and test.');
  }
  function probeDark() {
    if (!model) return;
    MAP.forEach((c, i) => {
      if (c.group !== 'pad') return;
      [15, 22, 29].forEach((o) => T.setRecordByte(model, i, o, 0));
    });
    render();
    toast('All pad value bytes zeroed. If pads go dark on hardware, these bytes drive the LEDs.');
  }
  function reset() {
    if (!origBytes) return;
    model = T.parse(origBytes);
    render();
    toast('Reverted to the loaded template.');
  }

  function exportSyx() {
    if (!model) return;
    const bytes = T.encode(model);
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: (model.name || 'template') + '-edited.syx' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported. Load it via Components / a SysEx tool, then observe the LEDs.');
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const c = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0');
    return '#' + c(0) + c(8) + c(4);
  }

  let toastTimer;
  function toast(m) {
    const t = $('#toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function init() {
    $('#file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
    $('#probe-rainbow').addEventListener('click', probeRainbow);
    $('#probe-dark').addEventListener('click', probeDark);
    $('#reset').addEventListener('click', reset);
    $('#export').addEventListener('click', exportSyx);
    render();
  }
  document.addEventListener('DOMContentLoaded', init);
})(window);
