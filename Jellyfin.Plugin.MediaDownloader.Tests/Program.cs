using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.MediaDownloader;
using Jellyfin.Plugin.MediaDownloader.Configuration;
using Jellyfin.Plugin.MediaDownloader.Engine;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Jellyfin.Plugin.MediaDownloader.Tests
{
    // ---- Minimal fakes so the real plugin + engine client can run headless ----

    internal sealed class FakeApplicationPaths : IApplicationPaths
    {
        private readonly string _root;
        public FakeApplicationPaths(string root)
        {
            _root = root;
            foreach (var sub in new[] { "data", "config", "plugins", "cache", "log", "temp", "web" })
                Directory.CreateDirectory(Path.Combine(_root, sub));
        }
        public string ProgramDataPath => Path.Combine(_root, "data");
        public string WebPath => Path.Combine(_root, "web");
        public string ProgramSystemPath => _root;
        public string DataPath => Path.Combine(_root, "data");
        public string ImageCachePath => Path.Combine(_root, "cache", "images");
        public string PluginsPath => Path.Combine(_root, "plugins");
        public string PluginConfigurationsPath => Path.Combine(_root, "config", "plugins");
        public string LogDirectoryPath => Path.Combine(_root, "log");
        public string ConfigurationDirectoryPath => Path.Combine(_root, "config");
        public string SystemConfigurationFilePath => Path.Combine(_root, "config", "system.xml");
        public string CachePath => Path.Combine(_root, "cache");
        public string TempDirectory => Path.Combine(_root, "temp");
        public string VirtualDataPath => Path.Combine(_root, "virtual");

        // Added to IApplicationPaths in Jellyfin 10.11 / 12.0; harmless extras
        // on the 10.10 (net8.0) target where the interface lacks them.
        public string TrickplayPath => Path.Combine(_root, "trickplay");
        public string BackupPath => Path.Combine(_root, "backup");
        public void MakeSanityCheckOrThrow() { }
        public void CreateAndCheckMarker(string a, string b, bool c) { }
    }

    internal sealed class FakeXmlSerializer : IXmlSerializer
    {
        public object DeserializeFromStream(Type type, Stream stream) => Activator.CreateInstance(type);
        public void SerializeToStream(object obj, Stream stream) { }
        public void SerializeToFile(object obj, string file) { }
        public object DeserializeFromFile(Type type, string file) => Activator.CreateInstance(type);
        public object DeserializeFromBytes(Type type, byte[] bytes) => Activator.CreateInstance(type);
    }

    internal static class Program
    {
        private static int _passed;
        private static int _failed;

        private static void Check(string name, bool cond, string extra = null)
        {
            if (cond) { _passed++; Console.WriteLine("PASS  " + name); }
            else { _failed++; Console.WriteLine("FAIL  " + name + (extra != null ? "  -- " + extra : "")); }
        }

        // Set the plugin's static Instance (private setter) to simulate
        // Jellyfin's load ordering relative to service registration.
        private static void SetInstance(MediaDownloaderPlugin instance)
        {
            var prop = typeof(MediaDownloaderPlugin).GetProperty("Instance",
                System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic);
            prop.SetValue(null, instance);
        }

        private static async Task<bool> WaitFor(Func<bool> pred, int timeoutMs = 15000)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                if (pred()) return true;
                await Task.Delay(200);
            }
            return pred();
        }

        private static JsonElement Parse(string json) =>
            JsonSerializer.Deserialize<JsonElement>(json);

        private static async Task<int> Main(string[] args)
        {
            var engineUrl = Environment.GetEnvironmentVariable("ENGINE_URL") ?? "";
            var engineKey = Environment.GetEnvironmentVariable("ENGINE_KEY") ?? "";
            if (string.IsNullOrWhiteSpace(engineUrl) || string.IsNullOrWhiteSpace(engineKey))
            {
                Console.WriteLine("FAIL  harness requires ENGINE_URL and ENGINE_KEY env vars");
                return 1;
            }

            var tempRoot = Path.Combine(Path.GetTempPath(), "wvd-plugin-test-" + Guid.NewGuid().ToString("N"));
            var paths = new FakeApplicationPaths(tempRoot);
            var plugin = new MediaDownloaderPlugin(paths, new FakeXmlSerializer());

            // The Configuration setter is protected; the getter lazy-loads a
            // default instance (no config file in our temp dirs). Mutate that
            // cached instance in place - EngineClient reads it per request.
            var cfg = plugin.Configuration;
            cfg.EngineUrl = engineUrl;
            cfg.EngineApiKey = engineKey;
            cfg.TvLibrary = "Anime";
            cfg.MoviesLibrary = "Movies";
            cfg.AnimeLibrary = "";
            cfg.DefaultMinHeight = 1080;
            cfg.DefaultMode = "dub";

            var outboxDir = Path.Combine(tempRoot, "outbox");
            Directory.CreateDirectory(outboxDir);
            var outbox = new Outbox(outboxDir);
            var engine = new EngineClient(plugin);
            var worker = new OutboxWorker(outbox, engine, NullLogger<OutboxWorker>.Instance);

            // The controller stamps jobId into the payload before it hits the
            // outbox; mirror that here so the engine dedupes by the same key.
            string ValidJob(string jobId) => $@"{{
                ""jobId"": ""{jobId}"",
                ""kind"": ""series"",
                ""title"": ""Plugin ITG Show"",
                ""sourceUrl"": ""https://example.invalid/watch/plugin-itg/ep-1"",
                ""mode"": ""dub"",
                ""minHeight"": 1080,
                ""library"": {{ ""id"": ""lib1"", ""name"": ""Anime"", ""locations"": [""\\\\nas\\anime""] }},
                ""scope"": ""episodes"",
                ""selections"": [ {{ ""season"": 1, ""episodes"": [1] }} ],
                ""watch"": false
            }}";
            string BadJob(string jobId) => $@"{{ ""jobId"": ""{jobId}"", ""title"": ""Bad Job No SourceUrl"" }}";

            await worker.StartAsync(CancellationToken.None);
            try
            {
                // Reachability sanity (engine should be up for the online cases).
                Check("engine reachable via plugin client", await engine.IsReachableAsync(), "ENGINE_URL=" + engineUrl);

                // ---- A: engine OFFLINE -> job stays waiting-to-send ------------
                cfg.EngineUrl = "http://127.0.0.1:1"; // nothing listening
                outbox.Add("itg-off", Parse(ValidJob("itg-off")), "Offline job");
                worker.Notify();
                var attempted = await WaitFor(() => (outbox.Get("itg-off")?.Attempts ?? 0) >= 1);
                Check("A: offline job was attempted", attempted, "attempts=" + (outbox.Get("itg-off")?.Attempts ?? 0));
                Check("A: offline job stays waiting-to-send", outbox.Get("itg-off")?.State == Outbox.StateWaitingToSend,
                    "state=" + outbox.Get("itg-off")?.State);
                outbox.Remove("itg-off"); // don't let later passes deliver it

                // ---- B: engine ONLINE -> delivered, marked sent ---------------
                cfg.EngineUrl = engineUrl;
                outbox.Add("itg-1", Parse(ValidJob("itg-1")), "Delivered job");
                worker.Notify();
                var sent = await WaitFor(() => outbox.Get("itg-1")?.State == Outbox.StateSent);
                Check("B: online job delivered -> sent", sent, "state=" + outbox.Get("itg-1")?.State + " msg=" + outbox.Get("itg-1")?.LastEngineMessage);

                // ---- C: engine 4xx -> rejected with message -------------------
                outbox.Add("itg-bad", Parse(BadJob("itg-bad")), "Bad job");
                worker.Notify();
                var rej = await WaitFor(() => outbox.Get("itg-bad")?.State == Outbox.StateRejected);
                Check("C: 4xx job -> rejected", rej, "state=" + outbox.Get("itg-bad")?.State + " msg=" + outbox.Get("itg-bad")?.LastEngineMessage);
                Check("C: rejected carries engine message", !string.IsNullOrEmpty(outbox.Get("itg-bad")?.LastEngineMessage),
                    "msg=" + outbox.Get("itg-bad")?.LastEngineMessage);

                // ---- D: re-deliver an accepted jobId (exactly-once) -----------
                outbox.Add("itg-1", Parse(ValidJob("itg-1")), "Delivered job (retry)");
                worker.Notify();
                var resent = await WaitFor(() => outbox.Get("itg-1")?.State == Outbox.StateSent);
                Check("D: re-delivery of accepted jobId -> sent again", resent, "state=" + outbox.Get("itg-1")?.State);
                // (The engine-side guarantee - that it is queued exactly once -
                //  is asserted by the Node driver, which inspects the engine.)
            }
            finally
            {
                try { await worker.StopAsync(CancellationToken.None); } catch { }
                (worker as IDisposable)?.Dispose();
            }

            // ---- E: DI wiring (the real Jellyfin startup path) ----------------
            // Reproduces the production crash: RegisterServices runs before the
            // plugin instance exists, then the hosted service is built. The old
            // code captured the (null) Instance and NRE'd in the Outbox factory.
            // The fix resolves it lazily with an IApplicationPaths fallback, so
            // BOTH orderings below must succeed.
            {
                var diRoot = Path.Combine(Path.GetTempPath(), "wvd-plugin-di-" + Guid.NewGuid().ToString("N"));
                var diPaths = new FakeApplicationPaths(diRoot);
                var expectedDir = Path.Combine(diPaths.PluginsPath, "Media Downloader");

                // E1: the plugin instance exists by the time the hosted service is built.
                SetInstance(null);
                var coll = new ServiceCollection();
                coll.AddSingleton<IApplicationPaths>(diPaths);
                coll.AddSingleton<ILogger<OutboxWorker>>(NullLogger<OutboxWorker>.Instance);
                new PluginServiceRegistrator().RegisterServices(coll, null);
                var provider = coll.BuildServiceProvider();
                new MediaDownloaderPlugin(diPaths, new FakeXmlSerializer()); // Jellyfin loads it
                bool e1Threw = false;
                bool e1Found = false;
                try
                {
                    // The production path: Jellyfin's Host resolves IEnumerable<IHostedService>
                    // at startup (AddHostedService registers IHostedService, not the concrete
                    // type) - the original NRE happened while building exactly this collection.
                    foreach (var svc in provider.GetRequiredService<IEnumerable<IHostedService>>())
                    {
                        if (svc is OutboxWorker) { e1Found = true; break; }
                    }
                }
                catch (Exception ex) { e1Threw = true; Console.WriteLine("   E1 exception: " + ex.GetType().Name + ": " + ex.Message); }
                Check("E1: hosted service resolves (no NRE at startup)", !e1Threw && e1Found);
                provider.Dispose();

                // E2: instance never set -> data folder must come from IApplicationPaths.
                SetInstance(null);
                Directory.CreateDirectory(expectedDir);
                var coll2 = new ServiceCollection();
                coll2.AddSingleton<IApplicationPaths>(diPaths);
                coll2.AddSingleton<ILogger<OutboxWorker>>(NullLogger<OutboxWorker>.Instance);
                new PluginServiceRegistrator().RegisterServices(coll2, null);
                var provider2 = coll2.BuildServiceProvider();
                var outbox2 = provider2.GetRequiredService<Outbox>();
                outbox2.Add("di-probe", Parse("{}"), "probe");
                Check("E2: outbox resolves without a plugin instance", outbox2 != null);
                Check("E2: outbox.json lands under <plugins>/Media Downloader",
                    File.Exists(Path.Combine(expectedDir, "outbox.json")), expectedDir);
                provider2.Dispose();

                // E3: the controller injects the CONCRETE OutboxWorker (to call
                // Notify()). It must resolve via DI, and it must be the SAME
                // instance the Host starts - AddHostedService<T> alone registers
                // only IHostedService (concrete type 500s) and would otherwise
                // build a second, never-started worker.
                SetInstance(null);
                var coll3 = new ServiceCollection();
                coll3.AddSingleton<IApplicationPaths>(diPaths);
                coll3.AddSingleton<ILogger<OutboxWorker>>(NullLogger<OutboxWorker>.Instance);
                new PluginServiceRegistrator().RegisterServices(coll3, null);
                var provider3 = coll3.BuildServiceProvider();
                new MediaDownloaderPlugin(diPaths, new FakeXmlSerializer()); // Jellyfin loads it
                bool e3Threw = false;
                OutboxWorker e3Concrete = null;
                IHostedService e3Hosted = null;
                try
                {
                    e3Concrete = provider3.GetRequiredService<OutboxWorker>();
                    foreach (var svc in provider3.GetRequiredService<IEnumerable<IHostedService>>())
                    {
                        if (svc is OutboxWorker o) e3Hosted = o;
                    }
                }
                catch (Exception ex) { e3Threw = true; Console.WriteLine("   E3 exception: " + ex.GetType().Name + ": " + ex.Message); }
                Check("E3: concrete OutboxWorker resolves via DI (controller path)", !e3Threw && e3Concrete != null);
                Check("E3: it is the SAME instance the Host starts (one worker)", !e3Threw && ReferenceEquals(e3Concrete, e3Hosted));
                provider3.Dispose();

                // Restore a valid instance for anything that runs after this section.
                new MediaDownloaderPlugin(paths, new FakeXmlSerializer());
            }

            // ---- F: dashboard sidebar pages -------------------------------
            // The web client builds the dashboard sidebar from
            // GET /web/ConfigurationPages?enableInMainMenu=true, so every page
            // we want visible MUST carry the flag - and each page's embedded
            // resource must actually exist in the assembly (a typo 404s in the
            // dashboard).
            {
                var pages = new MediaDownloaderPlugin(paths, new FakeXmlSerializer()).GetPages();
                int count = 0;
                bool allMenu = true;
                bool allRes = true;
                foreach (var p in pages)
                {
                    count++;
                    if (!p.EnableInMainMenu) allMenu = false;
                    if (typeof(MediaDownloaderPlugin).Assembly.GetManifestResourceStream(p.EmbeddedResourcePath) == null)
                    {
                        allRes = false;
                        Console.WriteLine("   F missing resource: " + p.EmbeddedResourcePath);
                    }
                }
                Check("F: plugin declares dashboard pages (settings + overview)", count >= 2);
                Check("F: all pages flagged for the main menu (sidebar)", allMenu);
                Check("F: every page's embedded resource exists in the assembly", allRes);
            }

            Console.WriteLine("HARNESS " + _passed + " passed, " + _failed + " failed");
            return _failed == 0 ? 0 : 1;
        }
    }
}
