using System;
using System.IO;
using Jellyfin.Plugin.MediaDownloader.Engine;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.MediaDownloader
{
    /// <summary>
    /// Wires the plugin's services into Jellyfin. EngineClient and Outbox are
    /// singletons; OutboxWorker is a hosted service (the Host starts it) AND a
    /// plain singleton (the controller injects it to call Notify()).
    ///
    /// Two ordering traps, both fixed here:
    ///
    /// 1. MediaDownloaderPlugin.Instance is still null while RegisterServices
    ///    runs; capturing it and dereferencing it from a deferred factory
    ///    crashed startup with a NullReferenceException. -> resolve it lazily
    ///    inside the factories (they run later, when the instance exists),
    ///    with an IApplicationPaths fallback so the folder can never be null.
    ///
    /// 2. AddHostedService&lt;T&gt; (modern .NET) registers ONLY IHostedService -
    ///    the concrete type stays unregistered, so the controller's
    ///    OutboxWorker injection fails ("No service for type OutboxWorker"),
    ///    and an IHostedService-&gt;T registration would build a SECOND, never
    ///    started instance. -> register OutboxWorker as the singleton and
    ///    alias IHostedService to that SAME instance.
    /// </summary>
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddSingleton<EngineClient>(sp => new EngineClient(PluginInstance()));
            serviceCollection.AddSingleton<Outbox>(sp => new Outbox(DataFolder(sp)));

            // The controller injects the plugin instance directly (it reads
            // Configuration defaults like DefaultMinHeight / MoviesLibrary). Jellyfin
            // does NOT register plugin instances in the DI container, so without
            // this the controller cannot be built and EVERY action (Health,
            // Libraries, Jobs, ...) returns HTTP 500. Resolve lazily: Instance is
            // set by request time, exactly like EngineClient above.
            serviceCollection.AddSingleton<MediaDownloaderPlugin>(sp => PluginInstance());

            // One worker instance, shared by the Host (StartAsync) and the
            // controller (Notify).
            serviceCollection.AddSingleton<OutboxWorker>();
            serviceCollection.AddSingleton<IHostedService>(sp => sp.GetRequiredService<OutboxWorker>());
        }

        /// <summary>The plugin instance, resolved at call time (never at registration time).</summary>
        private static MediaDownloaderPlugin PluginInstance() => MediaDownloaderPlugin.Instance;

        /// <summary>
        /// Where outbox.json lives. Prefers the plugin's own DataFolderPath; if the
        /// instance isn't available yet, derives it from IApplicationPaths (a core
        /// registered service): &lt;plugins root&gt;/Media Downloader - the same location.
        /// </summary>
        private static string DataFolder(IServiceProvider sp)
        {
            var plugin = MediaDownloaderPlugin.Instance;
            if (plugin != null && !string.IsNullOrWhiteSpace(plugin.DataFolderPath))
            {
                return plugin.DataFolderPath;
            }

            string pluginsRoot = null;
            try
            {
                pluginsRoot = sp.GetRequiredService<IApplicationPaths>()?.PluginsPath;
            }
            catch
            {
                // not resolvable - keep a safe relative path rather than throwing
            }

            return Path.Combine(pluginsRoot ?? "plugins", "Media Downloader");
        }
    }
}
