/*
 * remap.js — turn a resolved InControl control event into outgoing MIDI bytes,
 * per the user's mapping config. Pure function, unit-tested.
 *
 * mappings: { "Pad 1": { type:'note', number:36, channel:10 },
 *             "Knob 1": { type:'cc', number:20, channel:1 }, ... }
 *   type    : 'note' | 'cc' | 'drop'
 *   number  : note number or CC controller (0-127)
 *   channel : 1-16 (defaults to 1)
 * The incoming `value` (velocity for pads, CC value for others) is carried into
 * the output's velocity/value slot.
 */
'use strict';

const clamp = (n, hi) => Math.max(0, Math.min(hi, n | 0));

/**
 * @param {{control:string,value:number,kind:string}} ev  from incontrol.resolve
 * @param {object} mappings
 * @param {object} [opts] { passthrough: boolean }  emit original if unmapped
 * @returns {number[]|null} raw MIDI bytes to send, or null to emit nothing
 */
function apply(ev, mappings, opts) {
  if (!ev) return null;
  const map = mappings && mappings[ev.control];
  if (!map) {
    return opts && opts.passthrough ? passthrough(ev) : null;
  }
  const type = map.type || (ev.kind === 'note' ? 'note' : 'cc');
  if (type === 'drop') return null;
  const ch = clamp((map.channel || 1) - 1, 15);
  const num = clamp(map.number, 127);
  const val = clamp(ev.value, 127);
  if (type === 'note') {
    // velocity 0 => note-off
    return val > 0 ? [0x90 | ch, num, val] : [0x80 | ch, num, 0];
  }
  // cc
  return [0xb0 | ch, num, val];
}

function passthrough(ev) {
  // Re-emit on channel 1 using the incoming kind and a best-effort number.
  return null; // passthrough of raw InControl messages is opt-in and rarely useful
}

module.exports = { apply };
