/*
 * midi.js — thin wrapper over @julusian/midi (RtMidi). Isolated so the rest of
 * the bridge stays testable without hardware.
 */
'use strict';

let midi;
function lib() {
  if (!midi) midi = require('@julusian/midi');
  return midi;
}

function listPorts() {
  const out = new (lib().Output)();
  const inp = new (lib().Input)();
  const outs = [];
  const ins = [];
  for (let i = 0; i < out.getPortCount(); i++) outs.push(out.getPortName(i));
  for (let i = 0; i < inp.getPortCount(); i++) ins.push(inp.getPortName(i));
  out.closePort(); inp.closePort();
  return { inputs: ins, outputs: outs };
}

function findPort(names, needle) {
  const rx = new RegExp(needle, 'i');
  const idx = names.findIndex((n) => rx.test(n));
  return idx;
}

function openInput(needle) {
  const inp = new (lib().Input)();
  const names = [];
  for (let i = 0; i < inp.getPortCount(); i++) names.push(inp.getPortName(i));
  const idx = findPort(names, needle);
  if (idx < 0) { inp.closePort(); throw new Error('No MIDI input matching /' + needle + '/. Available: ' + names.join(' | ')); }
  inp.openPort(idx);
  // We only care about note/cc; ignore sysex, timing, active-sensing.
  inp.ignoreTypes(true, true, true);
  return { port: inp, name: names[idx] };
}

function openOutput(needle) {
  const out = new (lib().Output)();
  const names = [];
  for (let i = 0; i < out.getPortCount(); i++) names.push(out.getPortName(i));
  const idx = findPort(names, needle);
  if (idx < 0) { out.closePort(); throw new Error('No MIDI output matching /' + needle + '/. Available: ' + names.join(' | ')); }
  out.openPort(idx);
  return { port: out, name: names[idx] };
}

// Create a virtual output (macOS/Linux). If an output port already matches the
// name (e.g. a loopMIDI port on Windows, which can't create virtual ports),
// open that instead.
function openVirtualOutput(name) {
  const probe = new (lib().Output)();
  const names = [];
  for (let i = 0; i < probe.getPortCount(); i++) names.push(probe.getPortName(i));
  const idx = findPort(names, name);
  if (idx >= 0) {
    probe.openPort(idx);
    return { port: probe, name: names[idx], virtual: false };
  }
  probe.closePort();
  const out = new (lib().Output)();
  if (typeof out.openVirtualPort !== 'function') {
    throw new Error(
      'Virtual MIDI ports are not supported on this platform. Create a port named "' +
        name + '" (e.g. with loopMIDI on Windows) and it will be used automatically.'
    );
  }
  out.openVirtualPort(name);
  return { port: out, name, virtual: true };
}

module.exports = { listPorts, openInput, openOutput, openVirtualOutput };
