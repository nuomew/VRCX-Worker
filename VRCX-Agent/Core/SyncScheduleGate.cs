using System;

namespace VRCX.Agent.Core;

/// <summary>
/// Strict schedule gate enforcing the authoritative Web-configured sync interval.
/// Local data stays buffered on disk while outside the scheduled window and is only pushed
/// when `nowUtc >= NextSyncAtUtc`.
/// </summary>
public sealed class SyncScheduleGate
{
    private readonly object _lock = new();
    private int _intervalSeconds;
    private DateTimeOffset _nextSyncAtUtc;
    private long _nextSyncAtMonoMs;
    private bool _hasSyncedWithWeb;

    public SyncScheduleGate(int initialIntervalSeconds = AgentConfig.DefaultSyncIntervalSeconds)
    {
        _intervalSeconds = ClampInterval(initialIntervalSeconds);
        // Allow initial handshake sync on startup so the Agent immediately pulls the Web-configured interval.
        _nextSyncAtUtc = DateTimeOffset.MinValue;
        _nextSyncAtMonoMs = 0;
    }

    public int IntervalSeconds
    {
        get { lock (_lock) return _intervalSeconds; }
    }

    public DateTimeOffset NextSyncAtUtc
    {
        get { lock (_lock) return _nextSyncAtUtc; }
    }

    public bool HasSyncedWithWeb
    {
        get { lock (_lock) return _hasSyncedWithWeb; }
    }

    public static int ClampInterval(int seconds)
    {
        return Math.Clamp(
            seconds <= 0 ? AgentConfig.DefaultSyncIntervalSeconds : seconds,
            AgentConfig.MinSyncIntervalSeconds,
            AgentConfig.MaxSyncIntervalSeconds);
    }

    /// <summary>
    /// Returns true ONLY when the scheduled Web sync timestamp has arrived (or before first handshake).
    /// Outside this window, no local log or screenshot sync push is permitted.
    /// </summary>
    public bool IsDue(DateTimeOffset nowUtc)
    {
        lock (_lock)
        {
            return nowUtc >= _nextSyncAtUtc;
        }
    }

    /// <summary>
    /// Monotonic-clock due check immune to NTP/manual system wall-clock rollbacks.
    /// </summary>
    public bool IsDueNow() => IsDueMonotonic(Environment.TickCount64);

    internal bool IsDueMonotonic(long nowMonoMs)
    {
        lock (_lock)
        {
            return _nextSyncAtMonoMs <= 0 || nowMonoMs >= _nextSyncAtMonoMs;
        }
    }

    /// <summary>
    /// Applies the authoritative `syncIntervalSeconds` returned by the Cloudflare Worker
    /// and schedules the next sync window strictly `interval` seconds from `nowUtc`.
    /// </summary>
    public int ApplyServerSchedule(AgentSyncResponse response, DateTimeOffset nowUtc)
        => ApplyServerSchedule(response, nowUtc, Environment.TickCount64);

    internal int ApplyServerSchedule(AgentSyncResponse response, DateTimeOffset nowUtc, long nowMonoMs)
    {
        int nextInterval = ClampInterval(response.SyncIntervalSeconds);
        lock (_lock)
        {
            _intervalSeconds = nextInterval;
            _hasSyncedWithWeb = true;
            _nextSyncAtUtc = nowUtc.AddSeconds(nextInterval);
            _nextSyncAtMonoMs = nowMonoMs + nextInterval * 1000L;
            return _intervalSeconds;
        }
    }

    /// <summary>
    /// Schedules the next retry after a transient failure without ever accelerating faster than the Web interval.
    /// </summary>
    public void ApplyFailureBackoff(int consecutiveFailures, DateTimeOffset nowUtc)
        => ApplyFailureBackoff(consecutiveFailures, nowUtc, Environment.TickCount64);

    internal void ApplyFailureBackoff(int consecutiveFailures, DateTimeOffset nowUtc, long nowMonoMs)
    {
        lock (_lock)
        {
            int backoffSec = Math.Min(300, (int)Math.Pow(2, Math.Clamp(consecutiveFailures, 1, 6)) * 5);
            int delaySec = Math.Max(_intervalSeconds, backoffSec);
            _nextSyncAtUtc = nowUtc.AddSeconds(delaySec);
            _nextSyncAtMonoMs = nowMonoMs + delaySec * 1000L;
        }
    }

    public void ResetForImmediateHandshake()
    {
        lock (_lock)
        {
            _nextSyncAtUtc = DateTimeOffset.MinValue;
            _nextSyncAtMonoMs = 0;
        }
    }
}
