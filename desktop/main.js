/*
 * main.js — Electron main process for the SL MkIII Customizer desktop app.
 *
 * Runs all MIDI natively (via @julusian/midi) in the main process, including a
 * *created* virtual output port so the Bridge works without loopMIDI/IAC setup.
 * The renderer is the same web UI; a preload bridges IPC as `window.electronMIDI`.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Web assets live at the repo root in dev, and in ./app when packaged (see
// copy-assets.js, run by the `dist` script). Prefer the packaged copy.
function indexPath() {
  const packaged = path.join(__dirname, 'app', 'index.html');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', 'index.html');
}

let midi = null;
try { midi = require('@julusian/midi'); } catch (e) { /* reported to the UI on connect */ }

const VIRTUAL_NAME = 'SL MkIII Bridge';
const openOutputs = new Map(); // name -> midi.Output
const openInputs = new Map(); // name -> midi.Input
let virtualOut = null;
let win = null;
let lastPortsJson = '';

function ensureVirtual() {
  if (virtualOut || !midi) return;
  try {
    virtualOut = new midi.Output();
    virtualOut.openVirtualPort(VIRTUAL_NAME); // macOS/Linux; throws on Windows
  } catch (e) {
    virtualOut = null; // Windows: user routes to a loopMIDI port instead
  }
}

function namesOf(Ctor) {
  const p = new Ctor();
  const names = [];
  for (let i = 0; i < p.getPortCount(); i++) names.push(p.getPortName(i));
  p.closePort();
  return names;
}

function listPorts() {
  if (!midi) return { inputs: [], outputs: [], error: 'native MIDI unavailable' };
  const outputs = namesOf(midi.Output);
  const inputs = namesOf(midi.Input);
  if (virtualOut && !outputs.includes(VIRTUAL_NAME)) outputs.push(VIRTUAL_NAME);
  return { inputs, outputs };
}

function indexOf(Ctor, name) {
  const p = new Ctor();
  let idx = -1;
  for (let i = 0; i < p.getPortCount(); i++) if (p.getPortName(i) === name) { idx = i; break; }
  p.closePort();
  return idx;
}

function getOutput(name) {
  if (name === VIRTUAL_NAME) { ensureVirtual(); return virtualOut; }
  if (openOutputs.has(name)) return openOutputs.get(name);
  if (!midi) return null;
  const idx = indexOf(midi.Output, name);
  if (idx < 0) return null;
  const o = new midi.Output();
  o.openPort(idx);
  openOutputs.set(name, o);
  return o;
}

function sendTo(name, bytes) {
  const o = getOutput(name);
  if (o) o.sendMessage(bytes);
}

function setListen(name, enable) {
  if (!enable) {
    const inp = openInputs.get(name);
    if (inp) { inp.closePort(); openInputs.delete(name); }
    return;
  }
  if (openInputs.has(name) || !midi) return;
  const idx = indexOf(midi.Input, name);
  if (idx < 0) return;
  const inp = new midi.Input();
  inp.ignoreTypes(true, true, true); // ignore sysex/timing/active-sensing; keep note/cc
  inp.on('message', (_dt, message) => {
    if (win && !win.isDestroyed()) win.webContents.send('midi:message', { port: name, bytes: Array.from(message) });
  });
  inp.openPort(idx);
  openInputs.set(name, inp);
}

function pollPorts() {
  const ports = listPorts();
  const json = JSON.stringify(ports);
  if (json !== lastPortsJson) {
    lastPortsJson = json;
    if (win && !win.isDestroyed()) win.webContents.send('midi:ports', ports);
  }
}

function createWindow() {
  ensureVirtual();
  win = new BrowserWindow({
    width: 1180,
    height: 900,
    backgroundColor: '#0e0f13',
    title: 'SL MkIII Customizer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(indexPath());
  setInterval(pollPorts, 2000);
}

ipcMain.handle('midi:list', () => listPorts());
ipcMain.on('midi:send', (_e, { port, bytes }) => { try { sendTo(port, bytes); } catch (e) {} });
ipcMain.on('midi:listen', (_e, { port, enable }) => { try { setListen(port, enable); } catch (e) {} });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  openInputs.forEach((i) => i.closePort());
  openOutputs.forEach((o) => o.closePort());
  if (virtualOut) virtualOut.closePort();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
