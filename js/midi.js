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
    onChange: null, // callback(state) when ports change
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
      if (state.onChange) state.onChange(snapshot());
    };
    if (!state.output) state.output = pickDefault();
    return snapshot();
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
    state.onChange = cb;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.midi = { connect, selectOutputById, send, snapshot, onChange };
})(window);
