# InControl Studio — Desktop (Electron)

The desktop build of **InControl Studio** with **native MIDI**. It loads the same
web UI, but all MIDI runs in Electron's main process via
[`@julusian/midi`](https://www.npmjs.com/package/@julusian/midi), exposed to the
page through a preload as `window.electronMIDI` (the shared `js/midi.js`
auto-detects it and routes through it instead of Web MIDI).

Unlike the browser build it can **create its own virtual MIDI port** on
macOS/Linux — `SL MkIII Bridge` just appears for your DAW/synth to use, with no
IAC/loopMIDI setup.

## Run it (development)

```bash
cd desktop
npm install        # electron + @julusian/midi (prebuilt binaries)
npm start
```

Put the SL MkIII in **InControl** mode. Ports auto-detect and the engine
auto-starts; pick a **Destination** port for your DAW/synth to receive the mapped
MIDI and the sequencer's notes.

## Build an installer (local)

```bash
npm run dist       # copies web assets into ./app, then runs electron-builder
```

Produces a `.dmg`/`.zip` (macOS), `.exe` NSIS installer (Windows), or `.AppImage`
(Linux) under `desktop/dist/`.

- **Build on the target OS** — electron-builder doesn't reliably cross-compile
  the native MIDI module, so build the `.exe` on Windows, the `.dmg` on macOS, etc.
- **First build needs internet** (downloads the Electron binary once).
- The build is **unsigned** (no paid certificate), so Windows SmartScreen warns
  on first launch: **More info → Run anyway**.

## Build via GitHub Actions (optional)

If you'd rather not build locally, the repo's
[`build-desktop.yml`](../.github/workflows/build-desktop.yml) workflow builds the
**Windows** installer: GitHub → **Actions** → **Build desktop app** → **Run
workflow**, then download from the run's **Artifacts**. Or push a version tag
(`git tag v1.0.0 && git push origin v1.0.0`) to attach it to a Release. Add
`macos-latest` / `ubuntu-latest` to the workflow for those platforms.

## Platform notes

- **macOS / Linux** — the virtual port is created natively; nothing to install.
- **Windows** — Windows has no native virtual MIDI, so the app can't create the
  `SL MkIII Bridge` port. Install
  [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html), make a port,
  and select it as the Destination instead.

## How it's wired

```
 renderer (index.html + js/*)          main process (main.js)
   js/midi.js ──uses──▶ window.electronMIDI ──IPC──▶ @julusian/midi
     LED / screen SysEx ───────────────────────────▶ SL MkIII InControl out
     InControl in (pads/buttons/knobs) ◀─────────────  SL MkIII InControl in
     mapped MIDI + sequencer notes ─────────────────▶ Destination (virtual port)
     MIDI clock ────────────────────────────────────▶ SL MkIII (arp sync)
```

- [`main.js`](main.js) — window + native MIDI (list/open/send/receive, virtual
  port, hot-plug poll). `backgroundThrottling` is off so the sequencer clock
  keeps running when the window is unfocused.
- [`preload.js`](preload.js) — safe `electronMIDI` bridge over IPC.
- [`copy-assets.js`](copy-assets.js) — stages the web UI into `app/` for
  packaging. Dev (`npm start`) reads the repo root directly and doesn't need this.
