#!/usr/bin/env node
/*
 * bridge.js — SL MkIII "color + custom mapping" bridge.
 *
 * The SL MkIII only shows custom LED colors in InControl mode, where every
 * control sends a *fixed* MIDI message. This bridge:
 *   1. re-asserts your color layout on the InControl output port (and keeps it
 *      warm on an interval so it survives pad presses / mode changes), and
 *   2. remaps the fixed InControl input messages to whatever you want, emitting
 *      them on a virtual MIDI port your DAW / synth can listen to.
 *
 * Result: your colors AND your mappings, live — without custom firmware.
 * Put the unit in InControl mode before running.
 *
 * Usage:
 *   node bridge.js --list                 # list MIDI ports and exit
 *   node bridge.js [--config config.json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const leds = require('./lib/leds');
const incontrol = require('./lib/incontrol');
const remap = require('./lib/remap');

function parseArgs(argv) {
  const a = { config: path.join(__dirname, 'config.json'), list: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--list') a.list = true;
    else if (argv[i] === '--config') a.config = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') a.help = true;
  }
  return a;
}

function loadConfig(file) {
  if (!fs.existsSync(file)) {
    throw new Error('Config not found: ' + file + '\nCopy config.example.json to config.json and edit it.');
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Colors may be inline, or reference a file exported by the browser tool.
  if (typeof cfg.colors === 'string') {
    const cf = path.isAbsolute(cfg.colors) ? cfg.colors : path.join(path.dirname(file), cfg.colors);
    const doc = JSON.parse(fs.readFileSync(cf, 'utf8'));
    cfg.colors = doc.config || doc; // accept the tool's {format,config} or a bare map
  }
  return cfg;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node bridge.js [--list] [--config config.json]');
    return;
  }

  // MIDI I/O is loaded lazily so --help works without hardware/ALSA.
  const midi = require('./lib/midi');

  if (args.list) {
    const p = midi.listPorts();
    console.log('MIDI inputs:\n  ' + (p.inputs.join('\n  ') || '(none)'));
    console.log('MIDI outputs:\n  ' + (p.outputs.join('\n  ') || '(none)'));
    return;
  }

  const cfg = loadConfig(args.config);
  const inNeedle = cfg.inputPort || 'InControl';
  const outNeedle = cfg.outputPort || 'InControl';
  const virtualName = cfg.virtualPort || 'SL MkIII Bridge';
  const keepAliveMs = cfg.keepAliveMs != null ? cfg.keepAliveMs : 4000;
  const mappings = cfg.mappings || {};
  const layout = leds.buildLayout(cfg.colors || {});

  const inp = midi.openInput(inNeedle);
  const slOut = midi.openOutput(outNeedle);
  const virt = midi.openVirtualOutput(virtualName);
  console.log('InControl input :', inp.name);
  console.log('InControl output:', slOut.name);
  console.log('Virtual output  :', virt.name, virt.virtual === false ? '(existing port)' : '(created)');
  console.log('Colors         :', layout.length, 'LEDs · keep-alive', keepAliveMs + 'ms');
  console.log('Mappings        :', Object.keys(mappings).length, 'controls');
  console.log('\nRunning. Make sure the SL MkIII is in InControl mode. Ctrl+C to stop.\n');

  const sendLayout = () => layout.forEach((m) => slOut.port.sendMessage(m));
  sendLayout();
  const timer = keepAliveMs > 0 ? setInterval(sendLayout, keepAliveMs) : null;

  inp.port.on('message', (_dt, message) => {
    const ev = incontrol.resolve(message);
    if (!ev) return;
    const out = remap.apply(ev, mappings, { passthrough: !!cfg.passthrough });
    if (out) virt.port.sendMessage(out);
  });

  const shutdown = () => {
    if (timer) clearInterval(timer);
    // Optional: turn the LEDs off on exit so we don't leave a stale layout.
    if (cfg.clearOnExit) {
      Object.values(leds.LED_IDS).forEach((id) => slOut.port.sendMessage(leds.ledRgb(id, 0, 0, 0, 'solid')));
    }
    try { inp.port.closePort(); slOut.port.closePort(); virt.port.closePort(); } catch (e) {}
    console.log('\nStopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('Error:', e.message); process.exit(1); }
}

module.exports = { parseArgs, loadConfig };
