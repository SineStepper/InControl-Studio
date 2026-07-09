/*
 * midi.js — thin wrapper around the Web MIDI API (SysEx enabled).
 *
 * The SL MkIII exposes several ports; LED control must target the port whose
 * name contains "InControl" (or "SL MkIII"). We surface all outputs and try to
 * auto-select the right one, but the user can override.
 */
(function (global) {
  'use strict';

  // In the Electron desktop app, a preload script exposes `electronMIDI` and all
  // MIDI (including a created virtual port) runs natively in the main process.
  // Use that backend when present; otherwise fall back to the Web MIDI API.
  if (global.electronMIDI) { installElectronBackend(global); return; }

  const state = {
    access: null,
    output: null, // selected MIDIOutput
    listeners: [], // callbacks(state) when ports change
  };

  function looksLikeInControl(name) {
    return /incontrol/i.test(name);
  }
  function looksLikeSLMkIII(name) {
    return /sl\s*mk\s*(iii|3)/i.test(name);
  }
  // The SL MkIII's InControl port is named differently per OS:
  //   macOS:   "Novation SL MkIII (SL MkIII InControl)"  (in + out)
  //   Windows: "MIDIIN2 (Novation SL MkIII)" / "MIDIOUT2 (Novation SL MkIII)"
  // The keybed is the plain "Novation SL MkIII" port (not InControl, not port 2/3).
  const isInControlInput = (n) => looksLikeSLMkIII(n) && (looksLikeInControl(n) || /midiin\s*2/i.test(n));
  const isInControlOutput = (n) => looksLikeSLMkIII(n) && (looksLikeInControl(n) || /midiout\s*2/i.test(n));
  const isKeysInput = (n) => looksLikeSLMkIII(n) && !looksLikeInControl(n) && !/midi(in|out)\s*[23]/i.test(n);

  function listOutputs() {
    if (!state.access) return [];
    return Array.from(state.access.outputs.values());
  }
  function listInputs() {
    if (!state.access) return [];
    return Array.from(state.access.inputs.values());
  }

  /** Pick the best default output: the SL MkIII's InControl output port. */
  function pickDefault() {
    const outs = listOutputs();
    return (
      outs.find((o) => isInControlOutput(o.name)) ||
      outs.find((o) => looksLikeInControl(o.name)) ||
      outs.find((o) => looksLikeSLMkIII(o.name)) ||
      outs[0] ||
      null
    );
  }

  async function connect() {
    if (!navigator.requestMIDIAccess) {
      throw new Error(
        'Web MIDI is not available in this browser. Use Chrome, Edge, or Opera.'
      );
    }
    state.access = await navigator.requestMIDIAccess({ sysex: true });
    state.access.onstatechange = () => {
      // If our chosen port vanished, fall back to a default.
      if (state.output && state.output.state === 'disconnected') {
        state.output = pickDefault();
      }
      state.listeners.forEach((cb) => cb(snapshot()));
    };
    if (!state.output) state.output = pickDefault();
    const snap = snapshot();
    // Notify all tabs once on (re)connect so their port pickers populate.
    state.listeners.forEach((cb) => cb(snap));
    return snap;
  }

  function selectOutputById(id) {
    state.output = listOutputs().find((o) => o.id === id) || null;
    return state.output;
  }

  function send(bytes) {
    if (!state.output) throw new Error('No MIDI output selected.');
    state.output.send(bytes);
  }

  function snapshot() {
    return {
      connected: !!state.access,
      outputs: listOutputs().map((o) => ({
        id: o.id,
        name: o.name,
        manufacturer: o.manufacturer,
      })),
      selectedId: state.output ? state.output.id : null,
      selectedName: state.output ? state.output.name : null,
    };
  }

  function onChange(cb) {
    state.listeners.push(cb);
  }

  // ---- Multi-port helpers (used by the Bridge tab) ----
  const portList = (arr) => arr.map((p) => ({ id: p.id, name: p.name }));
  function outputPorts() { return portList(listOutputs()); }
  function inputPorts() { return portList(listInputs()); }

  /** Send bytes to a specific output by id (for the bridge's colour + remap paths). */
  function sendToOutput(id, bytes) {
    const o = listOutputs().find((p) => p.id === id);
    if (o) o.send(bytes);
  }

  /** Subscribe to a specific input's messages. Returns an unsubscribe fn. */
  function subscribeInput(id, handler) {
    const inp = listInputs().find((p) => p.id === id);
    if (!inp) return () => {};
    const wrapped = (e) => handler(Array.from(e.data));
    inp.addEventListener('midimessage', wrapped);
    return () => inp.removeEventListener('midimessage', wrapped);
  }

  function guessDefaultInputId() {
    const ins = listInputs();
    const pick =
      ins.find((o) => isInControlInput(o.name)) ||
      ins.find((o) => looksLikeInControl(o.name)) ||
      ins.find((o) => looksLikeSLMkIII(o.name)) ||
      ins[0];
    return pick ? pick.id : null;
  }
  // The keybed sends on the SL's *regular* (non-InControl) port.
  function guessDefaultKeysInputId() {
    const ins = listInputs();
    const pick =
      ins.find((o) => isKeysInput(o.name)) ||
      ins.find((o) => looksLikeSLMkIII(o.name) && !looksLikeInControl(o.name)) ||
      ins.find((o) => !looksLikeInControl(o.name)) ||
      ins[0];
    return pick ? pick.id : null;
  }
  function guessDefaultOutputId() {
    const o = pickDefault();
    return o ? o.id : null;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.midi = {
    connect, selectOutputById, send, snapshot, onChange,
    outputPorts, inputPorts, sendToOutput, subscribeInput,
    guessDefaultInputId, guessDefaultOutputId, guessDefaultKeysInputId,
  };

  // ---------------------------------------------------------------------------
  // Electron backend: same public API, backed by native MIDI over IPC.
  // Port ids are just the port names (stable enough across a session).
  // ---------------------------------------------------------------------------
  function installElectronBackend(g) {
    const E = g.electronMIDI;
    const st = { connected: false, outputs: [], inputs: [], selectedId: null, listeners: [], handlers: {} };
    const inControl = (n) => /incontrol/i.test(n);

    E.onMessage(({ port, bytes }) => (st.handlers[port] || []).forEach((h) => h(bytes)));
    E.onPorts((p) => { applyPorts(p); st.listeners.forEach((cb) => cb(snap())); });

    function applyPorts(p) {
      st.outputs = (p.outputs || []).map((n) => ({ id: n, name: n }));
      st.inputs = (p.inputs || []).map((n) => ({ id: n, name: n }));
      if (!st.selectedId || !st.outputs.some((o) => o.id === st.selectedId)) st.selectedId = guessOut();
    }
    async function connect() {
      applyPorts(await E.list());
      st.connected = true;
      const s = snap();
      st.listeners.forEach((cb) => cb(s));
      return s;
    }
    function snap() {
      return { connected: st.connected, outputs: st.outputs.slice(),
        selectedId: st.selectedId, selectedName: st.selectedId };
    }
    const isSL = (n) => /sl\s*mk\s*(iii|3)/i.test(n);
    const icIn = (n) => isSL(n) && (inControl(n) || /midiin\s*2/i.test(n));   // Windows: MIDIIN2 (...)
    const icOut = (n) => isSL(n) && (inControl(n) || /midiout\s*2/i.test(n)); // Windows: MIDIOUT2 (...)
    const keys = (n) => isSL(n) && !inControl(n) && !/midi(in|out)\s*[23]/i.test(n);
    const guessOut = () => { const o = st.outputs.find((x) => icOut(x.name)) || st.outputs.find((x) => inControl(x.name)) || st.outputs[0]; return o ? o.id : null; };
    const guessIn = () => { const i = st.inputs.find((x) => icIn(x.name)) || st.inputs.find((x) => inControl(x.name)) || st.inputs[0]; return i ? i.id : null; };
    const guessKeys = () => { const i = st.inputs.find((x) => keys(x.name)) || st.inputs.find((x) => isSL(x.name) && !inControl(x.name)) || st.inputs.find((x) => !inControl(x.name)) || st.inputs[0]; return i ? i.id : null; };

    g.SLMK = g.SLMK || {};
    g.SLMK.midi = {
      connect,
      snapshot: snap,
      onChange: (cb) => st.listeners.push(cb),
      selectOutputById: (id) => { st.selectedId = id; return { id, name: id }; },
      send: (bytes) => { if (st.selectedId) E.send(st.selectedId, bytes); },
      sendToOutput: (id, bytes) => { if (id) E.send(id, bytes); },
      outputPorts: () => st.outputs.slice(),
      inputPorts: () => st.inputs.slice(),
      subscribeInput: (id, handler) => {
        if (!id) return () => {};
        (st.handlers[id] = st.handlers[id] || []).push(handler);
        E.listen(id, true);
        return () => {
          st.handlers[id] = (st.handlers[id] || []).filter((h) => h !== handler);
          if (!st.handlers[id].length) E.listen(id, false);
        };
      },
      guessDefaultInputId: guessIn,
      guessDefaultOutputId: guessOut,
      guessDefaultKeysInputId: guessKeys,
    };
  }
})(window);
