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

        public IEnumerable<PluginPageInfo> GetPages()
        {
            yield return new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = GetType().Namespace + ".Web.settings.html"
            };
            yield return new PluginPageInfo
            {
                Name = Name + "Overview",
                EmbeddedResourcePath = GetType().Namespace + ".Web.overview.html"
            };
        }
    }
}
