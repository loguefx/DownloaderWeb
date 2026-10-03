using System;
using System.Collections.Generic;
using Jellyfin.Plugin.MediaDownloader.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.MediaDownloader
{
    /// <summary>
    /// Media Downloader plugin: queues movies / series / anime for the
    /// DownloaderWeb engine and shows the engine's health and queue.
    /// The browser never talks to the engine directly (Part 2): the plugin
    /// controller forwards, so the engine key stays on the server.
    /// </summary>
    public class MediaDownloaderPlugin : BasePlugin<MediaDownloaderConfiguration>, IHasWebPages
    {
        public override string Name => "Media Downloader";

        public override Guid Id => Guid.Parse("c86748fd-475a-4cf0-bae0-83b0c8bc9273");

        public static MediaDownloaderPlugin Instance { get; private set; }

        public MediaDownloaderPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        /// <summary>
        /// The plugin's dashboard pages.
        ///
        /// EnableInMainMenu = true is REQUIRED for the dashboard sidebar: the
        /// Jellyfin web client (10.11+ and 12.x) builds its "Plugins" drawer
        /// from GET /web/ConfigurationPages?enableInMainMenu=true - pages
        /// without the flag only exist behind the Plugins list page.
        /// </summary>
        public IEnumerable<PluginPageInfo> GetPages()
        {
            yield return new PluginPageInfo
            {
                Name = Name,
                DisplayName = Name,
                EnableInMainMenu = true,
                MenuIcon = "settings",
                EmbeddedResourcePath = GetType().Namespace + ".Web.settings.html"
            };
            yield return new PluginPageInfo
            {
                Name = Name + "Overview",
                DisplayName = Name + " Overview",
                EnableInMainMenu = true,
                MenuIcon = "download",
                EmbeddedResourcePath = GetType().Namespace + ".Web.overview.html"
            };
        }
    }
}
