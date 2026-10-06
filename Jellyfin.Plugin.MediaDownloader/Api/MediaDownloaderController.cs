using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Mime;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.MediaDownloader.Engine;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaDownloader.Api
{
    /// <summary>
    /// The plugin's control surface (build plan Part 2 + Part 4).
    ///
    /// The browser never talks to the engine directly: every call goes
    /// through this controller, which forwards to the engine with the key
    /// from the plugin configuration. So the key stays on the Jellyfin
    /// server, and the pages still work when Jellyfin is opened remotely.
    ///
    /// [Authorize(Policy = RequiresElevation)] = admins only (Part 9 adds the
    /// finer request/approval rules on top of this).
    /// </summary>
    [ApiController]
    [Authorize(Policy = Policies.RequiresElevation)]
    [Route("MediaDownloader")]
    [Produces(MediaTypeNames.Application.Json)]
    public class MediaDownloaderController : ControllerBase
    {
        private readonly EngineClient _engine;
        private readonly Outbox _outbox;
        private readonly OutboxWorker _worker;
        private readonly ILibraryManager _libraryManager;
        private readonly MediaDownloaderPlugin _plugin;
        private readonly ILogger<MediaDownloaderController> _logger;

        public MediaDownloaderController(
            EngineClient engine,
            Outbox outbox,
            OutboxWorker worker,
            ILibraryManager libraryManager,
            MediaDownloaderPlugin plugin,
            ILogger<MediaDownloaderController> logger)
        {
            _engine = engine;
            _outbox = outbox;
            _worker = worker;
            _libraryManager = libraryManager;
            _plugin = plugin;
            _logger = logger;
        }

        // ------------------------------------------------------------------
        // Health + outbox (the Overview page banner, Part 4)
        // ------------------------------------------------------------------

        [HttpGet("Health")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<IActionResult> Health()
        {
            var counts = _outbox.Counts();
            var outboxInfo = new JsonObject
            {
                ["waiting"] = counts.waiting,
                ["sent"] = counts.sent,
                ["rejected"] = counts.rejected
            };
            try
            {
                var healthJson = await _engine.GetRawAsync("api/health").ConfigureAwait(false);
                var health = JsonNode.Parse(healthJson);
                var json = new JsonObject
                {
                    ["engine"] = "online",
                    ["health"] = health,
                    ["outbox"] = outboxInfo
                }.ToJsonString();
                return Content(json, MediaTypeNames.Application.Json);
            }
            catch (Exception ex)
            {
                // Offline is a normal state (the engine PC may be off): report
                // it, don't throw. The banner shows the waiting count.
                var json = new JsonObject
                {
                    ["engine"] = "offline",
                    ["error"] = FriendlyOfflineError(ex),
                    ["outbox"] = outboxInfo
                }.ToJsonString();
                return Content(json, MediaTypeNames.Application.Json);
            }
        }

        // ------------------------------------------------------------------
        // Libraries (Jellyfin's own answer for "where does each type go")
        // ------------------------------------------------------------------

        [HttpGet("Libraries")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public IActionResult Libraries()
        {
            // Anime lands in a boxsets or tvshows library; TV in tvshows; movies
            // in movies. (Jellyfin 10.10 has no "other"/"homevideo" collection
            // type, so those are not part of the filter.)
            var libraries = _libraryManager.GetVirtualFolders()
                .Where(f => f.CollectionType == CollectionTypeOptions.tvshows
                    || f.CollectionType == CollectionTypeOptions.movies
                    || f.CollectionType == CollectionTypeOptions.boxsets)
                .Select(f => new JsonObject
                {
                    ["name"] = f.Name,
                    ["collectionType"] = f.CollectionType.ToString().ToLowerInvariant(),
                    ["locations"] = new JsonArray((f.Locations ?? Array.Empty<string>()).Select(l => (JsonNode)l).ToArray())
                })
                .ToList();
            return Content(new JsonObject { ["libraries"] = new JsonArray(libraries.ToArray()) }.ToJsonString(), MediaTypeNames.Application.Json);
        }

        // ------------------------------------------------------------------
        // Jobs: always into the outbox first (Part 4)
        // ------------------------------------------------------------------

        // NOTE: "Jobs" conflicts with an internal Jellyfin 12.x route. Using "Enqueue" instead.
        [HttpPost("Enqueue")]
        [ProducesResponseType(StatusCodes.Status202Accepted)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        public async Task<IActionResult> Enqueue()
        {
            // Read the raw body (avoids [FromBody] JsonElement binding issues in Jellyfin 12.x)
            string rawBody;
            using (var reader = new StreamReader(Request.Body))
            {
                rawBody = await reader.ReadToEndAsync().ConfigureAwait(false);
            }
            if (string.IsNullOrWhiteSpace(rawBody))
            {
                return BadRequest(new { error = "job object required" });
            }
            JsonObject node;
            try
            {
                node = JsonNode.Parse(rawBody) as JsonObject;
            }
            catch (Exception)
            {
                return BadRequest(new { error = "invalid JSON body" });
            }
            if (node == null)
            {
                return BadRequest(new { error = "job object required" });
            }

            var sourceUrl = Str(node, "sourceUrl");
            if (string.IsNullOrWhiteSpace(sourceUrl))
            {
                return BadRequest(new { error = "sourceUrl is required" });
            }

            // jobId: the plugin always makes one, so the outbox has a stable
            // key and the engine's idempotency applies.
            var jobId = Str(node, "jobId");
            if (string.IsNullOrWhiteSpace(jobId))
            {
                jobId = Guid.NewGuid().ToString();
                node["jobId"] = jobId;
            }

            // Defaults from plugin settings.
            if (!node.ContainsKey("minHeight")) node["minHeight"] = _plugin.Configuration.DefaultMinHeight;
            if (!node.ContainsKey("mode")) node["mode"] = _plugin.Configuration.DefaultMode;

            // Library: the job names a library (by name); the controller fills
            // in its CURRENT drive folders, so adding a drive in Jellyfin is
            // all that is needed (Part 5). A job without a library goes to the
            // default for its kind.
            var kind = Str(node, "kind");
            var libName = Str(node, "library");
            if (string.IsNullOrWhiteSpace(libName))
            {
                if (string.Equals(kind, "movie", StringComparison.OrdinalIgnoreCase))
                {
                    libName = _plugin.Configuration.MoviesLibrary;
                }
                else
                {
                    libName = string.IsNullOrEmpty(_plugin.Configuration.AnimeLibrary)
                        ? _plugin.Configuration.TvLibrary
                        : _plugin.Configuration.AnimeLibrary;
                }
            }
            if (string.IsNullOrWhiteSpace(libName))
            {
                return BadRequest(new
                {
                    error = "No library chosen and no default is set - open Settings and pick one."
                });
            }

            string[] locations;
            try
            {
                locations = LibraryLocations(libName);
            }
            catch (KeyNotFoundException ex)
            {
                return BadRequest(new { error = ex.Message });
            }

            node["library"] = new JsonObject
            {
                ["id"] = libName,
                ["name"] = libName,
                ["locations"] = new JsonArray(locations.Select(l => (JsonNode)l).ToArray())
            };

            var title = Str(node, "title");
            if (string.IsNullOrWhiteSpace(title)) title = sourceUrl;

            // Store a detached JsonElement (the referenced System.Text.Json has
            // no JsonNode.ToJsonElement()); deserialize from the node's text.
            _outbox.Add(jobId, JsonSerializer.Deserialize<JsonElement>(node.ToJsonString()), title);
            _worker.Notify(); // deliver right away; stays queued if the engine is off

            return Accepted(new
            {
                accepted = true,
                jobId,
                state = "waiting-to-send",
                summary = new { title = title, library = libName }
            });
        }

        private string[] LibraryLocations(string libName)
        {
            var match = _libraryManager.GetVirtualFolders()
                .FirstOrDefault(f => string.Equals(f.Name, libName, StringComparison.OrdinalIgnoreCase));
            if (match == null)
            {
                var names = string.Join(", ", _libraryManager.GetVirtualFolders().Select(f => f.Name));
                throw new KeyNotFoundException($"Library \"{libName}\" was not found on this server. Available: {names}");
            }
            return (match.Locations ?? Array.Empty<string>()).ToArray();
        }

        /// <summary>
        /// The library set to verify: the named libraries when given, otherwise
        /// every TV/Movies/Anime virtual folder on this server. Each carries its
        /// current locations so the engine can resolve + round-trip them.
        /// </summary>
        private List<JsonObject> ResolveLibraries(string[] names)
        {
            var folders = _libraryManager.GetVirtualFolders()
                .Where(f => f.CollectionType == CollectionTypeOptions.tvshows
                    || f.CollectionType == CollectionTypeOptions.movies
                    || f.CollectionType == CollectionTypeOptions.boxsets)
                .ToList();
            if (names != null && names.Length > 0)
            {
                folders = folders.Where(f => names.Any(n => string.Equals(n, f.Name, StringComparison.OrdinalIgnoreCase))).ToList();
            }
            return folders
                .Select(f => new JsonObject
                {
                    ["name"] = f.Name,
                    ["locations"] = new JsonArray((f.Locations ?? Array.Empty<string>()).Select(l => (JsonNode)l).ToArray())
                })
                .ToList();
        }

        // ------------------------------------------------------------------
        // Outbox (what the Queue screen shows while the engine is offline)
        // ------------------------------------------------------------------

        [HttpGet("Outbox")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public IActionResult OutboxList()
        {
            var (waiting, sent, rejected) = _outbox.Counts();
            var items = _outbox.All()
                .Select(e => new JsonObject
                {
                    ["jobId"] = e.JobId,
                    ["title"] = e.Title,
                    ["state"] = e.State,
                    ["attempts"] = e.Attempts,
                    ["createdAt"] = e.CreatedAt.ToString("o"),
                    ["lastAttemptAt"] = e.LastAttemptAt?.ToString("o"),
                    ["message"] = e.LastEngineMessage
                })
                .ToList();
            return Content(new JsonObject
            {
                ["waiting"] = waiting,
                ["sent"] = sent,
                ["rejected"] = rejected,
                ["items"] = new JsonArray(items.ToArray())
            }.ToJsonString(), MediaTypeNames.Application.Json);
        }

        [HttpDelete("Outbox/{jobId}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public IActionResult OutboxRemove(string jobId)
        {
            var entry = _outbox.Get(jobId);
            if (entry == null) return NotFound(new { error = "no such outbox entry" });
            _outbox.Remove(jobId);
            return Ok(new { removed = true, jobId });
        }

        [HttpPost("Outbox/purge")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public IActionResult OutboxPurge([FromBody] JsonElement body)
        {
            var state = Str(body, "state");
            if (state != Outbox.StateSent && state != Outbox.StateRejected)
            {
                return BadRequest(new { error = "state must be \"sent\" or \"rejected\"" });
            }
            var n = _outbox.Purge(state);
            return Ok(new { purged = n });
        }

        // ------------------------------------------------------------------
        // Queue + waiting + schedules: straight through to the engine
        // ------------------------------------------------------------------

        [HttpGet("Queue")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status502BadGateway)]
        public async Task<IActionResult> Queue() =>
            await ProxyAsync(() => _engine.GetRawAsync("api/queue")).ConfigureAwait(false);

        [HttpPost("Queue/pause")]
        public async Task<IActionResult> QueuePause() =>
            await ProxyAsync(() => _engine.PostAsync("api/queue/pause")).ConfigureAwait(false);

        [HttpPost("Queue/resume")]
        public async Task<IActionResult> QueueResume() =>
            await ProxyAsync(() => _engine.PostAsync("api/queue/resume")).ConfigureAwait(false);

        [HttpPost("Queue/stop")]
        public async Task<IActionResult> QueueStop() =>
            await ProxyAsync(() => _engine.PostAsync("api/queue/stop")).ConfigureAwait(false);

        [HttpDelete("Queue/{int id}")]
        public async Task<IActionResult> QueueRemove(int id) =>
            await ProxyAsync(() => _engine.DeleteAsync($"api/queue/{id}")).ConfigureAwait(false);

        [HttpPost("Queue/{int id}/retry")]
        public async Task<IActionResult> QueueRetry(int id) =>
            await ProxyAsync(() => _engine.PostAsync($"api/queue/{id}/retry")).ConfigureAwait(false);

        [HttpGet("Waiting")]
        public async Task<IActionResult> Waiting() =>
            await ProxyAsync(() => _engine.GetRawAsync("api/waiting")).ConfigureAwait(false);

        [HttpGet("Schedules")]
        public async Task<IActionResult> Schedules() =>
            await ProxyAsync(() => _engine.GetRawAsync("api/schedules")).ConfigureAwait(false);

        [HttpPost("Schedules/check")]
        public async Task<IActionResult> SchedulesCheck() =>
            await ProxyAsync(() => _engine.PostAsync("api/schedules/check")).ConfigureAwait(false);

        [HttpGet("TmdbInfo")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<IActionResult> TmdbInfo([FromQuery] string tmdb, [FromQuery] string type)
        {
            var t = string.IsNullOrEmpty(type) ? "tv" : type;
            return await ProxyAsync(() => _engine.GetRawAsync($"api/tmdb/info?tmdb={Uri.EscapeDataString(tmdb ?? string.Empty)}&type={t}")).ConfigureAwait(false);
        }

        // ------------------------------------------------------------------
        // Title / search / duplicate check (the later pages use these; the
        // endpoints already exist on the engine)
        // ------------------------------------------------------------------

        [HttpGet("Title")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<IActionResult> Title([FromQuery] string url, [FromQuery] string library)
        {
            var path = "api/title?url=" + Uri.EscapeDataString(url ?? string.Empty);
            if (!string.IsNullOrWhiteSpace(library))
            {
                path += "&library=" + Uri.EscapeDataString(library);
            }
            return await ProxyAsync(() => _engine.GetRawAsync(path)).ConfigureAwait(false);
        }

        [HttpGet("Search")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<IActionResult> Search([FromQuery] string q, [FromQuery] string type)
        {
            var t = string.IsNullOrEmpty(type) ? "all" : type;
            return await ProxyAsync(() => _engine.GetRawAsync("api/search?q=" + Uri.EscapeDataString(q ?? string.Empty) + "&type=" + t)).ConfigureAwait(false);
        }

        [HttpPost("LibraryCheck")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<IActionResult> LibraryCheck([FromBody] JsonElement body) =>
            await ProxyAsync(() => _engine.PostAsync("api/library/check", body)).ConfigureAwait(false);

        /// <summary>
        /// Verify a library's drive folders (Settings &gt; Verify drives).
        /// Resolves the library's current locations and asks the engine to do a
        /// real write + read-back round-trip, so the user gets a green/red
        /// answer that the drives really line up before trusting a download.
        /// Optional body { "libraries": ["Anime", "TV Shows"] } narrows the set;
        /// with no names, every TV/Movies/Anime library is checked.
        /// </summary>
        [HttpPost("Verify")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status502BadGateway)]
        public async Task<IActionResult> Verify([FromBody] JsonElement body)
        {
            string[] names = null;
            if (body.ValueKind == JsonValueKind.Object)
            {
                var raw = Str(body, "libraries");
                if (raw.Length > 0)
                {
                    names = raw.Split(',', StringSplitOptions.RemoveEmptyEntries)
                        .Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
                }
            }

            var libs = ResolveLibraries(names);
            var payload = new JsonObject
            {
                ["libraries"] = new JsonArray(libs.Select(l => (JsonNode)l).ToArray())
            };
            var el = JsonSerializer.Deserialize<JsonElement>(payload.ToJsonString());
            return await ProxyAsync(() => _engine.PostAsync("api/library/verify", el)).ConfigureAwait(false);
        }

        // ------------------------------------------------------------------
        // Engine settings (Part 5 settings live in the engine's engine.json;
        // the Settings page edits them through this proxy)
        // ------------------------------------------------------------------

        [HttpGet("EngineSettings")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<IActionResult> EngineSettingsGet() =>
            await ProxyAsync(() => _engine.GetRawAsync("api/settings")).ConfigureAwait(false);

        [HttpPut("EngineSettings")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<IActionResult> EngineSettingsPut([FromBody] JsonElement body) =>
            await ProxyAsync(() => _engine.PutAsync("api/settings", body)).ConfigureAwait(false);

        // ------------------------------------------------------------------
        // Helpers
        // ------------------------------------------------------------------

        /// <summary>
        /// Runs an engine call and turns engine failures into proper HTTP:
        /// the engine's own 4xx/5xx keep their status + message; an
        /// unreachable engine is a 502 with a friendly message.
        /// </summary>
        private async Task<IActionResult> ProxyAsync(Func<Task<string>> call)
        {
            try
            {
                var body = await call().ConfigureAwait(false);
                return Content(body, MediaTypeNames.Application.Json);
            }
            catch (EngineApiException ex)
            {
                return StatusCode(ex.Status, new { error = ex.Message });
            }
            catch (Exception ex)
            {
                return StatusCode(StatusCodes.Status502BadGateway, new { error = FriendlyOfflineError(ex) });
            }
        }

        private static string FriendlyOfflineError(Exception ex)
        {
            if (ex is HttpRequestException or TaskCanceledException)
            {
                return "Engine is offline - the request is waiting in the outbox and will be delivered when it comes back.";
            }
            return "Engine unreachable: " + ex.Message;
        }

        private static string Str(JsonElement el, string prop)
        {
            if (el.ValueKind != JsonValueKind.Object) return string.Empty;
            if (!el.TryGetProperty(prop, out var v)) return string.Empty;
            return v.ValueKind switch
            {
                JsonValueKind.String => v.GetString() ?? string.Empty,
                JsonValueKind.Number => v.GetRawText(),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                JsonValueKind.Array => string.Join(",", v.EnumerateArray().Select(x => x.GetString() ?? string.Empty)),
                _ => string.Empty
            };
        }

        private static string Str(JsonNode node, string prop)
        {
            if (node == null) return string.Empty;
            var v = node[prop];
            return v?.GetValue<string>() ?? string.Empty;
        }
    }
}
