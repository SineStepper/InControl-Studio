/*
 * pack.js — read/write Novation Components packs (.slmkiiipack) and browse the
 * templates + sessions inside them.
 *
 * A pack is a ZIP: index.json (manifest with names + urls) + templates/*.slmkii-
 * itemplate (raw 3408-byte template bodies) + sessions/*.slmkiiisession (session
 * blobs). Uses native DecompressionStream for reading deflated entries; writes
 * STORE (uncompressed) entries — valid ZIP that Components/the device accept.
 * No external dependencies.
 */
(function (global) {
  'use strict';

  // ---- CRC-32 (shared with the template codec) ----
  let TBL = null;
  function crc32(bytes) {
    if (!TBL) { TBL = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TBL[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await stream.arrayBuffer());
  }

  /** Read a ZIP into { name: Uint8Array }. Handles STORE (0) and DEFLATE (8). */
  async function readZip(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // find End Of Central Directory (0x06054b50), scanning from the end
    let eocd = -1;
    for (let i = b.length - 22; i >= 0; i--) { if (u32(b, i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('Not a ZIP (no EOCD).');
    const count = u16(b, eocd + 10);
    let off = u32(b, eocd + 16); // central directory offset
    const files = {};
    for (let n = 0; n < count; n++) {
      if (u32(b, off) !== 0x02014b50) break; // central dir header
      const method = u16(b, off + 10);
      const compSize = u32(b, off + 20);
      const nameLen = u16(b, off + 28);
      const extraLen = u16(b, off + 30);
      const commentLen = u16(b, off + 32);
      const lho = u32(b, off + 42); // local header offset
      const name = dec.decode(b.subarray(off + 46, off + 46 + nameLen));
      // local header: name+extra then data
      const lNameLen = u16(b, lho + 26);
      const lExtraLen = u16(b, lho + 28);
      const dataStart = lho + 30 + lNameLen + lExtraLen;
      const raw = b.subarray(dataStart, dataStart + compSize);
      if (!name.endsWith('/')) {
        files[name] = method === 8 ? await inflateRaw(raw) : new Uint8Array(raw);
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  /** Write a ZIP (STORE only) from { name: Uint8Array | string }. */
  function writeZip(files) {
    const names = Object.keys(files);
    const locals = [];
    const central = [];
    let offset = 0;
    const parts = [];
    const dosTime = 0, dosDate = 0x21; // fixed timestamp (no Date in some contexts)
    names.forEach((name) => {
      const data = typeof files[name] === 'string' ? enc.encode(files[name]) : files[name];
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const lh = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      parts.push(lh, data);
      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);
      offset += lh.length + data.length;
    });
    const cdStart = offset;
    let cdSize = 0; central.forEach((c) => (cdSize += c.length));
    central.forEach((c) => parts.push(c));
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, names.length, true); ev.setUint16(10, names.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
    parts.push(eocd);
    let total = 0; parts.forEach((p) => (total += p.length));
    const out = new Uint8Array(total); let p = 0;
    parts.forEach((part) => { out.set(part, p); p += part.length; });
    return out;
  }

  // ---- pack model ----
  async function parsePack(bytes) {
    const files = await readZip(bytes);
    if (!files['index.json']) throw new Error('Not an SL MkIII pack (no index.json).');
    const index = JSON.parse(dec.decode(files['index.json']));
    const pick = (list) => (list || []).map((it) => ({ name: it.name, url: it.url, bytes: files[it.url] })).filter((x) => x.bytes);
    return {
      name: index.name || 'Pack',
      product: index.product,
      version: index.version,
      color: index.color || '',
      templates: pick(index.templates),
      sessions: pick(index.sessions),
      _files: files,
      _index: index,
    };
  }

  /**
   * Build a .slmkiiipack from a pack model. templates/sessions are
   * [{name, bytes|url}]; existing byte blobs are reused, new template bodies
   * (3408-byte Uint8Array) are written under templates/.
   */
  function buildPack(model) {
    const files = {};
    const index = { name: model.name || 'Pack', color: model.color || '', product: 'sl-mkiii', version: model.version || '2.0', sessions: [], templates: [] };
    (model.templates || []).forEach((t, i) => {
      const url = t.url || ('templates/template_' + i + '.slmkiiitemplate');
      files[url] = t.bytes;
      index.templates.push({ name: t.name || ('Template ' + i), url });
    });
    (model.sessions || []).forEach((s, i) => {
      const url = s.url || ('sessions/session_' + i + '.slmkiiisession');
      files[url] = s.bytes;
      index.sessions.push({ name: s.name || ('Session ' + i), url });
    });
    files['index.json'] = JSON.stringify(index);
    return writeZip(files);
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.pack = { readZip, writeZip, parsePack, buildPack, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SLMK.pack;
})(typeof window !== 'undefined' ? window : globalThis);
