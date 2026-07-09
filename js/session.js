/*
 * session.js — read/write SL MkIII session SysEx dumps (.syx) and the raw
 * session bodies found inside Components packs (.slmkiiisession).
 *
 * A session .syx is a sequence of 64 session dumps, each using the same
 * container as templates but with type byte 0x01 (vs 0x02 for templates) and a
 * per-session slot byte: start / N data chunks (256 decoded bytes each, 7-to-8
 * encoded, nibble-indexed) / end (with a CRC-32 of the body as 8 nibbles). The
 * decoded body is the 94208-byte "USER" session blob (name at offset 0x20).
 *
 * Verified: decoding then re-encoding the real 64-session dump is bit-exact.
 */
(function (global) {
  'use strict';
  const T = () => global.SLMK.sltemplate; // reuse sevenToEight/eightToSeven/crc32
  const HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0a, 0x03];
  const TYPE_SESSION = 0x01;
  const nib = (v) => { const n = []; for (let i = 7; i >= 0; i--) n.push((v >>> (4 * i)) & 0xf); return n; };

  function split(bytes) {
    const b = Array.isArray(bytes) ? bytes : Array.from(bytes);
    const out = []; let i = 0;
    while (i < b.length) { const s = b.indexOf(0xf0, i); if (s < 0) break; const e = b.indexOf(0xf7, s); if (e < 0) break; out.push(b.slice(s, e + 1)); i = e + 1; }
    return out;
  }
  function readName(body) { let s = ''; for (let i = 0x20; i < 0x40; i++) { const c = body[i]; if (!c) break; if (c >= 32 && c < 127) s += String.fromCharCode(c); } return s.replace(/\s+$/, ''); }

  /** Decode a session .syx into [{ slot, name, body: Uint8Array }]. */
  function decodeSyx(bytes) {
    const t = T();
    const msgs = split(bytes);
    const out = []; let body = [], slot = 0;
    for (const m of msgs) {
      if (m[7] === 1) { body = []; slot = m[17]; }
      else if (m[7] === 2) { const dec = t.sevenToEight(m.slice(18, m.length - 1)); for (const x of dec) body.push(x); }
      else if (m[7] === 3) { out.push({ slot, name: readName(body), body: new Uint8Array(body) }); }
    }
    return out;
  }

  /** Encode one session body (Uint8Array/array) into its container messages. */
  function encodeOne(body, slot) {
    const t = T();
    const b = Array.isArray(body) ? body : Array.from(body);
    const out = []; const push = (a) => { for (const x of a) out.push(x); };
    push(HEADER); push([1, ...nib(0), TYPE_SESSION, slot, 1, 0xf7]);
    let crc = 0, block = 0;
    while (block * 256 < b.length) {
      const chunk = b.slice(block * 256, (block + 1) * 256);
      crc = t.crc32(chunk, crc);
      push(HEADER); push([2, ...nib(block + 1), TYPE_SESSION, slot, ...t.eightToSeven(chunk), 0xf7]);
      block++;
    }
    push(HEADER); push([3, ...nib(block + 1), TYPE_SESSION, slot, ...nib(crc >>> 0), 0xf7]);
    return out;
  }

  /** Encode [{ body, slot? }] (or raw bodies) into a full session .syx byte array. */
  function encodeSyx(sessions) {
    const out = [];
    sessions.forEach((s, i) => { const body = s.body || s; const slot = s.slot != null ? s.slot : i; for (const x of encodeOne(body, slot)) out.push(x); });
    return out;
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.session = { decodeSyx, encodeSyx, encodeOne, readName };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.session;
})(typeof window !== 'undefined' ? window : globalThis);
