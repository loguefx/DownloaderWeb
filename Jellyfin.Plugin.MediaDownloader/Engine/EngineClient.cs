using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.MediaDownloader.Configuration;

namespace Jellyfin.Plugin.MediaDownloader.Engine
{
    /// <summary>
    /// Raised for 4xx/5xx engine responses. 4xx means the engine understood
    /// the job and refused it (bad request) - the outbox must NOT retry those.
    /// </summary>
    public class EngineApiException : Exception
    {
        public int Status { get; }

        public EngineApiException(int status, string message)
            : base(message)
        {
            Status = status;
        }
    }

    /// <summary>
    /// HttpClient wrapper for the engine HTTP API (build plan Part 1).
    ///
    /// The engine URL and API key are read from the plugin configuration at
    /// request time, so changing Settings takes effect immediately without a
    /// server restart. A single pooled HttpClient is shared; the base address
    /// is applied per request.
    /// </summary>
    public class EngineClient
    {
        private static readonly HttpClient Http = new HttpClient
        {
            // Generous: /api/title runs episode detection, which loads pages.
            Timeout = TimeSpan.FromSeconds(90)
        };

        private static readonly JsonSerializerOptions JsonOpts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        };

        private readonly MediaDownloaderPlugin _plugin;

        public EngineClient(MediaDownloaderPlugin plugin)
        {
            _plugin = plugin;
        }

        /// <summary>
        /// Resolve the plugin lazily: it may not be set at construction time
        /// (service registration runs before the plugin instance exists), but is
        /// always set by request time. Keeps a null constructor arg from NREing.
        /// </summary>
        private MediaDownloaderPlugin Plugin => _plugin ?? MediaDownloaderPlugin.Instance;

        private Uri BaseUri
        {
            get
            {
                var plugin = Plugin;
                if (plugin == null)
                {
                    throw new EngineApiException(0, "Plugin is not initialised yet - please retry.");
                }
                var url = (plugin.Configuration.EngineUrl ?? string.Empty).Trim().TrimEnd('/');
                if (string.IsNullOrEmpty(url))
                {
                    throw new EngineApiException(0, "Engine URL is not set - open Settings and enter the engine address.");
                }
                if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                    !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                {
                    url = "http://" + url;
                }
                return new Uri(url);
            }
        }

        /// <summary>
        /// Core call. Returns (status, body). Non-2xx throws EngineApiException
        /// with the engine's message, so callers can distinguish 4xx (rejected)
        /// from anything else (retryable).
        /// </summary>
        public async System.Threading.Tasks.ValueTask<(int status, string body)> SendAsync(
            HttpMethod method, string path, JsonElement? body = null, CancellationToken ct = default)
        {
            var request = new HttpRequestMessage(method, new Uri(BaseUri, path));
            var key = (Plugin?.Configuration.EngineApiKey ?? string.Empty).Trim();
            if (!string.IsNullOrEmpty(key))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            }
            if (body.HasValue)
            {
                request.Content = new StringContent(body.Value.GetRawText(), System.Text.Encoding.UTF8, "application/json");
            }

            using var response = await Http.SendAsync(request, ct).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                var message = text;
                try
                {
                    using var doc = JsonDocument.Parse(text);
                    if (doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String)
                    {
                        message = err.GetString();
                    }
                }
                catch (JsonException)
                {
                    // not JSON - keep the raw body
                }
                throw new EngineApiException((int)response.StatusCode, message ?? response.StatusCode.ToString());
            }
            return ((int)response.StatusCode, text);
        }

        public async Task<T> GetAsync<T>(string path, CancellationToken ct = default)
        {
            var (_, body) = await SendAsync(HttpMethod.Get, path, null, ct).ConfigureAwait(false);
            return JsonSerializer.Deserialize<T>(body, JsonOpts);
        }

        public async Task<string> GetRawAsync(string path, CancellationToken ct = default)
        {
            var (_, body) = await SendAsync(HttpMethod.Get, path, null, ct).ConfigureAwait(false);
            return body;
        }

        public async Task<string> PostAsync(string path, JsonElement? body = null, CancellationToken ct = default)
        {
            var (_, outBody) = await SendAsync(HttpMethod.Post, path, body, ct).ConfigureAwait(false);
            return outBody;
        }

        public async Task<string> PutAsync(string path, JsonElement body, CancellationToken ct = default)
        {
            var (_, outBody) = await SendAsync(HttpMethod.Put, path, body, ct).ConfigureAwait(false);
            return outBody;
        }

        public async Task<string> DeleteAsync(string path, CancellationToken ct = default)
        {
            var (_, outBody) = await SendAsync(HttpMethod.Delete, path, null, ct).ConfigureAwait(false);
            return outBody;
        }

        /// <summary>
        /// True when the engine answers /api/health. Used for the banner and
        /// the Settings "test connection" button.
        /// </summary>
        public async Task<bool> IsReachableAsync(CancellationToken ct = default)
        {
            try
            {
                await SendAsync(HttpMethod.Get, "api/health", null, ct).ConfigureAwait(false);
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
