using Jellyfin.Plugin.MediaDownloader.Engine;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.MediaDownloader
{
    /// <summary>
    /// Wires the plugin's services into Jellyfin. EngineClient and Outbox are
    /// singletons; OutboxWorker is a hosted service (Jellyfin runs it for the
    /// life of the server).
    /// </summary>
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            var plugin = MediaDownloaderPlugin.Instance;

            serviceCollection.AddSingleton<EngineClient>(sp => new EngineClient(plugin));
            serviceCollection.AddSingleton<Outbox>(sp => new Outbox(plugin.DataFolderPath));
            serviceCollection.AddHostedService<OutboxWorker>();
        }
    }
}
