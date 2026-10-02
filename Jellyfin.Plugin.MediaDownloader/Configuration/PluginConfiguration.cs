using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.MediaDownloader.Configuration;

/// <summary>
/// Plugin-side settings. The engine's own behavior (reserve, fill mode, path
/// mappings, its API key) lives in the engine's engine.json and is edited
/// through the EngineSettings proxy, so there is a single source of truth.
/// </summary>
public class MediaDownloaderConfiguration : BasePluginConfiguration
{
    /// <summary>Base URL of the engine, e.g. http://192.168.1.20:7878</summary>
    public string EngineUrl { get; set; } = string.Empty;

    /// <summary>The Bearer key from the engine's engine.json.</summary>
    public string EngineApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Jellyfin library names each kind is filed into (Jellyfin libraries have
    /// no stable id; the virtual-folder name is the key). Resolved to the
    /// library's current drive folders when a job is queued, so adding a drive
    /// in Jellyfin is all that is needed (Part 5).
    /// </summary>
    public string TvLibrary { get; set; } = string.Empty;

    public string MoviesLibrary { get; set; } = string.Empty;

    public string AnimeLibrary { get; set; } = string.Empty;

    /// <summary>Quality floor the plugin asks the engine for (default 1080).</summary>
    public int DefaultMinHeight { get; set; } = 1080;

    /// <summary>"dub" or "sub".</summary>
    public string DefaultMode { get; set; } = "dub";
}
