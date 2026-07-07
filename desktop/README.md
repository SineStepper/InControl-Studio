# SL MkIII Customizer — Desktop (Electron)

A single desktop app bundling all three tools (**Live Colours · Template Lab ·
Bridge**) with **native MIDI**. Unlike the browser build it can **create its own
virtual MIDI port**, so the Bridge works with no IAC/loopMIDI setup — the port
`SL MkIII Bridge` just appears for your DAW/synth to use.

It loads the same UI as the web app; all MIDI runs in Electron's main process via
[`@julusian/midi`](https://www.npmjs.com/package/@julusian/midi), exposed to the
page through a preload as `window.electronMIDI` (the shared `js/midi.js`
auto-detects it).

## Run it (development)

```bash
cd desktop
npm install        # electron + @julusian/midi (prebuilt binaries)
npm start
```

The window opens on the Live Colours tab. Put the SL MkIII in **InControl** mode,
click **Connect MIDI**, and go. On the **Bridge** tab, choose `SL MkIII Bridge`
as the destination — it's the virtual port this app created.

## Build installers

```bash
npm run dist       # copies web assets into ./app, then runs electron-builder
```

Produces a `.dmg`/`.zip` (macOS), `.exe` NSIS installer (Windows), or `.AppImage`
(Linux) under `desktop/dist/`. Build on the target OS (electron-builder doesn't
cross-compile native modules reliably). First build downloads Electron, so it
needs internet.

## Platform notes

- **macOS / Linux** — the virtual port is created natively; nothing to install.
- **Windows** — Windows has no native virtual MIDI, so the app can't create the
  `SL MkIII Bridge` port. Install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html),
  make a port, and select it as the Bridge destination instead.

## How it's wired

```
 renderer (index.html + js/*)          main process (main.js)
   js/midi.js ──uses──▶ window.electronMIDI ──IPC──▶ @julusian/midi
     Live Colours  ─ send LED SysEx ───────────────▶ SL MkIII InControl out
     Bridge        ─ listen InControl in ◀───────────  SL MkIII InControl in
                   └ remap ─────────────────────────▶ virtual "SL MkIII Bridge"
```

- [`main.js`](main.js) — window + native MIDI (list/open/send/receive, virtual port, hot-plug poll).
- [`preload.js`](preload.js) — safe `electronMIDI` bridge over IPC.
- [`copy-assets.js`](copy-assets.js) — stages the web UI into `app/` for packaging.
