using System;
using System.IO;
using Jellyfin.Plugin.MediaDownloader.Engine;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.MediaDownloader
{
    /// <summary>
    /// Wires the plugin's services into Jellyfin. EngineClient and Outbox are
    /// singletons; OutboxWorker is a hosted service (Jellyfin runs it for the
    /// life of the server).
    ///
    /// The plugin instance is resolved LAZILY inside each factory. Capturing
    /// MediaDownloaderPlugin.Instance in this method and dereferencing it from
    /// the deferred factory is what crashed startup with a NullReferenceException:
    /// at service-registration time the static can still be null. A factory runs
    /// later (hosted-service start / first request), by which time the plugin
    /// instance exists, so resolving it there is safe. The data folder also has
    /// an IApplicationPaths fallback so it can never be null.
    /// </summary>
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddSingleton<EngineClient>(sp => new EngineClient(PluginInstance()));
            serviceCollection.AddSingleton<Outbox>(sp => new Outbox(DataFolder(sp)));
            serviceCollection.AddHostedService<OutboxWorker>();
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
