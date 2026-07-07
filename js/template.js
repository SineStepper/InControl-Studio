/*
 * template.js — Reverse-engineered codec for Novation SL MkIII *template*
 * SysEx dumps (the .syx files Novation Components saves / transmits).
 *
 * IMPORTANT: templates store control *mappings* (MIDI type, CC/note, channel,
 * value range) — NOT LED colours. This module exists so the "Template Lab" can
 * decode, inspect, edit and re-encode a template bit-exactly, primarily to let
 * users *experiment* with whether any byte influences LED colour on hardware.
 *
 * Container format (reverse-engineered, verified by bit-exact round-trip on
 * real Components exports):
 *   - A dump is a sequence of SysEx messages, each F0 .. F7.
 *   - Common header: F0 00 20 29 02 0A 03   (note 03 = template, vs 01 = live)
 *   - Byte 7 = command: 01 start, 02 data chunk, 03 end.
 *   - Data (02) chunks carry the template body, 7-to-8 bit encoded, with the
 *     encoded payload starting at file offset 0x13 within the message.
 *   - 7-to-8 encoding: groups of [7 data bytes][1 MSB byte]; the MSB byte's
 *     bit k = bit7 of data byte k. A trailing partial group (<7 bytes) has NO
 *     MSB byte.
 *   - Decoded body: a 0x14-byte header (magic + 16-char template name) followed
 *     by fixed 44-byte control records.
 */
(function (global) {
  'use strict';

  const COMMON = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x03];
  const CMD_DATA = 0x02;
  const PAYLOAD_START = 0x13; // offset within a data message where encoding begins
  const HEADER_LEN = 0x14; // decoded body header before the first record
  const REC = 44; // decoded bytes per control record
  const NAME_OFF = 0x04; // template name offset within the decoded header
  const NAME_LEN = 16;

  function splitMessages(bytes) {
    const msgs = [];
    let i = 0;
    while (i < bytes.length) {
      const s = bytes.indexOf(0xf0, i);
      if (s < 0) break;
      let e = bytes.indexOf(0xf7, s);
      if (e < 0) break;
      msgs.push(bytes.slice(s, e + 1));
      i = e + 1;
    }
    return msgs;
  }

  // 7-to-8: expand encoded payload to decoded bytes.
  function dec8(payload) {
    const out = [];
    for (let g = 0; g < payload.length; g += 8) {
      const grp = payload.slice(g, g + 8);
      const data = grp.slice(0, 7);
      const msb = grp.length >= 8 ? grp[7] : 0;
      for (let k = 0; k < data.length; k++) out.push(data[k] | (((msb >> k) & 1) << 7));
    }
    return out;
  }

  // 8-to-7: pack decoded bytes back to encoded payload (partial group omits MSB).
  function enc8(dec) {
    const out = [];
    for (let g = 0; g < dec.length; g += 7) {
      const grp = dec.slice(g, g + 7);
      let msb = 0;
      for (let k = 0; k < grp.length; k++) if (grp[k] & 0x80) msb |= 1 << k;
      for (let k = 0; k < grp.length; k++) out.push(grp[k] & 0x7f);
      if (grp.length === 7) out.push(msb);
    }
    return out;
  }

  const isData = (m) => m.length > 7 && m[6] === COMMON[6] && m[7] === CMD_DATA;

  function looksLikeTemplate(msgs) {
    if (!msgs.length) return false;
    return msgs.every((m) => COMMON.every((b, i) => m[i] === b));
  }

  /**
   * Parse a template dump into an editable model.
   * Returns { name, records:[{index,offset,bytes,label}], _chunks, logical }.
   * `logical` is a mutable array; edit it, then call encode(model).
   */
  function parse(bytes) {
    const arr = Array.from(bytes);
    const msgs = splitMessages(arr);
    if (!looksLikeTemplate(msgs)) throw new Error('Not an SL MkIII template (.syx) dump.');

    // Assemble the logical (decoded) body, tracking chunk framing for re-encode.
    const logical = [];
    const chunks = []; // { msgIndex, prefix, decodedLen }
    msgs.forEach((m, mi) => {
      if (!isData(m)) return;
      const dec = dec8(m.slice(PAYLOAD_START, m.length - 1));
      chunks.push({ msgIndex: mi, prefix: m.slice(0, PAYLOAD_START), decodedLen: dec.length });
      for (const b of dec) logical.push(b);
    });

    const name = readAscii(logical, NAME_OFF, NAME_LEN);
    const records = [];
    for (let off = HEADER_LEN, idx = 0; off + REC <= logical.length; off += REC, idx++) {
      records.push({
        index: idx,
        offset: off,
        get bytes() {
          return logical.slice(off, off + REC);
        },
        label: readAscii(logical, off + 1, 14),
      });
    }

    return { name, records, logical, _msgs: msgs, _chunks: chunks };
  }

  function readAscii(arr, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = arr[off + i];
      if (c === 0) break;
      s += c >= 32 && c < 127 ? String.fromCharCode(c) : '';
    }
    return s.trim();
  }

  /** Re-encode an edited model back to a full .syx byte array (bit-exact if unedited). */
  function encode(model) {
    const out = [];
    let pos = 0;
    // Rebuild each original message; data chunks get re-encoded from `logical`.
    const dataByMsg = {};
    model._chunks.forEach((c) => (dataByMsg[c.msgIndex] = c));
    model._msgs.forEach((m, mi) => {
      const c = dataByMsg[mi];
      if (!c) {
        for (const b of m) out.push(b);
      } else {
        const dec = model.logical.slice(pos, pos + c.decodedLen);
        pos += c.decodedLen;
        for (const b of c.prefix) out.push(b);
        for (const b of enc8(dec)) out.push(b);
        out.push(0xf7);
      }
    });
    return out;
  }

  /** Overwrite bytes in a record (in-place on model.logical). offset is 0..43. */
  function setRecordByte(model, recIndex, recByteOffset, value) {
    const rec = model.records[recIndex];
    if (!rec) return;
    model.logical[rec.offset + recByteOffset] = value & 0x7f;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.template = {
    REC,
    HEADER_LEN,
    splitMessages,
    dec8,
    enc8,
    parse,
    encode,
    setRecordByte,
    looksLikeTemplate,
  };

  // Node/CommonJS export for headless testing.
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.template;
})(typeof window !== 'undefined' ? window : globalThis);
