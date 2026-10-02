# Windows engine (Jellyfin integration)

This is the **headless engine** half of the Jellyfin integration. It runs on a
dedicated Windows PC (the one sitting behind Mullvad), downloads shows / movies
/ anime, and places the finished files onto the **NAS library folders** — the
same folders Jellyfin scans. The Jellyfin plugin (built later, in C#) talks to
this engine over the HTTP API below.

The full design lives in
[`Jellyfin_Integration/Build plan.md`](../Jellyfin_Integration/Build%20plan.md).
This doc covers running the engine on Windows, wiring up the VPN and the NAS,
and driving it with `curl`.

> **Status:** engine safety (VPN gating + library safety), the HTTP API,
> staging + drive picking, and the duplicate check are implemented. The
> Jellyfin **plugin**, the search page, and notifications are still to come
> (build order steps 6–12).

## How it fits together

```
Jellyfin server (Linux)                Windows PC (behind Mullvad)
┌────────────────────────┐   HTTP     ┌────────────────────────────┐
│ Jellyfin + plugin      │ ────────▶  │ WebVideoDownloader engine  │
│  (outbox, pages, ...)  │  :7878     │  downloads → verify → stage│
└───────────┬────────────┘            └──────────────┬─────────────┘
            │ scans library folders                   │ places finished .mp4
            ▼                                         ▼
        ┌──────────────────────── NAS ─────────────────────────┐
        │  /anime  /tv  /movies   (SMB/CIFS shares)            │
        └───────────────────────────────────────────────────────┘
```

- The engine never asks a website for anything unless **Mullvad is confirmed up**.
- Finished files are verified, staged locally, then **moved** onto a library drive.
- The engine only ever replaces files *it* placed (a ledger tracks those). Any
  other file in the library — including a low-quality one — is left untouched.

## Requirements

- A **Windows** PC that stays on (the "engine" machine), with Mullvad installed
  and a working tunnel to wherever the sites live.
- The NAS library folders reachable from that PC as **drive letters** (e.g.
  `Z:\anime`, `Y:\tv`) — mapped network drives or a real mount. They must be
  writable and present at the moment a file is placed.
- [Node.js](https://nodejs.org/) 18+ (developed on Node 22).
- `npm install` run **on that Windows machine** so the Windows
  `ffmpeg-static` / `ffprobe-static` binaries are pulled.

## Install

```bat
cd C:\apps\webvideodownloader   :: wherever you keep the repo
npm install
```

Run it in the foreground first (a normal terminal) to make sure the VPN check
passes and the API comes up:

```bat
npm run start:engine
```

You should see:

```
[engine] API listening on 0.0.0.0:7878
[engine] ready: API listening on port 7878. The API key is in engine.json under the app data folder (see README).
```

## Configuration — `engine.json`

The engine config is created on first run at:

```
%APPDATA%\webvideodownloader\engine.json
```

```jsonc
{
  "apiKey": "…40 hex chars, generated on first run…",  // required by every /api call
  "port": 7878,
  "bind": "0.0.0.0",
  "stagingPath": "",                    // "" = %APPDATA%\webvideodownloader\staging
  "reserveBytes": 53687091200,          // 50 GB a library drive must keep free
  "fillMode": "order",                  // "order" or "spread"
  "pathMappings": [
    { "jellyfin": "\\\\nas\\anime", "engine": "Z:\\anime" }
  ],
  "jellyfin": { "baseUrl": "http://jellyfin.lan:8096", "apiKey": "" }
}
```

- **`apiKey`** — the Bearer key for the HTTP API. Copy it into the Jellyfin
  plugin later. Keep a backup; losing it means the plugin can't reach the engine.
- **`pathMappings`** — translate a **Jellyfin path** to the **engine drive path**.
  Jellyfin may see the NAS as `\\nas\anime` while the engine PC mounts the same
  share as `Z:\anime`. Jobs and reports use Jellyfin paths; the engine converts
  only when it touches the disk. The longest matching prefix wins.
- **`jellyfin`** — `baseUrl` + an API key (Jellyfin → Dashboard → API Keys).
  Used for the **per-folder refresh** (`POST /Library/Media/Updated`) so only the
  folder that just gained a file is rescanned. Leave blank to skip the refresh.
- **`fillMode`** — `"order"` fills the library's folders in the order Jellyfin
  lists them; `"spread"` uses the folder with the most free space.
- **`reserveBytes`** — a folder only "has room" when
  `free ≥ file size + reserve`. This is what pushes a new series onto the next
  drive once the current one is nearly full.

You can also change most of these live over the API (`PUT /api/settings`) and
from the desktop app's settings.

## Mullvad settings (Part 3)

The engine makes **no** outside request unless Mullvad is confirmed up, and it
re-checks continuously. On the engine PC, in the Mullvad app:

1. **Auto-connect on startup** — on.
2. **Lockdown mode** — **ON**. This is the important one: with Lockdown on, any
   traffic not through the tunnel is dropped, so the engine's own fail-closed
   gating and the OS agree. (The web-based VPN check is blocked by Lockdown
   exactly when the CLI fallback runs, so keep the Mullvad **CLI** working — it
   ships with the app and `mullvad status` is used as the fallback.)
3. **Allow local network sharing** — on, so the engine can still reach the NAS
   shares and the Jellyfin server on your LAN even while the tunnel is up.

## Windows Firewall

Allow the API port **only** from the Jellyfin machine (or your LAN):

```bat
:: run as Administrator — replace 192.168.1.10 with the Jellyfin server's IP
netsh advfirewall firewall add rule name="WVD Engine API" dir=in action=allow ^
  protocol=TCP localport=7878 remoteip=192.168.1.10
```

Outbound to the sites is handled by Mullvad; you don't need inbound rules for it.

## NAS library folders + the marker file

Each library folder the engine may place into must carry a small marker file:

```
<library folder>\.mediadownloader
```

The engine **creates it automatically** the first time a job names that folder
(see `ensureMarkers`), and `pickFolder` **skips any folder without it**. This is
what stops a dropped/unmounted NAS share from silently collecting finished files
at its mount point: if `Z:` is gone, `Z:\anime` has no marker and is not chosen.

Make sure the share is mapped and writable before you queue a job. A folder that
is not mounted simply gets skipped and the file retries (see `NO_SPACE` below).

## Driving it with curl

Every call needs `Authorization: Bearer <apiKey>`. From the Jellyfin machine:

```bash
KEY=<your api key>
BASE=http://192.168.1.20:7878   # the engine PC

# Health: VPN state, queue, staging free space
curl -s -H "Authorization: Bearer $KEY" $BASE/api/health

# Duplicate check for a title across the library + staging + queue
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"series":"Starfall Academy","season":1,"episodes":[1,2,3],"locations":["\\\\nas\\anime"]}' \
  $BASE/api/library/check

# Queue a whole series from a pasted episode URL
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
    "jobId":"5b0e0000-0000-4000-8000-000000000001",
    "kind":"series",
    "title":"Starfall Academy",
    "sourceUrl":"https://example.com/watch/starfall-academy/ep-1",
    "mode":"dub",
    "minHeight":1080,
    "library":{"id":"a1f","name":"Anime","locations":["\\\\nas\\anime","\\\\nas\\anime2"]},
    "scope":"full",
    "watch":true
  }' \
  $BASE/api/jobs
```

`jobId` is an idempotency key: resending the same `jobId` (e.g. the plugin's
outbox retrying after a lost reply) is **ignored**, so a job is delivered exactly
once. `watch:true` adds the series to the daily watcher so new episodes are pulled
automatically.

More endpoints:

| Method & path | Purpose |
|---|---|
| `GET /api/health` | version, VPN state, queue counts, staging free space |
| `GET /api/title?url=...&library=<json>` | episode list + per-episode status |
| `GET /api/search?q=...` | **stub** — site search adapters land later (step 9) |
| `POST /api/jobs` | queue a movie / series / specific episodes |
| `GET /api/queue` | queue snapshot + counts |
| `POST /api/queue/pause` `/resume` `/stop` | control the queue |
| `DELETE /api/queue/{id}` | remove one item |
| `POST /api/queue/{id}/retry` | re-queue a failed item |
| `GET /api/waiting` · `DELETE /api/waiting/{key}` | "waiting for dub" list |
| `GET /api/schedules` · `POST /api/schedules` · `DELETE /api/schedules/{key}` | keep-watching series |
| `POST /api/schedules/check` | run the scheduled pass now |
| `GET /api/settings` · `PUT /api/settings` | read / change engine config |
| `POST /api/library/check` | engine-side duplicate check |
| `GET /api/events` | **Server-Sent Events** live queue/log/VPN updates |

Watch a job download in real time:

```bash
curl -N -H "Authorization: Bearer $KEY" $BASE/api/events
```

## Running unattended (as a "service")

Electron needs a **desktop session**, so the engine doesn't run as a classic
Windows service (Session 0). The supported setup is a local account with
**auto-logon**, plus a scheduled task that starts the engine at logon and
restarts it if it crashes.

1. Enable auto-logon for a local (non-admin) account that can reach the NAS:
   `Win+R → netplwiz`, untick "Users must enter a user name and password".
2. From an **elevated** PowerShell, in the app folder:

   ```powershell
   .\scripts\service\install-task.ps1
   ```

   This creates the task **WebVideoDownloaderEngine** (trigger: at logon;
   runs `electron <appdir> --engine`; logs to
   `%APPDATA%\webvideodownloader\engine.log`; restarts 3× on failure; no time
   limit).

3. Watch the log:

   ```powershell
   Get-Content -Tail 20 -Wait "$env:APPDATA\webvideodownloader\engine.log"
   ```

4. Remove it later:

   ```powershell
   .\scripts\service\uninstall-task.ps1
   ```

> **NSSM alternative.** If you prefer a real service manager, [NSSM] can wrap the
> same `electron.exe <appdir> --engine` command as a Windows service. Because of
> the desktop-session requirement, the scheduled-task + auto-logon path above is
> the one that's tested; treat NSSM as an option to evaluate, not the default.
>
> [NSSM]: https://nssm.cc/

The build plan's "running unattended" part (Part 12) also wants a daily "all
good" message, a dead-man's switch, and log rotation. Those are on the later
steps and not yet implemented.

## Library safety (Part 11) — what the engine will and won't touch

- **Never overwrites a file it didn't place.** A ledger
  (`%APPDATA%\webvideodownloader\library.json`) records every file the engine put
  on disk. Only those may be replaced (e.g. a 720p copy upgraded to 1080p).
- **Old files go to trash, not the recycle bin and not deletion.** A replaced
  file is moved to `.mediadownloader-trash/<date>/` and purged after 30 days.
- **A file that can't be read is treated as present**, so the engine never
  downloads over a file it can't inspect (NAS asleep, network blip).
- **Foreign low-quality files are skipped and reported**, never replaced.
- **Read-only mode** (in `library.json`, shared with the desktop app) holds all
  downloads until you turn it off.
- **`NO_SPACE`** leaves the finished file in staging and re-queues it to be placed
  once a drive has room — it is never dropped.

Run the test suites any time:

```bash
node scripts/test-library.js       # Part 11: library safety (37 checks)
node scripts/test-engine-smoke.js # Phase 3: config, placer, NO_SPACE, HTTP API (39 checks)
```

The smoke test runs under plain Node (it fakes the `electron` module), so it
works on any OS without starting the app.

## Troubleshooting

| Symptom | First things to check |
|---|---|
| `401 unauthorized` on every call | `Authorization: Bearer <apiKey>` — key from `engine.json` |
| Jobs sit at `queued`, log says "VPN disconnected" | Mullvad tunnel is down; the engine is holding (correct behavior) |
| `Library is full - add a drive in Jellyfin` | raise `reserveBytes` lower, or add/mount another library folder |
| A folder is skipped | it's missing the `.mediadownloader` marker or not mounted/writable |
| Port already in use | another engine is running, or `port` collides — change `engine.json` |
