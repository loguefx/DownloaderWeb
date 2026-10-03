using System;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaDownloader.Engine
{
    /// <summary>
    /// Delivers waiting outbox jobs to the engine (build plan Part 4).
    ///
    /// Tries every 30 seconds and immediately when a job is added. On a 2xx
    /// the job is marked sent. On a 4xx it is marked rejected (bad request -
    /// retrying cannot fix it) with the engine's message. On a timeout,
    /// connection refusal or 5xx it stays waiting-to-send and is retried.
    /// Because the engine ignores a jobId it already accepted, a retry after a
    /// lost reply never queues the job twice (exactly-once delivery).
    /// </summary>
    public class OutboxWorker : IHostedService, IDisposable
    {
        private static readonly TimeSpan Tick = TimeSpan.FromSeconds(30);

        private readonly Outbox _outbox;
        private readonly EngineClient _engine;
        private readonly ILogger<OutboxWorker> _logger;
        private readonly Channel<bool> _wakeup;
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private int _disposed;
        private Task _loop;

        public OutboxWorker(Outbox outbox, EngineClient engine, ILogger<OutboxWorker> logger)
        {
            _outbox = outbox;
            _engine = engine;
            _logger = logger;
            _wakeup = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
            {
                FullMode = BoundedChannelFullMode.DropOldest
            });
        }

        /// <summary>Kicks a delivery pass right now (a new job was added).</summary>
        public void Notify()
        {
            _wakeup.Writer.TryWrite(true);
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _logger.LogInformation("Media Downloader outbox worker started (tick {Tick}s).", Tick.TotalSeconds);
            _loop = RunAsync();
            return Task.CompletedTask;
        }

        public async Task StopAsync(CancellationToken cancellationToken)
        {
            _cts.Cancel();
            _wakeup.Writer.TryWrite(true);
            try
            {
                if (_loop != null) await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        private async Task RunAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    await ProcessAsync(_cts.Token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    // Never let the worker die: the outbox must outlive hiccups.
                    _logger.LogError(ex, "Outbox pass failed; will retry.");
                }

                // Sleep up to 30 s, woken early by Notify().
                using var sleepCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
                sleepCts.CancelAfter(Tick);
                try
                {
                    await _wakeup.Reader.WaitToReadAsync(sleepCts.Token).ConfigureAwait(false);
                    _wakeup.Reader.TryRead(out _);
                }
                catch (OperationCanceledException) when (!_cts.IsCancellationRequested)
                {
                    // the 30 s tick elapsed - fall through and process again
                }
            }
        }

        private async Task ProcessAsync(CancellationToken ct)
        {
            foreach (var job in _outbox.Waiting())
            {
                if (ct.IsCancellationRequested) return;

                _outbox.NoteAttempt(job.JobId);
                try
                {
                    var body = await _engine.PostAsync("api/jobs", job.Payload, ct).ConfigureAwait(false);
                    _outbox.MarkSent(job.JobId, Truncate(body));
                    _logger.LogInformation("Delivered outbox job {JobId} ({Title}).", job.JobId, job.Title);
                }
                catch (EngineApiException ex) when (ex.Status >= 400 && ex.Status < 500)
                {
                    // The engine understood the job and refused it. Retrying
                    // cannot fix a bad request; show the message on the Queue
                    // screen instead.
                    _outbox.MarkRejected(job.JobId, ex.Message);
                    _logger.LogWarning("Outbox job {JobId} rejected by engine: {Message}", job.JobId, ex.Message);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception ex)
                {
                    // Offline / timeout / 5xx: stays waiting, retried next tick.
                    _outbox.NoteFailedAttempt(job.JobId, ex.Message);
                    _logger.LogInformation("Engine unreachable for {JobId} ({Message}); will retry.", job.JobId, ex.Message);
                }
            }
        }

        private static string Truncate(string s, int max = 300)
        {
            if (string.IsNullOrEmpty(s) || s.Length <= max) return s;
            return s.Substring(0, max) + "...";
        }

        public void Dispose()
        {
            // The DI container may dispose this instance more than once - it is
            // registered under BOTH OutboxWorker and IHostedService - so the
            // second dispose must be a no-op (a raw _cts.Cancel() there throws
            // ObjectDisposedException).
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            try { _cts.Cancel(); } catch (ObjectDisposedException) { }
            _cts.Dispose();
        }
    }
}
