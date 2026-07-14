/*
 * studio-persist.js — per-browser persistence for InControl Studio.
 *
 * Saves your work (templates, sessions, imported .syx sequences, the sequencer
 * and setup settings) in this browser's localStorage so it's still here next
 * time you open the app. Nothing is uploaded — it lives only in this browser,
 * on this device, and can be turned off or cleared from Settings.
 *
 * Two payloads:
 *   slmkiii-studio  — the whole studio model (the big one; JSON of the model)
 *   slmkiii-device  — device/engine settings (MIDI port ids, metronome, audio)
 * A flag key (slmkiii-persist) gates the whole feature; default on.
 */
(function (global) {
  'use strict';

  const MODEL_KEY = 'slmkiii-studio';
  const DEVICE_KEY = 'slmkiii-device';
  const FLAG_KEY = 'slmkiii-persist';

  function ls() { try { return global.localStorage; } catch (e) { return null; } }
  function available() { return !!ls(); }

  // Default ON when the flag was never set; 'off' disables it.
  function enabled() { const s = ls(); return s ? s.getItem(FLAG_KEY) !== 'off' : false; }
  function setEnabled(on) {
    const s = ls(); if (!s) return;
    try {
      s.setItem(FLAG_KEY, on ? 'on' : 'off');
      if (!on) { s.removeItem(MODEL_KEY); s.removeItem(DEVICE_KEY); lastSaved = ''; }
    } catch (e) {}
  }

  function readJSON(key) { const s = ls(); if (!s) return null; try { const t = s.getItem(key); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
  function writeJSON(key, obj) {
    const s = ls(); if (!s) return false;
    try { s.setItem(key, typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // ---- model autosave ---------------------------------------------------
  let lastSaved = '';
  let quotaHit = false;
  let onQuota = null;
  let timer = null;

  // Returns the stored model JSON string (or null). Primes the change-detector
  // so restoring then re-serialising doesn't trigger a redundant first write.
  function loadModelJSON() {
    if (!enabled()) return null;
    const s = ls(); if (!s) return null;
    try { const t = s.getItem(MODEL_KEY); if (t) lastSaved = t; return t || null; } catch (e) { return null; }
  }

  function saveModel(json) {
    if (!enabled()) return true;
    const s = ls(); if (!s) return false;
    try { s.setItem(MODEL_KEY, json); lastSaved = json; if (quotaHit) quotaHit = false; return true; }
    catch (e) { if (!quotaHit) { quotaHit = true; if (onQuota) try { onQuota(e); } catch (_) {} } return false; }
  }

  // Poll a serialiser and write only when the serialisation actually changed, so
  // idle time (and playhead-only re-renders) cost nothing. Also flushes when the
  // tab is hidden/closed so the latest edit survives even between poll ticks.
  function startAutosave(serialize, opts) {
    opts = opts || {};
    onQuota = opts.onQuota || null;
    const tick = () => {
      if (!enabled()) return;
      let json; try { json = serialize(); } catch (e) { return; }
      if (json && json !== lastSaved) saveModel(json);
    };
    if (timer) clearInterval(timer);
    timer = setInterval(tick, opts.interval || 2000);
    if (global.addEventListener) {
      global.addEventListener('pagehide', tick);
      global.addEventListener('visibilitychange', () => {
        if (global.document && global.document.visibilityState === 'hidden') tick();
      });
    }
    return tick; // caller may flush on demand
  }

  // ---- device settings --------------------------------------------------
  function loadDevice() { return enabled() ? readJSON(DEVICE_KEY) : null; }
  function saveDevice(obj) { if (enabled()) writeJSON(DEVICE_KEY, obj); }

  // ---- clear ------------------------------------------------------------
  function clearAll() {
    const s = ls(); if (!s) return;
    try { s.removeItem(MODEL_KEY); s.removeItem(DEVICE_KEY); } catch (e) {}
    lastSaved = '';
  }

  global.SLMK = global.SLMK || {};
  global.SLMK.persist = {
    available, enabled, setEnabled,
    loadModelJSON, saveModel, startAutosave,
    loadDevice, saveDevice,
    clearAll, readJSON, writeJSON,
    MODEL_KEY, DEVICE_KEY, FLAG_KEY,
  };
})(typeof window !== 'undefined' ? window : globalThis);
