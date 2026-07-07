/*
 * bridge-web.js — in-browser Bridge tab: hold colours on the SL MkIII + remap
 * its InControl messages to a chosen destination MIDI port.
 *
 * A browser can't CREATE a virtual MIDI port, so the destination must already
 * exist (an IAC bus on macOS, loopMIDI on Windows). For a headless service that
 * creates the port itself, use the Node bridge in /bridge.
 */
(function (global) {
  'use strict';
  const { midi, incontrol, sysex, controls } = global.SLMK;

  const state = {
    running: false,
    unsub: null,
    keepTimer: null,
    slOutId: null, // InControl output (colours)
    inId: null, // InControl input (control messages)
    destId: null, // remap destination output
    mappings: {}, // { control: {type,number,channel} }
    log: [],
  };

  const $ = (s) => document.querySelector(s);
  const el = (t, p = {}, c = []) => {
    const n = document.createElement(t);
    const { dataset, ...rest } = p;
    Object.assign(n, rest);
    if (dataset) Object.entries(dataset).forEach(([k, v]) => (n.dataset[k] = v));
    (Array.isArray(c) ? c : [c]).forEach((x) => n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    return n;
  };

  // Colour layout comes from the Customizer's current config (shared localStorage).
  function currentColors() {
    try {
      return JSON.parse(localStorage.getItem('slmkiii-customizer-config-v1')) || {};
    } catch (e) { return {}; }
  }
  function colorMessages() {
    const cfg = currentColors();
    const msgs = [];
    Object.keys(cfg).forEach((id) => {
      msgs.push(sysex.ledFromConfig(Number(id), cfg[id]));
    });
    return msgs;
  }

  function fillPortSelect(sel, ports, selectedId) {
    sel.innerHTML = '';
    if (!ports.length) { sel.appendChild(el('option', { value: '' }, '(none)')); sel.disabled = true; return; }
    sel.disabled = false;
    ports.forEach((p) => sel.appendChild(el('option', { value: p.id, selected: p.id === selectedId }, p.name)));
  }

  function refreshPorts() {
    const outs = midi.outputPorts();
    const ins = midi.inputPorts();
    if (!state.slOutId) state.slOutId = midi.guessDefaultOutputId();
    if (!state.inId) state.inId = midi.guessDefaultInputId();
    fillPortSelect($('#br-slout'), outs, state.slOutId);
    fillPortSelect($('#br-in'), ins, state.inId);
    fillPortSelect($('#br-dest'), outs, state.destId);
  }

  function renderMappings() {
    const host = $('#br-mappings');
    host.innerHTML = '';
    incontrol.CONTROL_NAMES.forEach((name) => {
      const m = state.mappings[name] || { type: 'drop', number: 0, channel: 1 };
      const row = el('div', { className: 'map-row' });
      row.appendChild(el('span', { className: 'map-name' }, name));
      const type = el('select', { className: 'map-type' });
      ['drop', 'note', 'cc'].forEach((t) => type.appendChild(el('option', { value: t, selected: m.type === t }, t)));
      const num = el('input', { type: 'number', min: 0, max: 127, value: m.number, className: 'map-num' });
      const ch = el('input', { type: 'number', min: 1, max: 16, value: m.channel, className: 'map-ch' });
      const sync = () => {
        state.mappings[name] = { type: type.value, number: +num.value | 0, channel: +ch.value | 0 };
        num.disabled = ch.disabled = type.value === 'drop';
      };
      type.addEventListener('change', sync); num.addEventListener('change', sync); ch.addEventListener('change', sync);
      num.disabled = ch.disabled = m.type === 'drop';
      row.append(type, el('span', { className: 'map-lbl' }, '#'), num, el('span', { className: 'map-lbl' }, 'ch'), ch);
      host.appendChild(row);
    });
  }

  function log(msg) {
    state.log.unshift(msg);
    state.log = state.log.slice(0, 8);
    $('#br-log').textContent = state.log.join('\n');
  }

  function sendColors() {
    const msgs = colorMessages();
    msgs.forEach((m) => midi.sendToOutput(state.slOutId, m));
    return msgs.length;
  }

  function start() {
    if (state.running) return;
    if (!midi.snapshot().connected) { toast('Connect MIDI first (top-right).'); return; }
    if (!state.inId || !state.destId) { toast('Pick an input and a destination port.'); return; }
    // Colours
    const n = sendColors();
    const keep = Math.max(0, parseInt($('#br-keep').value, 10) || 0);
    if (keep > 0) state.keepTimer = setInterval(sendColors, keep);
    // Remap
    state.unsub = midi.subscribeInput(state.inId, (bytes) => {
      const ev = incontrol.resolve(bytes);
      if (!ev) return;
      const out = incontrol.applyRemap(ev, state.mappings);
      if (out) { midi.sendToOutput(state.destId, out); log('▶ ' + ev.control + ' → ' + out.map((b) => b.toString(16)).join(' ')); }
    });
    state.running = true;
    $('#br-start').textContent = 'Stop bridge';
    $('#br-start').classList.add('running');
    log('Bridge started · ' + n + ' colour LEDs · keep-alive ' + keep + 'ms');
  }

  function stop() {
    if (state.unsub) { state.unsub(); state.unsub = null; }
    if (state.keepTimer) { clearInterval(state.keepTimer); state.keepTimer = null; }
    state.running = false;
    $('#br-start').textContent = 'Start bridge';
    $('#br-start').classList.remove('running');
    log('Bridge stopped.');
  }

  function exportConfig() {
    const doc = {
      format: 'slmkiii-bridge', version: 1,
      keepAliveMs: parseInt($('#br-keep').value, 10) || 0,
      colors: currentColors(),
      mappings: state.mappings,
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'bridge-config.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported bridge-config.json (usable by the Node bridge too).');
  }

  let toastTimer;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3000); }

  function init() {
    if (!$('#view-bridge')) return;
    renderMappings();
    refreshPorts();
    midi.onChange(() => { if (!state.running) refreshPorts(); });
    $('#br-slout').addEventListener('change', (e) => (state.slOutId = e.target.value));
    $('#br-in').addEventListener('change', (e) => (state.inId = e.target.value));
    $('#br-dest').addEventListener('change', (e) => (state.destId = e.target.value));
    $('#br-start').addEventListener('click', () => (state.running ? stop() : start()));
    $('#br-sendcolors').addEventListener('click', () => { if (midi.snapshot().connected && state.slOutId) { const n = sendColors(); toast('Sent ' + n + ' colour LEDs.'); } else toast('Connect MIDI and pick the SL output.'); });
    $('#br-export').addEventListener('click', exportConfig);
  }
  document.addEventListener('DOMContentLoaded', init);
})(window);
