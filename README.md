# WebVideoDownloader

A standalone desktop app (Electron) with its **own built-in browser** that detects
video streams on the pages you visit and downloads them as `.mp4` — similar to the
Video DownloadHelper browser extension, but as its own program. It supports
single downloads while you browse, and **pattern-based bulk downloads** across many
episodes and multiple series.

## Features

- **Built-in Chromium browser** with address bar / back / forward / reload.
- **Stream sniffing** of HLS (`.m3u8`), DASH (`.mpd`), and direct `.mp4`, including
  streams loaded inside iframed players. Required request headers
  (referer / cookie / user-agent) are captured automatically.
- **DUB selection + source fallback**: for each episode the app selects the DUB
  version, auto-detects the dub source buttons (e.g. Vidplay / BYFMS / DGHG) and
  tries them **left-to-right** until one yields a working stream. If all sources
  fail for an episode, the entire run stops and reports which episode failed.
- **Multi-URL bulk download**: add several series/URLs; each runs to completion
  before the next begins.
- **Multi-site by design**: site adapters (`src/main/sites/`) let you support many
  sites and expand over time. A generic heuristic profile handles unknown sites,
  and per-site profiles override selectors/behavior. You can also drop JSON
  profiles into `<userData>/sites/*.json` without touching the code.
- **Token-based URL templates**: episode URLs of any shape are supported. Paste a
  sample URL (the episode number is auto-detected) or write a template with
  `{episode}`, `{season}`, `{series}`, `{slug}`, `{id}` (e.g.
  `…/{slug}/ep-{episode}`). New URL formats are handled by adding a template.
- **"Waiting for dub" list + weekly watcher**: when more subbed episodes exist than
  dubbed, episodes with no dub yet are added to a persistent waiting list instead
  of failing the run. A watcher re-checks on launch and every 24h and downloads
  each dub automatically as it releases (new episodes come weekly).
- **Saved series presets**: save a set of series/URL entries and reload them later.
- **Mullvad VPN safety**: a background monitor pauses all downloads the moment the
  VPN drops and **auto-resumes** when it reconnects.
- **Robust downloads**: files are written to a `.part` temp file, verified with
  `ffprobe` (valid video stream + duration), resumed via HTTP Range where possible,
  and retried with backoff. Finished files only appear once verified.
- **Flat output naming**: everything lands in one folder, named
  `<Series> Season N - Episode NN.mp4`, so you can sort seasons manually.

## Requirements

- [Node.js](https://nodejs.org/) 18+ (developed on Node 22).
- `ffmpeg` / `ffprobe` are bundled via the `ffmpeg-static` / `ffprobe-static`
  npm packages — no separate install needed. **These binaries are downloaded for
  the OS you run `npm install` on**, so install on the platform you'll run on
  (don't copy a Windows `node_modules` to Linux, or vice-versa).
- Runs on **Windows, Linux, and macOS** (Electron is cross-platform).

## Install & run

```bash
npm install
npm start
```

### CachyOS / Arch quick start

CachyOS is Arch-based, so everything installs from the official repos with
`pacman`.

#### Recommended: install as a real desktop application

This builds a native package and installs it system-wide. Afterwards
**WebVideoDownloader appears in your application menu** — you click its icon to
open it (or type `webvideodownloader` from anywhere). No `npm`, no `cd`, no
terminal command every time.

```bash
# 1. Install prerequisites (Node.js ships npm; git to clone the repo)
sudo pacman -Syu --needed nodejs npm git

# 2. Clone the project
git clone https://github.com/loguefx/DownloaderWeb.git
cd DownloaderWeb

# 3. Install dependencies (downloads the Linux ffmpeg/ffprobe binaries)
npm install

# 4. Build the native pacman package
npm run build:linux            # produces dist/*.pkg.tar.zst

# 5. Install it (registers the app + menu icon)
sudo pacman -U dist/WebVideoDownloader-*.pkg.tar.zst
```

Now open it from your app launcher like any other program. To update later,
`git pull`, rebuild (steps 3–4), and reinstall (step 5). To uninstall:
`sudo pacman -R webvideodownloader`.

> Prefer a portable file instead? `npm run build:linux` also produces an
> **AppImage** in `dist/`. Make it executable and double-click it — no install
> needed: `chmod +x dist/WebVideoDownloader-*.AppImage`. (To get a menu entry
> for an AppImage, use a tool like Gear Lever / AppImageLauncher.)

#### Alternative: run from source (developer mode)

Use this only if you're hacking on the code. It launches the app but you must
run the command from the project folder each time — it does **not** create a
menu icon:

```bash
npm install
npm start
```

#### Troubleshooting the Chromium sandbox

If the app fails to open on a hardened/CachyOS kernel, either enable
unprivileged user namespaces or launch without the sandbox:

```bash
# Option A: enable unprivileged user namespaces (persist with a sysctl.d file)
sudo sysctl kernel.unprivileged_userns_clone=1

# Option B (dev mode only): run without the sandbox
npm start -- --no-sandbox
```

#### Troubleshooting: downloads fail as "protected" / permission denied (Linux)

If every download fails on Linux with something that looks like the video being
"protected" (localized desktops often translate this from *"Permission denied"*),
the cause is almost always the bundled `ffmpeg`/`ffprobe` binaries missing their
Unix **executable bit** — Linux then refuses to run them (`EACCES`), while the
identical setup works on Windows (which ignores the exec bit). It is **not** DRM.

This is now handled automatically:

- `npm install` runs a `postinstall` step that `chmod +x`'s both binaries.
- The app also best-effort `chmod`s them at runtime for writable installs.
- The packaged **pacman**/**AppImage** build runs an `afterPack` hook so the
  binaries ship executable even in read-only install locations.

If you hit it on an older checkout, just update and reinstall:

```bash
git pull
npm install            # re-runs the chmod postinstall
```

Or fix an existing install manually:

```bash
chmod +x node_modules/ffmpeg-static/ffmpeg
chmod +x node_modules/ffprobe-static/bin/linux/x64/ffprobe
```

#### Optional: Mullvad CLI

Install the Mullvad CLI so VPN monitoring can use it (the app also works via an
HTTP check if the CLI is absent):

```bash
sudo pacman -S mullvad-vpn   # or the AUR/official package
mullvad status               # should print Connected / Disconnected
```

### Linux (CachyOS / Arch and others)

Everything above works the same on Linux. Two extra notes:

- **Mullvad VPN monitoring** uses `am.i.mullvad.net` over HTTP first, and falls
  back to the `mullvad` CLI. Install the Mullvad app so the CLI is on `PATH`
  (`sudo pacman -S mullvad-vpn` on CachyOS/Arch, or the AUR/official package) and
  confirm `mullvad status` prints `Connected`/`Disconnected`. If the CLI is
  missing the app still works via the HTTP check.
- **Chromium sandbox**: if the app fails to launch offscreen bulk windows on a
  hardened kernel, enable unprivileged user namespaces
  (`sysctl kernel.unprivileged_userns_clone=1`) or run with
  `npm start -- --no-sandbox`.

Default download folder resolves to `~/Downloads` and app state lives under
`~/.config/WebVideoDownloader/`.

## Usage

### Single download
1. Browse to a video page in the built-in browser.
2. Select the player/quality you want so the stream actually loads.
3. The stream appears under **Detected videos** — click **Download**, set a name,
   and confirm.

### Bulk download
1. Click **Bulk Download**.
2. Choose the download folder.
3. For each series, fill in: series name, optional season, the base episode URL
   ending in `ep-N`, and the start/end episode (defaults 1–12).
4. Add more entries for additional series — they run one after another.
5. Click **Start bulk download**. Progress, status, and a live activity log appear
   in the sidebar.

## Multiple sites & expanding over time

Each site is a small adapter object. The fallback `generic` profile uses pure
heuristics so new sites work immediately; add a profile only when a site needs
tweaks.

Global defaults live in [`src/main/config.js`](src/main/config.js):

- `dub.dubLabelText` / `dub.subLabelText` — the DUB/SUB toggle text.
- `dub.knownSourceLabels` — known provider button names (on-page left-to-right
  order decides priority; this list just helps locate them).
- `dub.sourceWaitMs` — how long to wait for a source to produce a stream.
- `media.urlPatterns` / `media.contentTypePatterns` — what counts as a stream.

To add a site-specific adapter, drop a file in
[`src/main/sites/`](src/main/sites/) (copy the shape of
[`generic.js`](src/main/sites/generic.js)):

```js
module.exports = {
  id: 'mysite',
  name: 'My Site',
  match: [/mysite\.tv/i],          // matched against the URL
  dub: {                            // overrides merged over config.dub
    dubLabelText: ['dub'],
    knownSourceLabels: ['vidplay', 'byfms', 'dghg'],
    sourceWaitMs: 15000
  },
  urlTemplates: ['https://mysite.tv/watch/{slug}/ep-{episode}']
};
```

Or, without editing code, add a JSON profile (string `match` patterns) at
`<userData>/sites/mysite.json`.

### How "dub not out yet" is decided

Per-episode discovery returns one of three outcomes:

- **resolved** — a dub source produced a stream; it downloads.
- **unavailable** — no dub sources present (sub-only / not released). The episode
  goes to the **Waiting for dub** list and the run continues.
- **failed** — dub sources exist but none worked; the bulk run stops and reports
  the episode (watcher-triggered retries never stop the queue).

## Building installers

```bash
npm run build         # build for the current OS
npm run build:win     # Windows NSIS installer
npm run build:linux   # Linux: AppImage (portable) + pacman package
```

The Linux build produces an **AppImage** (runs on any distro, no install —
`chmod +x *.AppImage && ./WebVideoDownloader-*.AppImage`) and a **pacman**
package (`*.pkg.tar.zst`) that installs natively on CachyOS/Arch via
`sudo pacman -U`. Build Linux packages **on Linux** (electron-builder can't
cross-build them from Windows).

## Note

Only download content you have the rights to and that the source site's terms of
service permit. This tool is for personal, lawful use.
