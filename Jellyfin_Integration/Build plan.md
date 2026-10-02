# Media Downloader — Jellyfin Build Plan

Sep 30, 2026 · @Logan

Build it as two programs: a small C# plugin inside Jellyfin, and your existing DownloaderWeb engine running headless on a separate PC behind Mullvad. The plugin only asks the engine for work. The engine only downloads when Mullvad is up, and it files each finished video on whichever drive in the right Jellyfin library has room.

## At a glance

&#91;embedded content: architecture · Jellyfin server, engine PC, Mullvad, NAS\]

The Jellyfin server only talks to the engine over the LAN. The engine's outside traffic all goes through Mullvad, and finished files move to whichever NAS drive the library has room on.

## What exists vs. what to build

Most of the hard work already exists in the `linux` branch. The new work is mostly exposing it over the network and adding search, the plugin and the drive picker.

| Piece | Today in DownloaderWeb | To build |
| --- | --- | --- |
| Control surface | Electron IPC from its own window (`main.js`: `bulk-start`, `queue-*`, `schedule-*`, `vpn-status`) | HTTP API with an API key (Part 1) |
| Search by title | `sites/findtitle.js` finds a known S#E# on other sites (1080p fallback only) | Search that returns shows, movies and anime with poster, year and type |
| Seasons and episodes | `bulk.detectEpisodes` scans one season from a URL | All seasons and episodes, each with a status: in library, dub out, aired |
| Queue, retries, verify | `queue.js`: saved to `queue-manifest.json`, retries, ffprobe check, `.part` files | Accept jobs by id from the plugin; report progress |
| DUB/SUB and waiting for dub | `dubselect.js`, `pending.js`, `watcher.js` (every 24 h) | Expose to the plugin |
| Keep watching a series | `schedule.js` | Expose to the plugin |
| VPN | `vpn.js` checks am.i.mullvad.net every 4 s; `queue.js` pauses downloads | Block every network action, not just downloads (Part 3) |
| File naming | `organizer.js`: `<root>/<Series>/Season N/<Series> S1E1.mp4`; movies `<root>/<Title>/<Title>.mp4` | Add the year to movies: `Title (2023)/Title (2023).mp4` |
| Where files go | One `outputRoot` folder per batch | Library-aware drive picker (Part 5) |
| Jellyfin | Nothing | C# plugin with dashboard pages (Part 2) |

**File names stay exactly as the web downloader writes them.** The plugin never builds a path. It sends title, season and episode; the engine names every file with the same `organizer.js` functions (`sanitize`, `buildBaseName`, `seriesDir`) the desktop app uses today. This replaces my earlier suggestion to add the year to movie folders.

| Kind | Folder | File |
| --- | --- | --- |
| Show or anime episode | `<Library>/<Series>/Season 2/` | `<Series> S2E5.mp4` |
| Movie | `<Library>/<Title>/` | `<Title>.mp4` |
| Sub-only anime episode | same as the dub | same name; `[SUB]` appears only in the queue label |

Season and episode numbers are not zero-padded (`Season 2`, `S2E5`). Characters illegal on Windows are replaced with a space and trailing dots are trimmed, so the same library works from Windows and Linux.

## Part 1 — The engine's HTTP API

The engine stays an Electron app, because discovery needs real Chromium windows to load pages, pass Cloudflare and sniff streams. Add an `--engine` mode that starts an HTTP server and opens no main window.

**Steps**

1. Move the body of every `ipcMain.handle(...)` in `main.js` into a new `src/main/service.js`. IPC and HTTP both call it, so the desktop app keeps working.
2. Add `src/main/api.js`: a plain Node `http` server on port 7878, bound to the engine PC's LAN address. Every request must carry `Authorization: Bearer <api key>`; the key lives in `~/.config/webvideodownloader/engine.json`.
3. In `main.js`, when `--engine` is passed, skip `createWindow()` and start `api.js`, `vpn.start()`, the queue restore and `watcher.start()`.
4. Run it as a systemd user service with `Restart=always`. If the PC has no desktop session, wrap it in `xvfb-run -a` so Chromium has a display.

**Endpoints**

| Method and path | Does | Built on |
| --- | --- | --- |
| `GET /api/health` | Engine version, VPN state and detail, queue counts, free space on the staging disk | `vpn.isConnected()`, `manager.snapshot()` |
| `GET /api/search?q=&type=` | Title search across enabled sites | New `search()` on each site adapter, reusing the search-page pipeline in `findtitle.js` |
| `GET /api/title?url=` | Every season and episode, each with a status | `bulk.detectEpisodes` run per season, plus `organizer.existingEpisodeFile` for "in library" |
| `POST /api/jobs` | Queue a movie, full series, seasons or picked episodes | `bulk.startBatch` for whole seasons, `bulk.queueOne` per picked episode |
| `GET /api/queue` and `GET /api/events` | Queue snapshot, then live updates as Server-Sent Events | `manager.snapshot()`, the existing `queue:update` and `queue:log` events |
| `POST /api/queue/pause`, `/resume`, `/stop` | Queue controls | `manager.pause()`, `resume()`, `stopAll()` |
| `DELETE /api/queue/{id}`, `POST /api/queue/{id}/retry` | Remove or retry one item | `manager.removeByIds()`, re-`add` |
| `GET` and `DELETE /api/waiting` | Waiting-for-dub list | `pending.js` |
| `GET`, `POST`, `DELETE /api/schedules` | Keep-watching series | `schedule.js`, `watcher.checkSchedules()` |
| `GET` and `PUT /api/settings` | Source order, retries, FlareSolverr URL | `config.js`, made writable to a JSON file |

**The job the plugin sends**

```json
{
  "jobId": "5b0e…",
  "kind": "series",
  "title": "Starfall Academy",
  "year": 2023,
  "sourceUrl": "https://aniwaves.ru/watch/starfall-academy/ep-1",
  "mode": "dub",
  "minHeight": 1080,
  "library": { "id": "a1f…", "name": "Anime", "locations": ["/mnt/disk1/anime", "/mnt/disk2/anime"] },
  "scope": "episodes",
  "selections": [{ "season": 2, "episodes": [1, 2, 3, 4, 5, 6, 7, 8] }],
  "watch": true
}
```

`jobId` is a GUID the plugin makes. The engine ignores a `jobId` it has already accepted, so the plugin can safely resend. `scope` is `full`, `seasons` or `episodes`, matching the three buttons on the Choose episodes screen.

## Part 2 — The Jellyfin plugin

The plugin is a .NET class library that Jellyfin loads. It shows the dashboard pages, keeps the engine address and key, and talks to the engine on the browser's behalf. The browser never talks to the engine directly, so the key stays on the server and the pages still work when you open Jellyfin remotely.

Start from the official template, [jellyfin-plugin-template](https://github.com/jellyfin/jellyfin-plugin-template). Target the .NET version and `Jellyfin.Controller` package version that match your server; the names below should be checked against that version.

**Project layout**

```text
Jellyfin.Plugin.MediaDownloader/
  Plugin.cs                  BasePlugin<PluginConfiguration>, IHasWebPages
  PluginServiceRegistrator.cs  registers EngineClient, Outbox, OutboxWorker
  Configuration/PluginConfiguration.cs
  Api/MediaDownloaderController.cs
  Engine/EngineClient.cs     HttpClient wrapper for the engine API
  Engine/Outbox.cs           jobs not yet delivered (Part 4)
  Engine/OutboxWorker.cs     IHostedService that retries delivery
  Web/overview.html + .js
  Web/add.html + .js
  Web/title.html + .js       Choose episodes screen
  Web/movie.html + .js
  Web/queue.html + .js
  Web/settings.html + .js
```

**Dashboard pages.** `Plugin.GetPages()` returns one `PluginPageInfo` per HTML and JS file, embedded as resources. Setting `EnableInMainMenu = true` on the Overview page gives the plugin its own entry in the dashboard sidebar. Pages link to each other with `Dashboard.navigate('configurationpage?name=MediaDownloaderQueue')`. Each page calls the plugin's controller with `ApiClient.fetch(...)`, which sends the signed-in admin's token.

| Screen from the canvas | Page | Controller calls |
| --- | --- | --- |
| Overview | `overview.html` | `GET Health`, `GET Queue` |
| Add title | `add.html` | `GET Search` |
| Choose episodes | `title.html` | `GET Title`, `POST Jobs` |
| Movie | `movie.html` | `GET Title`, `POST Jobs` |
| Queue | `queue.html` | `GET Queue`, pause/resume/stop/retry, `GET Waiting` |
| Settings | `settings.html` | Plugin configuration, `GET Libraries`, `GET`/`PUT EngineSettings` |

**Controller.** `[Route("MediaDownloader")]` with `[Authorize(Policy = "RequiresElevation")]`, so only admins can use it. Most actions forward to the engine through `EngineClient`. Three do real work in Jellyfin:

- `GET Libraries` calls `ILibraryManager.GetVirtualFolders()`. Each result has a name, an id, a collection type (`tvshows`, `movies`) and its current `Locations`, the drive folders you added to that library.
- `GET Title` gets the episode list from the engine, then marks each episode "In library" by querying Jellyfin's own items for that series (season and episode numbers). Jellyfin already knows what is on every drive, so the engine doesn't need to scan the NAS.
- `POST Jobs` adds the chosen library's current `Locations` to the job, then puts it in the outbox (Part 4).

**Configuration.** `PluginConfiguration` holds the engine URL, the engine API key, and which Jellyfin library each type goes to (TV, Movies, Anime, stored as library ids). Anime is normally a second `tvshows` library, so this mapping must be picked in Settings rather than guessed from the collection type. It also holds the free-space reserve and fill mode from Part 5.

**Library refresh.** When the engine finishes filing a file, it calls Jellyfin's built-in `POST /Library/Media/Updated` with the file's path, using an API key made under Dashboard → API Keys. Jellyfin then scans just that folder instead of the whole library.

**Installing.** Build with `dotnet publish -c Release`, copy the DLL into a folder under Jellyfin's `plugins` directory (for example `/var/lib/jellyfin/plugins/MediaDownloader_1.0.0.0/`), and restart Jellyfin. Later you can host your own plugin repository so updates install from Dashboard → Plugins.

## Part 3 — VPN: nothing downloads without Mullvad

The rule: the engine makes no outside request unless Mullvad is confirmed up. Jobs are still accepted and kept in the queue, then start by themselves when the VPN returns. Two layers enforce this, so a bug in one doesn't leak.

**Layer 1 — Mullvad app settings on the engine PC.** This is the real guarantee, because it works even if our code is wrong.

- **Launch app on start-up** and **Auto-connect**: on.
- **Lockdown mode**: on. The system blocks all internet traffic whenever the tunnel is down, including before the Mullvad app has started.
- **Local network sharing**: on. Without it Mullvad also blocks the LAN, so the engine can't reach the NAS or Jellyfin, and the plugin can't reach the engine.

**Layer 2 — the engine code.** Parts of this already work:

- `vpn.js` starts as "unknown" and counts that as disconnected, so the engine fails closed at startup.
- When the VPN drops, `queue.js` aborts active downloads, keeps the `.part` file and marks the item `paused`. That abort does not use up a retry, and the item resumes on reconnect.

These gaps need fixing:

1. **Bug: the Mullvad CLI check reads "Disconnected" as connected.** `_checkCli()` in `vpn.js` tests `out.includes('connected')` first, and "disconnected" contains "connected". With Lockdown on, the web check fails when the tunnel is down, so this fallback is exactly what runs, and it answers wrong. Test for disconnected and connecting first, or match `^connected` at the start of a line.
2. **Only the download step waits for the VPN.** Episode detection (`bulk.detectEpisodes`), the daily watcher pass, the discovery windows, and the new search and title endpoints all go online without checking. Add one helper, `await vpn.waitUntilConnected()`, at the top of each. Search and title requests should return `503 vpn_down` immediately so the plugin can say why.
3. **Discovery keeps running through a drop.** `discoverwindow.js` has no abort hook, so a page mid-load just times out. That counts as a failed attempt and can end up marked failed. On a VPN `status` event with `connected: false`, call `discoverwindow.destroyAll()` and treat what it throws as an abort, not a failure.
4. **The VPN can be switched off in config.** In `--engine` mode ignore `config.vpn.enabled` and always require Mullvad. On the Settings screen, show the VPN requirement as a status line rather than a checkbox.

**What the user sees.** `/api/health` reports `vpn.connected` and the exit server. The plugin shows a red banner, "Engine online · Mullvad down — 14 items on hold", and the queue items stay Queued rather than Failed.

## Part 4 — When the engine is offline

If the engine PC is off or unreachable, the plugin keeps your requests and delivers them when it returns. Nothing is lost and nothing downloads from the Jellyfin machine.

**How it works**

1. `POST Jobs` writes the job to the plugin's outbox first: a JSON file in the plugin's data folder, one entry per `jobId`, with state `waiting-to-send`.
2. `OutboxWorker` (an `IHostedService`) tries to send waiting jobs every 30 seconds, and right away after a new job is added.
3. On a `2xx` from the engine the job's state becomes `sent`. On a timeout or refused connection it stays `waiting-to-send` and is retried. Because the engine ignores a `jobId` it already has, a retry after a lost reply never queues twice.
4. On a `4xx` (bad request) the job is marked `rejected` with the engine's message, shown on the Queue screen, and not retried.

**States the user sees**

| Engine | Mullvad | Banner | What happens |
| --- | --- | --- | --- |
| Offline | Unknown | "Engine offline — 3 requests waiting to send" | Jobs wait in the plugin's outbox |
| Online | Down | "Mullvad down — 14 items on hold" | Jobs accepted; the engine queue stays paused |
| Online | Up | None; the green pills on the top bar | Downloads run |

The engine side already survives restarts: `queue.js` saves `queue-manifest.json` and rebuilds the queue on launch, and half-finished `.part` files resume.

While the engine is offline, search and the episode list can't load, because both come from the engine. The Add title screen should say so and offer to retry, rather than showing an empty result.

## Part 5 — Library-aware storage

You choose a library, not a drive. Each job carries the library's current folder list from Jellyfin, so when a drive fills up you add a new drive folder to that library in Jellyfin and nothing else changes. The engine picks the drive when the file is finished, because only then is its exact size known.

&#91;embedded content: drive picking · 2 decisions, 1 hold\]

A series stays on its drive while that drive has room; otherwise it spills to the next folder, and nothing is ever written to a missing mount.

**1. Download to staging first.** The engine downloads and verifies into a local folder on its own disk, for example `~/MediaDownloader/staging`. In `queue.js`, set each item's `outputRoot` to the staging folder, then add a new `placing` step after `verifying`. The NAS never holds a half-written file, Jellyfin never scans one, and no drive fills up halfway through a download.

**2. Map Jellyfin paths to engine paths.** Jellyfin might see a drive as `/mnt/disk1/anime`, while the engine PC mounts the same share at `/mnt/nas/disk1/anime`. The engine keeps a list of prefix pairs (Jellyfin path → engine path). Jobs and reports always use Jellyfin paths; the engine converts only when it touches the disk.

**3. Pick a drive** (new `src/main/placer.js`):

1. Drop any folder that isn't mounted or isn't writable. Check for a marker file, `.mediadownloader`, that you create once in each library folder. If a NAS share drops, its mount point is an empty folder on the engine's own disk, and without this check files would silently land there.
2. Read free space with `fs.statfsSync(path)` (available blocks × block size), the same call `main.js` already uses for `/dev/shm`. A folder "has room" when free space is at least the file size plus a reserve (setting, e.g. 50 GB).
3. **Existing series:** if a folder already has this show's folder (reuse `organizer.js`'s series-name matching) and has room, use it. That keeps a series on one drive.
4. **New series or movie:** use the first folder with room, in the library's order ("fill in order"), or the one with the most free space ("spread out"). Fill mode is a setting. For a new series, require room for the rest of its queued episodes too, estimated from the average size of its finished episodes.
5. **Series drive full:** use the next folder with room. Jellyfin merges same-named show folders across a library's folders into one show, so a split series still appears as one.
6. **Nothing fits:** mark the item `no-space`, keep it in staging, retry every hour, and show "Anime library is full — add a drive in Jellyfin".

**4. Move it safely.** Copy to `<final name>.partial` on the chosen drive, flush it, check the size matches, then rename to the final name. The rename happens within one drive, so Jellyfin sees either nothing or the whole file. Delete the staging copy, then call `POST /Library/Media/Updated` with the Jellyfin path.

**5. Don't download what you already have.** Covered in full in Part 6 below: every drive folder of every library is checked before anything is queued.

**Settings screen changes.** Under Libraries, show each library with its drive folders and a free-space bar per drive. Add the reserve, the fill mode and the path mappings. Drop the fixed `/media/...` paths from the mock-up.

## Part 6 — No duplicates across library drives

Nothing is downloaded if it is already on any library drive, and the page says so before you click. The check covers every folder of every library (TV shows, Movies and Anime), because a show can sit in Anime while you are adding it to TV shows.

**Three places are checked, in this order:**

1. **Jellyfin's database**, by TMDB id first, then by name and year. This catches a show whose folder is spelled differently from the site's title.
2. **The drives themselves**, via `organizer.existingEpisodeFile` looped over every mapped folder. It already matches series folders loosely (`seriesKey` ignores case and a trailing "Season N") and recognises both `S2E5` and the older `Season 2 - Episode 05` file names. This catches files Jellyfin has not scanned yet.
3. **The engine's own work**: the queue, staging and the plugin outbox. This stops the same episode from being queued twice.

**What each result means**

| Result | Meaning | What happens |
| --- | --- | --- |
| In library | File exists at 1080p or better | Not downloadable; shown greyed with its path |
| In library, low quality | File exists below 1080p | Offered as "Replace with 1080p"; same name, same folder |
| Already queued | In the queue, staging or outbox | Not downloadable; links to the queue item |
| Missing | None of the above | Selectable |

**What you see on screen.** Search results carry a badge ("In library", "12 of 36 in library", "Queued"). The movie page shows a banner with the library, drive and file path, and the Download button becomes "Already in library". The episode picker shows a banner with the count and greys out owned episodes. If the title lives in a different library than the one picked, the banner says so and the save target switches to where it already is, so a series never ends up split across two libraries.

**The engine enforces it too.** A new endpoint, `POST /api/library/check`, takes a title (TMDB id, name, year, kind) and returns the status of each episode with its path and height. The plugin calls it before it shows any title. At queue time the engine runs the same check again, so a job sent from `curl`, an old outbox entry or a second browser tab still cannot create a duplicate. Skipped items are logged as "Already in library: Starfall Academy S2E3.mp4 (disk1)" and counted in the job summary.

## Part 7 — Library quality check (1080p)

A new **Quality check** page lets you pick a series folder, a season folder, a movie folder or a whole library. The engine checks every video in it and replaces anything below 1080p with a 1080p copy under the same name.

1. **Walk the folder.** For a series, go into each `Season N` folder, plus loose episodes in the series folder itself (older libraries). For a library, treat each subfolder as a series or movie.
2. **Match each file to a title.** Parse season and episode with the same patterns `existingEpisodeFile` uses (`S2E5` and `Season 2 - Episode 05`). A movie is the single video in its folder. Files that don't parse go on a "Can't match" list; nothing is done to them.
3. **Measure it.** Run `verify.verifyFile` (ffprobe) and read the real height. The file name is not trusted.
4. **Replace low-quality files.** Each file below 1080p becomes a replacement job. It downloads to staging, must pass the normal 1080p verify, and then replaces the old file by copy-to-`.partial` and rename, so the name and folder stay exactly the same. The old file is deleted only after the new one is in place. The existing `existingKeepsEpisode` rule in `bulk.js` already treats a low-quality file as not owned, so the queue side needs no new logic.
5. **Report gaps too.** Compare the files found with the TMDB episode list (Part 8) and list missing episodes, with a button to queue them.

**Options on the page:** replace automatically, or show the list and let me tick which to replace; include Specials (Season 0) or not; the quality floor (1080p by default).

**Endpoints:** `POST /api/scan` with a Jellyfin path returns a `scanId`; `GET /api/scan/{id}` returns progress and each file's height, status and action. Scans run one at a time and pause while downloads verify, so ffprobe does not compete with the queue.

## Part 8 — Complete seasons on Vidsrc

Vidsrc (vidsrc.sh and vidsrcme.ru) has no episode list of its own: `vidsrc.js` builds `/embed/tv/{tmdb}-{season}-{episode}` URLs, so the engine must be told how many episodes each season has. Today, when discovery can't count episodes, `bulk.js` falls back to 1–12, which silently misses episode 13 onward.

1. **Take the counts from TMDB**, through Jellyfin's metadata lookup (the same source as Part 2's search). Each season comes with its episode numbers and air dates.
2. **Queue every aired episode**, 1 to N, for each season picked. Unaired episodes are marked "Not aired" and the watcher picks them up after their air date.
3. **Try both mirrors** before failing an episode: vidsrc.sh first, then vidsrcme.ru.
4. **Remove the 1–12 guess.** If no count is available, the job stops with "Episode count unknown" instead of guessing.
5. **Check completeness when a season finishes.** Compare the files on disk with TMDB's list and show "Season 2: 11 of 12, E7 missing" on the Queue and Choose episodes pages, with a one-click re-queue.

## Part 9 — Who can use it

Only users with **"Allow this user to manage the server"** ticked in Jellyfin can download, change settings or touch the queue. Everyone else either doesn't see the plugin at all, or can browse and request titles for an admin to approve. You choose which in Settings.

| What they can do | Server managers | Other users, "Hidden" | Other users, "View and request" |
| --- | --- | --- | --- |
| See the plugin | Yes | No | Yes, the Request page only |
| Search titles, see "In library" | Yes | No | Yes |
| See the queue | Yes | No | Only their own requests' progress |
| Download, pause, cancel, retry | Yes | No | No |
| Quality check, Settings | Yes | No | No |
| Request a title | Not needed | No | Yes, goes to Requests for approval |

**The server enforces it, not the page.** In the plugin's controller, every endpoint that changes something (jobs, queue actions, scans, settings, approving requests) carries `[Authorize(Policy = Policies.RequiresElevation)]`, which only passes for server managers. Read-only endpoints (search, library check, request status) and `POST /Requests` carry plain `[Authorize]`, and return 403 when the access setting is "Hidden". Hiding a button is only for looks; a non-admin who calls the API directly still gets 403.

**Where each page lives.** The admin pages stay in the Dashboard, which Jellyfin already limits to server managers. The Request page is a separate page added to the main menu with `EnableInMainMenu = true`, shown only when the access setting allows it. Check early on your Jellyfin version that a non-admin can open a plugin page from the main menu; if not, serve the Request page from the plugin's controller as a plain page instead.

**Requests and approval.** A request stores who asked, the title (TMDB id), and what they asked for: the movie, whole series, or chosen seasons. It runs the Part 6 duplicate check first, so nobody can request something already in the library or already queued. Admins see new requests on a Requests page with a count on the nav, and approve (which becomes a normal job), edit the scope then approve, or decline with a short reason. The requester sees Pending, Approved, Downloading, Available or Declined on their Request page. Limits per user (for example 5 open requests) are a setting.

## Part 10 — Staging space and notifications

**Staging disk space on Overview.** The engine adds `staging: { path, freeBytes, totalBytes, reservedBytes }` to `/api/health`, read with `fs.statfsSync`. `reservedBytes` is the expected size of every running download plus everything waiting in `no-space`. Overview shows a bar with used, reserved and free space. Below 50 GB free (a setting) the engine starts no new downloads, the queue says "Paused: staging disk low", and a notification goes out.

**Notifications.** Settings takes an ntfy topic URL and/or a Discord webhook URL, with a Send test button and a checkbox per event:

| Event | Default | Example message |
| --- | --- | --- |
| Series or season finished | On | Starfall Academy Season 2: 12 of 12 downloaded |
| Movie finished | On | Stargazer Lines is in Movies |
| Item failed after all retries | On | Starwake S1E4 failed: all 3 sources timed out |
| Library out of room | On | Anime library is full, add a drive in Jellyfin |
| Staging disk low | On | Staging has 38 GB free, downloads paused |
| VPN down, downloads paused | On | Mullvad disconnected, downloads paused |
| New request waiting | On | Sam requested Star Relay (Season 1) |
| Duplicate skipped | Off | 4 episodes already in library, skipped |

The engine sends them, not the plugin, so they still arrive while the Jellyfin server is off. Messages of the same kind within 10 minutes are grouped into one.

## Part 11 — Library safety: never overwrite, never lose a file

The current engine can overwrite or delete a good library file in some cases, and it misses shows you already have that it didn't download itself. Fix all of this before the engine is allowed to write to the NAS.

**Risks in today's code**

| Where | What happens | Fix |
| --- | --- | --- |
| `queue.js` \~line 357 | If ffprobe can't read an existing file (NAS asleep, network blip, 30 s timeout), the file counts as bad. It is downloaded again and renamed over the good one. | Split "can't read" from "bad". Can't read means skip and retry later, never replace. |
| `queue.js` \~line 568 | When a new download comes back below 1080p, it deletes `finalPath`, which can be an existing library file. | Only ever delete the `.part` file. |
| `queue.js` \~line 577–581 | For a replacement, the old file is deleted before the new one is moved in. If the move fails, both are gone. | Move the new file into place first, then move the old one to the recycle bin. |
| `queue.js` \~line 581 | `renameSync` silently replaces anything already at the target, including a file another job just finished. | Refuse to write over an existing file unless it is the recorded replacement target. Lock each target path so two jobs can't write the same episode. |
| `organizer.existingEpisodeFile` | Only sees `.mp4`, needs `S2E5` right before the extension, and matches folder names exactly. It misses `Show (2019)/Season 02/Show - S02E05 - Title.mkv`, the normal Jellyfin layout. | Match `.mkv`, `.avi`, `.m4v` and `.ts`, find `SxxEyy` anywhere in the name, ignore `(year)` and `[tmdbid-…]` in folder names, and treat `S01E01-E02` files as two episodes. Jellyfin's database stays the first check (Part 6). |

**Rules the engine follows from now on**

1. **Nothing is deleted.** Files the engine replaces go to `.mediadownloader-trash/` on the same drive with the date. The trash is kept for 30 days, then emptied.
2. **Only files the engine made are ever replaced.** Every file it places is written to a ledger (path, size, hash of the first 1 MB, date). A file that isn't in the ledger is never replaced automatically. The Quality check lists it, and you tick it by hand.
3. **Every write and move is logged** in an audit log with date, path, action and reason, so you can always answer "what touched this show?"
4. **Read-only mode.** A Settings switch lets the engine read the library drives without writing to them. Use it for the first week, and for the first Quality check of an existing library.
5. **Snapshots are the last safety net.** If the NAS supports snapshots (ZFS, Btrfs, Unraid with ZFS), turn on daily snapshots of the media shares. The engine can't cause damage a snapshot can't undo.

**Tests to write first.** Build a small fake library with awkward names (years, `.mkv`, `Season 02`, two-part episodes, a folder with no marker file). Then prove four things: no file outside staging and trash is ever deleted; a readable 1080p file is never downloaded again; an unreadable file is left alone; and two jobs for the same episode produce one file.

## Part 12 — Running unattended

It can't be zero-maintenance, because the video sites change their pages every few weeks and adapters will break. The aim is that it never damages the library, and that it tells you when something is wrong, so silence means everything is fine.

- **A daily "all good" message.** One ntfy or Discord message a day listing what was added, what failed and free space. If it doesn't arrive, something is down.
- **A dead man's switch.** The engine pings a [healthchecks.io](https://healthchecks.io) check (or a self-hosted one) every 5 minutes. If the pings stop, you get an alert even when the whole engine PC is off.
- **Watch site adapters.** Track each site's success rate. After 5 failures in a row, turn that site off automatically, send a notification, and fall back to the next source.
- **Auto-restart.** systemd `Restart=always` for the engine, plus a watchdog that restarts it when the queue hasn't moved for 2 hours with work waiting.
- **Log rotation.** Keep 14 days of logs so the disk never fills with them.
- **Version check.** The plugin checks the engine's API version on connect, and shows "Update the engine" rather than failing in odd ways.
- **Weekly self-check.** Once a week, run a read-only Quality check of every library and send the result: files below 1080p, missing episodes, unreadable files.

## Build order

Hand these to your AI one phase at a time. Each phase ends with something you can test before the next one starts.

1. **Make the engine safe.** Commit the current working tree on a branch first: it has 15 changed and 9 new files, including the new site adapters. Then fix the Mullvad CLI check and put the VPN wait in front of every network entry point (Part 3).
   - Done when: with Mullvad disconnected, starting a batch and letting the watcher run produce no outside traffic, and the log says "waiting for VPN".
2. **Library safety.** Fix the five risks in Part 11, add the trash folder, ledger, audit log and read-only mode, and write the fake-library tests.
   - Done when: every Part 11 test passes, and a read-only run against a copy of one real show folder reports every existing episode as "In library".
3. **Engine HTTP API.** Add `service.js`, `api.js` and the `--engine` flag. Start with `health`, `queue` and `jobs` for a pasted URL.
   - Done when: `curl` from the Jellyfin machine can queue a season and watch it download.
4. **Staging and drive picking.** Add the staging folder, `placer.js`, path mappings, marker files and the Jellyfin refresh call (Part 5).
   - Done when: with a small test library of two folders and a reserve set so the first is "full", a new series lands in the second folder and appears in Jellyfin within a minute.
5. **Duplicate check and complete seasons.** Loop `existingEpisodeFile` over every mapped folder, add `POST /api/library/check`, take episode counts from TMDB and remove the 1–12 guess (Parts 6 and 8).
   - Done when: re-queuing a series that is half on disk1 and half on disk2 queues only the missing episodes, and a 24-episode Vidsrc season queues all 24.
6. **Plugin skeleton.** Add the Settings page (engine URL and key, library mapping), the Overview page with health, and the outbox (Part 4).
   - Done when: turning the engine PC off, adding a job, and turning it back on delivers the job exactly once.
7. **Access rules.** Put the elevation policy on every changing endpoint and the access setting on the read ones before any other page exists (Part 9).
   - Done when: a non-admin account gets 403 from every queue, job, scan and settings call, even with `curl`.
8. **Queue and Choose episodes pages.** Start from a pasted URL, because episode detection already exists.
   - Done when: ticking eight episodes queues exactly those eight, with their dub status shown.
9. **Search and Movie pages.** Add a `search()` to each site adapter and build the Add title page.
10. **Quality check page.** Add the scan endpoints and the page (Part 7).
    - Done when: scanning a season with one 720p episode replaces only that file, under the same name, and Jellyfin still shows one copy.
11. **Keep watching and Waiting for dub pages,** then polish.
12. **Staging space, notifications, and requests.** Add the staging bar on Overview, the notification settings, then the Request page and Requests approval page (Parts 9 and 10).
    - Done when: a non-admin requests a series, gets no download button, the admin gets a notification, approves it, and the requester sees it become Available.

## What you're missing

The biggest gap is **using TMDB as the source of truth for titles**. Everything else on this list is smaller but will bite later.

- **Search Jellyfin's TMDB metadata, not the video sites.** Site search results have messy names, no year and poor posters, so Jellyfin will misidentify files. Search through Jellyfin's own metadata lookup (the one behind Identify) instead. That gives the proper name, year, poster, TMDB id and the full season and episode list with air dates. The engine then finds sources by that name or id. `vidsrc.js` already builds URLs from a TMDB id, so it can take the id directly. This also makes the "Not aired" badges real.
- **Anime numbering.** Sites often list a later season as its own show, or number episodes straight through (episode 25 instead of S02E01). TMDB and Jellyfin number by season. You need a mapping step, or files will land in the wrong season.
- **Pooled NAS storage.** If your NAS pools its drives (Unraid shares, mergerfs, RAID or ZFS), each library has one folder and the NAS already picks the drive. Part 5's drive picking only matters if each library lists separate drive folders.
- **File permissions on the NAS.** Files the engine writes over NFS or SMB must be readable by the user Jellyfin runs as. Set the share's user, group and umask once, or new files won't show up.
- **The engine must survive reboots.** It's an Electron app, so it needs a display: use `xvfb-run` under a systemd user service, and run `loginctl enable-linger` so it  starts without anyone logging in.
- **Lock down the engine API.** Bind it to the LAN, allow only the Jellyfin server's IP in the firewall, and require the API key. Anyone who can reach it can make that PC download anything.
- **Backups.** Add the plugin's outbox file and the engine's `engine.json` and path mappings to the backup list in your README.
- **Legal risk.** Downloading from these sites can infringe copyright where you live. A VPN hides your traffic, not the legality of what you download.
