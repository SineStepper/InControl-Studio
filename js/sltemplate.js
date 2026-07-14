/*
 * sltemplate.js — full read/write model for SL MkIII Components templates.
 *
 * Ported from the proven `inno/slmkiii` Python library (MIT), so the byte layout
 * and 7-to-8 encoding match Novation Components exactly. Exposes every mapping
 * field (message type, channel, CC/note, value range, button/pad behavior,
 * knob resolution, …) so we can build a real template editor.
 *
 * Record order (77 × 44 bytes after a 20-byte header): 16 buttons, 16 knobs,
 * 8 faders, 2 wheels, 2 pedals, 1 footswitch, 16 pad-hits, 16 pad-pressures.
 */
(function (global) {
  'use strict';

  const HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x03];
  const REC = 44;
  const BODY_HEADER = 20;

  const MESSAGE_TYPES = ['CC', 'NRPN', 'Note', 'Program Change', 'Song Position', 'Channel Pressure', 'Poly Aftertouch'];

  const SECTIONS = [
    { key: 'buttons', label: 'Buttons', type: 'button', count: 16 },
    { key: 'knobs', label: 'Knobs', type: 'knob', count: 16 },
    { key: 'faders', label: 'Faders', type: 'fader', count: 8 },
    { key: 'wheels', label: 'Wheels', type: 'fader', count: 2 },
    { key: 'pedals', label: 'Pedals', type: 'fader', count: 2 },
    { key: 'footswitches', label: 'Footswitch', type: 'button', count: 1 },
    { key: 'pad_hits', label: 'Pads (hit)', type: 'pad_hit', count: 16 },
    { key: 'pad_pressures', label: 'Pads (pressure)', type: 'fader', count: 16 },
  ];

  // ---- 7-to-8 bit encoding (MSB-first, matching Components) ----
  function sevenToEight(data) {
    const out = [];
    for (let off = 0; off < data.length; off += 8) {
      const chunk = data.slice(off, off + 8);
      const msb = chunk[0] || 0;
      for (let idx = 0; idx < chunk.length - 1; idx++) {
        out.push(chunk[idx + 1] + (((msb & (1 << idx)) >> idx) << 7));
      }
    }
    return out;
  }
  function eightToSeven(data) {
    const n = data.length;
    const out = new Array(1 + n + Math.floor(n / 7)).fill(0);
    let seven = 0, eight = 0;
    while (seven < n) {
      out[eight] = 0;
      for (let incr = 0; incr < 7; incr++) {
        if (seven + incr < n) {
          const char = data[seven + incr];
          out[eight + incr + 1] = 127 & char;
          out[eight] |= (128 & char) >> (7 - incr); // MSB bit only for real data bytes
        }
      }
      eight += 8;
      seven += 7;
    }
    return out.slice(0, eight);
  }

  // ---- CRC-32 (IEEE/zlib) ----
  let CRC_TABLE = null;
  function crc32(bytes, seed) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
    }
    let crc = (seed === undefined ? 0 : seed ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function bytesToNibbles(crc) { const n = []; for (let i = 0; i < 8; i++) n.push((crc >>> (4 * (7 - i))) & 0x0f); return n; }
  function nibblesToBytes(nb) { let o = 0; for (let i = 0; i < 8; i++) o = (o * 16 + nb[i]) >>> 0; return o >>> 0; }

  // ---- byte helpers ----
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const putU16 = (b, o, v) => { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };
  function readName(b) { let s = ''; for (let i = 1; i <= 9; i++) { const c = b[i]; if (c === 0) break; s += String.fromCharCode(c); } return s.replace(/\s+$/, ''); }
  function putName(b, name) { const s = (name || '').slice(0, 9); for (let i = 0; i < 9; i++) b[1 + i] = i < s.length ? s.charCodeAt(i) : 0; }
  const chFromByte = (v) => (v === 127 ? 'default' : v + 1);
  const chToByte = (c) => (c === 'default' || c == null ? 127 : Math.max(0, Math.min(15, c - 1)));

  // ---- per-type record read/serialize ----
  function readRecord(type, b) {
    const r = { enabled: !!b[0], name: readName(b), message_type: b[10] };
    if (type === 'button' || type === 'pad_hit') {
      r.behavior = b[12]; r.action = b[13];
      r.first_param = u16(b, 14); r.second_param = u16(b, 16);
      r.step = (b[18] === 0 && b[19] === 0) ? 0 : (((b[18] << 7) | b[19]) - 8192);
      r.wrap = !!b[20]; r.pair = !!b[21];
      r.channel = chFromByte(b[22]);
      r.third_param = b[23]; r.fourth_param = b[24]; r.lsb_index = b[25];
      if (type === 'pad_hit') { r.max_velocity = b[28]; r.min_velocity = b[29]; r.range_method = b[30]; }
    } else if (type === 'knob') {
      r.first_param = b[12]; r.lsb_index = b[13]; r.relative = b[14]; r.eight_bit = b[15];
      r.pivot = u16(b, 16); r.step = b[18]; r.resolution = u16(b, 19);
      r.channel = chFromByte(b[21]); r.from_value = u16(b, 22); r.to_value = u16(b, 24);
    } else { // fader / wheel / pedal / pad_pressure
      r.channel = chFromByte(b[12]); r.from_value = u16(b, 13); r.to_value = u16(b, 15);
      r.first_param = b[17]; r.second_param = b[18]; r.lsb_index = b[19];
    }
    return r;
  }

  function serializeRecord(type, r) {
    const b = new Array(REC).fill(0);
    b[0] = r.enabled ? 1 : 0;
    putName(b, r.name);
    b[10] = r.message_type & 0x7f;
    if (type === 'button' || type === 'pad_hit') {
      b[12] = r.behavior & 0xff; b[13] = r.action & 0xff;
      putU16(b, 14, r.first_param || 0); putU16(b, 16, r.second_param || 0);
      if (r.step) { const v = r.step + 8192; b[18] = (v >> 7) & 127; b[19] = v & 127; }
      b[20] = r.wrap ? 1 : 0; b[21] = r.pair ? 1 : 0;
      b[22] = chToByte(r.channel);
      b[23] = r.third_param & 0xff; b[24] = r.fourth_param & 0xff; b[25] = r.lsb_index & 0xff;
      if (type === 'pad_hit') { b[28] = r.max_velocity & 0xff; b[29] = r.min_velocity & 0xff; b[30] = r.range_method & 0xff; }
    } else if (type === 'knob') {
      b[12] = r.first_param & 0xff; b[13] = r.lsb_index & 0xff; b[14] = r.relative & 0xff; b[15] = r.eight_bit & 0xff;
      putU16(b, 16, r.pivot || 0); b[18] = r.step & 0xff; putU16(b, 19, r.resolution || 0);
      b[21] = chToByte(r.channel); putU16(b, 22, r.from_value || 0); putU16(b, 24, r.to_value || 0);
    } else {
      b[12] = chToByte(r.channel); putU16(b, 13, r.from_value || 0); putU16(b, 15, r.to_value || 0);
      b[17] = r.first_param & 0xff; b[18] = r.second_param & 0xff; b[19] = r.lsb_index & 0xff;
    }
    return b;
  }

  // ---- template open / export ----
  function splitMessages(bytes) {
    const msgs = []; let i = 0;
    while (i < bytes.length) { const s = bytes.indexOf(0xf0, i); if (s < 0) break; const e = bytes.indexOf(0xf7, s); if (e < 0) break; msgs.push(bytes.slice(s, e + 1)); i = e + 1; }
    return msgs;
  }

  /** Parse a template .syx (or a 3408-byte raw body) into a structured model. */
  function parse(bytes) {
    let body;
    if (bytes.length === 3408) {
      body = bytes.slice();
    } else {
      const msgs = splitMessages(bytes);
      if (!msgs.length || !HEADER.every((h, i) => msgs[0][i] === h)) throw new Error('Not an SL MkIII template (.syx).');
      body = [];
      let checksum = 0, stored = null;
      for (const m of msgs) {
        const cmd = m[7]; // byte 7 = command
        if (cmd === 1) body = [];
        else if (cmd === 2) { const dec = sevenToEight(m.slice(18, m.length - 1)); checksum = crc32(dec, checksum); for (const x of dec) body.push(x); }
        else if (cmd === 3) stored = nibblesToBytes(m.slice(18, m.length - 1));
      }
      if (stored != null && stored !== (checksum >>> 0)) throw new Error('Template checksum mismatch (file may be corrupt).');
    }
    const model = { name: '', sections: {} };
    model.name = readAscii(body, 4, 19);
    let ofst = BODY_HEADER;
    for (const s of SECTIONS) {
      const items = [];
      for (let n = 0; n < s.count; n++) { items.push(readRecord(s.type, body.slice(ofst, ofst + REC))); ofst += REC; }
      model.sections[s.key] = items;
    }
    return model;
  }
  function readAscii(b, off, end) { let s = ''; for (let i = off; i <= end; i++) { const c = b[i]; if (c === 0 || c === undefined) break; if (c >= 32 && c < 127) s += String.fromCharCode(c); } return s.replace(/\s+$/, ''); }

  /** Build the 3408-byte raw body from a model. */
  function toBody(model) {
    const body = new Array(BODY_HEADER).fill(0);
    // Magic used by Components-saved templates (byte 2 = 0x01; name is space-padded).
    body[0] = 0x50; body[1] = 0x0d; body[2] = 0x01; body[3] = 0x00;
    const name = (model.name || '').slice(0, 16);
    for (let i = 0; i < 16; i++) body[4 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
    for (const s of SECTIONS) {
      const items = model.sections[s.key] || [];
      for (let n = 0; n < s.count; n++) {
        const rec = serializeRecord(s.type, items[n] || defaultItem(s.type));
        for (const x of rec) body.push(x);
      }
    }
    return body;
  }

  /** Export a model to a full template .syx byte array. */
  function exportSysex(model) {
    const body = toBody(model);
    const out = [];
    const push = (arr) => { for (const x of arr) out.push(x); };
    // start
    push(HEADER); push([1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0xf7]);
    // data blocks of 256 decoded bytes
    let checksum = 0, block = 0;
    while (block * 256 <= body.length) {
      const chunk = body.slice(block * 256, (block + 1) * 256);
      if (chunk.length === 0 && block > 0) break;
      checksum = crc32(chunk, checksum);
      const enc = eightToSeven(chunk);
      push(HEADER);
      const idx = block + 1; // cmd(1) + uint32 0 + uint32 idx + 2B(2,0)
      push([2, 0, 0, 0, 0, (idx >> 24) & 0xff, (idx >> 16) & 0xff, (idx >> 8) & 0xff, idx & 0xff, 2, 0]);
      push(enc); out.push(0xf7);
      block++;
    }
    // footer: cmd(3) + uint32 0 + uint32 15 + 2B(2,0) + 8 checksum nibbles
    push(HEADER); push([3, 0, 0, 0, 0, 0, 0, 0, 15, 2, 0]); push(bytesToNibbles(checksum >>> 0)); out.push(0xf7);
    return out;
  }

  // ---- defaults / new template ----
  const DEFAULTS = {
    button: { enabled: false, name: '', message_type: 0, behavior: 0, action: 0, first_param: 127, second_param: 0, step: 0, wrap: false, pair: false, channel: 'default', third_param: 0, fourth_param: 0, lsb_index: 0 },
    knob: { enabled: false, name: '', message_type: 0, first_param: 0, lsb_index: 0, relative: 0, eight_bit: 0, pivot: 0, step: 1, resolution: 616, channel: 'default', from_value: 0, to_value: 127 },
    fader: { enabled: false, name: '', message_type: 0, channel: 'default', from_value: 0, to_value: 127, first_param: 0, second_param: 0, lsb_index: 0 },
    pad_hit: { enabled: false, name: '', message_type: 2, behavior: 0, action: 0, first_param: 127, second_param: 0, step: 0, wrap: false, pair: false, channel: 'default', third_param: 0, fourth_param: 0, lsb_index: 0, max_velocity: 1, min_velocity: 127, range_method: 0 },
  };
  function defaultItem(type) { return Object.assign({}, DEFAULTS[type]); }
  function newTemplate() {
    const model = { name: 'New Template', sections: {} };
    for (const s of SECTIONS) { model.sections[s.key] = []; for (let n = 0; n < s.count; n++) model.sections[s.key].push(defaultItem(s.type)); }
    return model;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.sltemplate = {
    SECTIONS, MESSAGE_TYPES, DEFAULTS,
    sevenToEight, eightToSeven, crc32, bytesToNibbles, nibblesToBytes,
    parse, exportSysex, toBody, newTemplate, defaultItem, readRecord, serializeRecord,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.sltemplate;
})(typeof window !== 'undefined' ? window : globalThis);
