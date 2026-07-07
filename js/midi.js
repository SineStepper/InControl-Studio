/*
 * midi.js — thin wrapper around the Web MIDI API (SysEx enabled).
 *
 * The SL MkIII exposes several ports; LED control must target the port whose
 * name contains "InControl" (or "SL MkIII"). We surface all outputs and try to
 * auto-select the right one, but the user can override.
 */
(function (global) {
  'use strict';

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

  function listOutputs() {
    if (!state.access) return [];
    return Array.from(state.access.outputs.values());
  }
  function listInputs() {
    if (!state.access) return [];
    return Array.from(state.access.inputs.values());
  }

  /** Pick the best default output: prefer an InControl SL MkIII port. */
  function pickDefault() {
    const outs = listOutputs();
    return (
      outs.find((o) => looksLikeSLMkIII(o.name) && looksLikeInControl(o.name)) ||
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
      ins.find((o) => looksLikeSLMkIII(o.name) && looksLikeInControl(o.name)) ||
      ins.find((o) => looksLikeInControl(o.name)) ||
      ins.find((o) => looksLikeSLMkIII(o.name)) ||
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
    guessDefaultInputId, guessDefaultOutputId,
  };
})(window);
