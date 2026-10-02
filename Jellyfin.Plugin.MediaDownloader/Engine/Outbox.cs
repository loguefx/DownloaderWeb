using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.MediaDownloader.Engine
{
    /// <summary>One job waiting in / delivered by the outbox.</summary>
    public class OutboxEntry
    {
        public string JobId { get; set; }
        public string Title { get; set; }
        public string State { get; set; } = Outbox.StateWaitingToSend;
        public int Attempts { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? LastAttemptAt { get; set; }
        public string LastEngineMessage { get; set; }
        public JsonElement Payload { get; set; }
    }

    /// <summary>
    /// Jobs not yet delivered to the engine (build plan Part 4).
    ///
    /// A JSON file in the plugin data folder, one entry per jobId. States:
    ///   waiting-to-send - engine was offline (or a 5xx); retried every 30 s
    ///   sent            - the engine answered 2xx; done
    ///   rejected        - the engine answered 4xx (bad request); NOT retried
    ///
    /// Exactly-once: the engine ignores a jobId it already accepted, so a
    /// retry after a lost reply never queues the job twice.
    /// </summary>
    public class Outbox
    {
        public const string StateWaitingToSend = "waiting-to-send";
        public const string StateSent = "sent";
        public const string StateRejected = "rejected";

        private readonly object _gate = new object();
        private readonly string _file;
        private Dictionary<string, OutboxEntry> _entries;

        public Outbox(string dataFolder)
        {
            _file = Path.Combine(dataFolder, "outbox.json");
            Load();
        }

        private void Load()
        {
            lock (_gate)
            {
                try
                {
                    var raw = File.ReadAllText(_file);
                    _entries = JsonSerializer.Deserialize<Dictionary<string, OutboxEntry>>(raw) ?? new Dictionary<string, OutboxEntry>();
                }
                catch (Exception)
                {
                    _entries = new Dictionary<string, OutboxEntry>();
                }
            }
        }

        private void Save()
        {
            // Atomic: write a sibling .tmp and rename, so a crash never leaves
            // a half-written outbox (a lost outbox is a lost download request).
            var tmp = _file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_entries, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, _file, true);
        }

        /// <summary>
        /// Adds a job. Re-adding the same jobId replaces the entry (a page or
        /// the plugin resending must not create a second outbox row).
        /// </summary>
        public OutboxEntry Add(string jobId, JsonElement payload, string title)
        {
            lock (_gate)
            {
                var entry = new OutboxEntry
                {
                    JobId = jobId,
                    Title = title,
                    State = StateWaitingToSend,
                    CreatedAt = DateTime.UtcNow,
                    Payload = payload
                };
                _entries[jobId] = entry;
                Save();
                return entry;
            }
        }

        public OutboxEntry Get(string jobId)
        {
            lock (_gate)
            {
                return _entries.TryGetValue(jobId, out var e) ? e : null;
            }
        }

        /// <summary>Waiting jobs, oldest first (FIFO delivery).</summary>
        public List<OutboxEntry> Waiting()
        {
            lock (_gate)
            {
                var list = new List<OutboxEntry>();
                foreach (var e in _entries.Values)
                {
                    if (e.State == StateWaitingToSend) list.Add(e);
                }
                list.Sort((a, b) => a.CreatedAt.CompareTo(b.CreatedAt));
                return list;
            }
        }

        public List<OutboxEntry> All()
        {
            lock (_gate)
            {
                var list = new List<OutboxEntry>(_entries.Values);
                list.Sort((a, b) => b.CreatedAt.CompareTo(a.CreatedAt));
                return list;
            }
        }

        public void NoteAttempt(string jobId)
        {
            lock (_gate)
            {
                if (_entries.TryGetValue(jobId, out var e))
                {
                    e.Attempts += 1;
                    e.LastAttemptAt = DateTime.UtcNow;
                    Save();
                }
            }
        }

        public void MarkSent(string jobId, string engineMessage)
        {
            SetState(jobId, StateSent, engineMessage);
        }

        public void MarkRejected(string jobId, string engineMessage)
        {
            SetState(jobId, StateRejected, engineMessage);
        }

        /// <summary>
        /// A failed delivery attempt that is NOT a 4xx rejection (timeout,
        /// connection refused, 5xx): the job stays waiting-to-send.
        /// </summary>
        public void NoteFailedAttempt(string jobId, string engineMessage)
        {
            lock (_gate)
            {
                if (_entries.TryGetValue(jobId, out var e))
                {
                    e.LastAttemptAt = DateTime.UtcNow;
                    e.LastEngineMessage = engineMessage;
                    e.State = StateWaitingToSend;
                    Save();
                }
            }
        }

        public void Remove(string jobId)
        {
            lock (_gate)
            {
                if (_entries.Remove(jobId)) Save();
            }
        }

        public int Purge(string state)
        {
            lock (_gate)
            {
                var doomed = new List<string>();
                foreach (var kv in _entries)
                {
                    if (kv.Value.State == state) doomed.Add(kv.Key);
                }
                foreach (var id in doomed) _entries.Remove(id);
                if (doomed.Count > 0) Save();
                return doomed.Count;
            }
        }

        public (int waiting, int sent, int rejected) Counts()
        {
            lock (_gate)
            {
                int waiting = 0, sent = 0, rejected = 0;
                foreach (var e in _entries.Values)
                {
                    switch (e.State)
                    {
                        case StateWaitingToSend: waiting++; break;
                        case StateSent: sent++; break;
                        case StateRejected: rejected++; break;
                    }
                }
                return (waiting, sent, rejected);
            }
        }

        private void SetState(string jobId, string state, string message)
        {
            lock (_gate)
            {
                if (_entries.TryGetValue(jobId, out var e))
                {
                    e.State = state;
                    e.LastEngineMessage = message;
                    Save();
                }
            }
        }
    }
}
