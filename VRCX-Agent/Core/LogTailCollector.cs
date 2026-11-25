using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Incrementally tails VRChat `output_log_*.txt` using a persisted byte-offset cursor
/// and buffers unsent events in a durable local JSONL offline queue until periodic HTTP sync succeeds.
/// </summary>
public sealed class LogTailCollector
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const int MaxOfflineQueueEntries = 20000;
    private const int BackfillQueueHighWatermark = 3500;
    private const int MaxHistoricalEventsPerPass = 1000;
    private const int MaxTrackedLogFiles = 500;
    private const int MaxLiveReadChunkBytes = 8 * 1024 * 1024;
    private static readonly System.Text.RegularExpressions.Regex OutputLogTimestampRegex = new(
        @"^output_log_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.txt$",
        System.Text.RegularExpressions.RegexOptions.Compiled | System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    private readonly string _stateDir;
    private readonly string _cursorPath;
    private readonly string _queuePath;
    private readonly VrcLogParser _parser;
    private readonly object _pollLock = new();

    private LogCursorState _cursor = new();
    private readonly List<GameLogEventItem> _queue = new();
    private long _queueHeadSeq;
    private string _pendingLocationFileName = string.Empty;
    private long _pendingLocationDiskOffset = -1;
    private long _liveReadMemoryOffset = -1;
    private long _pendingLocationDetectedAtMonoMs;

    internal TimeSpan PendingLocationFlushDelay { get; set; } = TimeSpan.FromSeconds(10);

    public sealed record LiveRoomSnapshot(
        string CurrentLocation,
        string CurrentWorldId,
        string CurrentWorldName,
        int CurrentPlayerCount,
        List<AgentPlayerSnapshot> PlayerDetails,
        List<Dictionary<string, string>> PlayersForMetadata);

    public event Action<GameLogEventItem>? ScreenshotCaptured;
    public event Action? WorldStateChanged;

    public VrcLogParser Parser => _parser;

    private LiveRoomSnapshot CaptureLiveRoomSnapshotLocked()
    {
        return new LiveRoomSnapshot(
            _parser.CurrentLocation,
            _parser.CurrentWorldId,
            _parser.CurrentWorldName,
            _parser.CurrentPlayerCount,
            _parser.SnapshotCurrentPlayerDetails(),
            new List<Dictionary<string, string>>(_parser.SnapshotCurrentPlayers()));
    }

    public LiveRoomSnapshot SnapshotLiveRoomState()
    {
        lock (_pollLock)
        {
            return CaptureLiveRoomSnapshotLocked();
        }
    }

    internal static string? TryExtractLogFilenameTimestamp(string filePath)
    {
        string fileName = Path.GetFileName(filePath);
        if (string.IsNullOrEmpty(fileName)) return null;
        var m = OutputLogTimestampRegex.Match(fileName);
        return m.Success ? m.Groups[1].Value : null;
    }

    private static (bool HasTimestamp, string TimestampKey, long WriteTicksUtc, string FileName) BuildChronologicalSortKey(string filePath)
    {
        string fileName = Path.GetFileName(filePath) ?? string.Empty;
        string? ts = TryExtractLogFilenameTimestamp(filePath);
        if (ts != null)
        {
            return (true, ts, 0L, fileName);
        }
        long ticks = 0L;
        try { ticks = File.GetLastWriteTimeUtc(filePath).Ticks; } catch { /* ignore */ }
        return (false, string.Empty, ticks, fileName);
    }

    internal static int CompareLogFilesChronologically(string leftPath, string rightPath)
    {
        // Strict total-order key: non-timestamped fallback files sort before standard VRChat
        // `output_log_YYYY-MM-DD_HH-mm-ss.txt` files, guaranteeing transitivity for List.Sort.
        var left = BuildChronologicalSortKey(leftPath);
        var right = BuildChronologicalSortKey(rightPath);

        int hasTsCmp = left.HasTimestamp.CompareTo(right.HasTimestamp);
        if (hasTsCmp != 0) return hasTsCmp;

        if (left.HasTimestamp)
        {
            int tsCmp = StringComparer.Ordinal.Compare(left.TimestampKey, right.TimestampKey);
            if (tsCmp != 0) return tsCmp;
        }
        else
        {
            int timeCmp = left.WriteTicksUtc.CompareTo(right.WriteTicksUtc);
            if (timeCmp != 0) return timeCmp;
        }

        return StringComparer.OrdinalIgnoreCase.Compare(left.FileName, right.FileName);
    }

    public int OfflineQueueCount
    {
        get
        {
            lock (_queue)
            {
                return _queue.Count;
            }
        }
    }

    public LogTailCollector(string stateDir, VrcLogParser? parser = null)
    {
        _stateDir = stateDir;
        Directory.CreateDirectory(_stateDir);
        _cursorPath = Path.Combine(_stateDir, "cursor.json");
        _queuePath = Path.Combine(_stateDir, "offline-queue.jsonl");
        _parser = parser ?? new VrcLogParser();

        LoadPersistedState();
    }

    public static string ResolveDefaultVrChatLogDirectory()
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(localAppData))
        {
            return string.Empty;
        }
        // Standard Windows path: %USERPROFILE%\AppData\LocalLow\VRChat\VRChat
        string? appDataRoot = Directory.GetParent(localAppData)?.FullName;
        if (!string.IsNullOrEmpty(appDataRoot))
        {
            string localLow = Path.Combine(appDataRoot, "LocalLow", "VRChat", "VRChat");
            if (Directory.Exists(localLow))
            {
                return localLow;
            }
        }
        return Path.Combine(localAppData, "VRChat", "VRChat");
    }

    public LogCursorState SnapshotCursor()
    {
        lock (_pollLock)
        {
            return _cursor.Clone();
        }
    }

    /// <summary>
    /// Reads up to `maxCount` queued events without removing them so failed HTTP uploads retain durability.
    /// </summary>
    public List<GameLogEventItem> PeekBatch(int maxCount = 50)
    {
        return PeekBatchWithSeq(maxCount).Items;
    }

    /// <summary>
    /// Reads up to `maxCount` queued events along with the current queue head sequence number so
    /// concurrent max-queue eviction can never cause AcknowledgeBatch to drop un-uploaded events.
    /// </summary>
    public (List<GameLogEventItem> Items, long HeadSeq) PeekBatchWithSeq(int maxCount = 50)
    {
        lock (_queue)
        {
            int count = Math.Min(Math.Max(maxCount, 1), _queue.Count);
            List<GameLogEventItem> items = count == 0 ? new List<GameLogEventItem>() : _queue.GetRange(0, count);
            return (items, _queueHeadSeq);
        }
    }

    /// <summary>
    /// Removes the oldest `count` events after the cloud Worker confirms HTTP 200 ingest.
    /// </summary>
    public void AcknowledgeBatch(int count)
    {
        if (count <= 0) return;
        lock (_queue)
        {
            int removeCount = Math.Min(count, _queue.Count);
            if (removeCount <= 0) return;
            _queue.RemoveRange(0, removeCount);
            _queueHeadSeq += removeCount;
            PersistQueueLocked();
        }
    }

    /// <summary>
    /// Sequence-guarded acknowledgment: adjusts `count` by any items evicted from the head of the queue
    /// while the HTTP sync request was in flight so un-uploaded events are never deleted.
    /// </summary>
    public void AcknowledgeBatch(int count, long expectedHeadSeq)
    {
        if (count <= 0) return;
        lock (_queue)
        {
            long alreadyEvicted = Math.Max(0L, _queueHeadSeq - expectedHeadSeq);
            long remainingToAck = count - alreadyEvicted;
            if (remainingToAck <= 0) return;
            int removeCount = (int)Math.Min(remainingToAck, _queue.Count);
            if (removeCount <= 0) return;
            _queue.RemoveRange(0, removeCount);
            _queueHeadSeq += removeCount;
            PersistQueueLocked();
        }
    }

    /// <summary>
    /// Scans all `output_log_*.txt` files in chronological order:
    /// - Historical log files (older than the latest file) are backfilled once each using an isolated parser
    ///   so they never overwrite live room/player state or trigger duplicate screenshot re-embedding.
    /// - The latest log file is incrementally tailed using the live `_parser` with persisted byte offsets.
    /// Returns the total number of newly parsed GameLog events.
    /// </summary>
    public int PollLogDirectory(string logDirectory)
    {
        if (string.IsNullOrWhiteSpace(logDirectory) || !Directory.Exists(logDirectory))
        {
            return 0;
        }

        var capturedScreenshots = new List<GameLogEventItem>();
        bool worldStateMutated = false;
        int totalParsed = 0;

        lock (_pollLock)
        {
            List<string> orderedFiles = Directory
                .EnumerateFiles(logDirectory, "output_log_*.txt", SearchOption.TopDirectoryOnly)
                .ToList();
            orderedFiles.Sort(CompareLogFilesChronologically);

            if (orderedFiles.Count == 0)
            {
                return 0;
            }

            string latestFile = orderedFiles[orderedFiles.Count - 1];
            string latestName = Path.GetFileName(latestFile);
            bool cursorDirty = false;

            // Never regress backwards to an older timestamped log file if an older VRChat process flushed late.
            if (!string.IsNullOrWhiteSpace(_cursor.FileName) &&
                !string.Equals(_cursor.FileName, latestName, StringComparison.OrdinalIgnoreCase))
            {
                string? curTs = TryExtractLogFilenameTimestamp(_cursor.FileName);
                string? latestTs = TryExtractLogFilenameTimestamp(latestName);
                if (curTs != null && latestTs != null && StringComparer.Ordinal.Compare(latestTs, curTs) < 0)
                {
                    string? activeFile = orderedFiles.FirstOrDefault(
                        f => string.Equals(Path.GetFileName(f), _cursor.FileName, StringComparison.OrdinalIgnoreCase));
                    if (!string.IsNullOrEmpty(activeFile))
                    {
                        latestFile = activeFile;
                        latestName = _cursor.FileName;
                    }
                }
            }

            // 0. If VRChat rotated to a new output_log_*.txt, drain any remaining tail of the previous active file
            //    through the live parser before resetting transient room/player state for the new session.
            if (!string.IsNullOrWhiteSpace(_cursor.FileName) &&
                !string.Equals(_cursor.FileName, latestName, StringComparison.OrdinalIgnoreCase))
            {
                string? prevFile = orderedFiles.FirstOrDefault(
                    f => string.Equals(Path.GetFileName(f), _cursor.FileName, StringComparison.OrdinalIgnoreCase));
                if (!string.IsNullOrEmpty(prevFile))
                {
                    totalParsed += DrainRotatedActiveFileLocked(prevFile, capturedScreenshots, out bool prevUpdated, out bool prevMutated);
                    cursorDirty |= prevUpdated;
                    worldStateMutated |= prevMutated;
                }
                _parser.ResetSessionState();
                ClearPendingLocationTracking();
                _liveParserWarmupDone = true;
            }

            // 1. Backfill any unread historical output_log_*.txt files oldest-first (chunked & paused if offline queue is heavy).
            foreach (string histFile in orderedFiles)
            {
                if (string.Equals(Path.GetFileName(histFile), latestName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (OfflineQueueCount >= BackfillQueueHighWatermark)
                {
                    break;
                }
                int added = ReadHistoricalLogFile(histFile, out bool fileCursorUpdated);
                totalParsed += added;
                cursorDirty |= fileCursorUpdated;
            }

            // 2. Tail the active/latest output_log_*.txt file using the live parser (complete newline-terminated lines only).
            totalParsed += ReadLatestLogFile(latestFile, capturedScreenshots, out bool latestCursorUpdated, out bool latestMutated);
            cursorDirty |= latestCursorUpdated;
            worldStateMutated |= latestMutated;

            if (cursorDirty)
            {
                PruneTrackedOffsets(orderedFiles);
                SaveCursor();
            }
        }

        // Fire events outside _pollLock to avoid re-entrancy deadlocks.
        foreach (GameLogEventItem shot in capturedScreenshots)
        {
            ScreenshotCaptured?.Invoke(shot);
        }

        if (worldStateMutated)
        {
            WorldStateChanged?.Invoke();
        }

        return totalParsed;
    }

    private int ReadHistoricalLogFile(string filePath, out bool cursorUpdated)
    {
        cursorUpdated = false;
        string fileName = Path.GetFileName(filePath);
        long fileLen;
        try
        {
            fileLen = new FileInfo(filePath).Length;
        }
        catch
        {
            return 0;
        }

        long startOffset = 0;
        if (_cursor.FileOffsets.TryGetValue(fileName, out long recordedOffset))
        {
            if (fileLen <= recordedOffset)
            {
                return 0;
            }
            startOffset = recordedOffset;
        }

        var isolatedParser = new VrcLogParser();
        var batch = new List<GameLogEventItem>();
        long endPosition = startOffset;

        try
        {
            if (startOffset > 0)
            {
                WarmUpIsolatedParserFromPrefix(isolatedParser, filePath, startOffset);
            }

            // Chunk historical backfill into bounded passes (<= MaxHistoricalEventsPerPass events)
            // with exact byte-offset checkpoints so huge legacy log files never overflow MaxOfflineQueueEntries.
            long scanOffset = startOffset;
            bool hitEventCap = false;
            while (scanOffset < fileLen && !hitEventCap)
            {
                List<(string Line, long LineStartOffset, long LineEndOffset)> lines = ReadCompleteLinesWithOffsets(
                    filePath,
                    scanOffset,
                    out long chunkEndOffset);

                if (lines.Count == 0 && chunkEndOffset > scanOffset)
                {
                    // Oversized single line (> MaxLiveReadChunkBytes) was safely skipped to its trailing '\n'.
                    scanOffset = chunkEndOffset;
                    endPosition = chunkEndOffset;
                    continue;
                }

                if (lines.Count == 0 || chunkEndOffset <= scanOffset)
                {
                    // Trailing final line without a newline at EOF: read remaining bytes directly without StreamReader over-buffering.
                    long tailBytesLen = fileLen - scanOffset;
                    if (tailBytesLen > 0 && tailBytesLen <= MaxLiveReadChunkBytes)
                    {
                        using var fsTail = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                        fsTail.Seek(scanOffset, SeekOrigin.Begin);
                        byte[] tailBuf = new byte[(int)tailBytesLen];
                        int tailRead = 0;
                        while (tailRead < tailBuf.Length)
                        {
                            int n = fsTail.Read(tailBuf, tailRead, tailBuf.Length - tailRead);
                            if (n == 0) break;
                            tailRead += n;
                        }
                        if (tailRead > 0)
                        {
                            int startIdx = (scanOffset == 0 && tailRead >= 3 && tailBuf[0] == 0xEF && tailBuf[1] == 0xBB && tailBuf[2] == 0xBF) ? 3 : 0;
                            int len = tailRead - startIdx;
                            if (len > 0 && tailBuf[startIdx + len - 1] == (byte)'\r') len--;
                            string tailLine = Encoding.UTF8.GetString(tailBuf, startIdx, len);
                            GameLogEventItem? ev = isolatedParser.ParseLine(tailLine);
                            if (ev != null)
                            {
                                if (ev.Type != "Location")
                                {
                                    GameLogEventItem? pendingLoc = isolatedParser.FlushPendingLocation();
                                    if (pendingLoc != null) batch.Add(pendingLoc);
                                }
                                batch.Add(ev);
                            }
                        }
                        endPosition = scanOffset + tailRead;
                    }
                    else
                    {
                        endPosition = fileLen;
                    }
                    break;
                }

                long safeChunkOffset = scanOffset;
                foreach ((string line, long lineStart, long lineEnd) in lines)
                {
                    bool hadPendingBefore = isolatedParser.HasPendingLocation;
                    GameLogEventItem? ev = isolatedParser.ParseLine(line);
                    if (ev != null)
                    {
                        if (ev.Type != "Location")
                        {
                            GameLogEventItem? pendingLoc = isolatedParser.FlushPendingLocation();
                            if (pendingLoc != null)
                            {
                                batch.Add(pendingLoc);
                            }
                        }
                        batch.Add(ev);
                    }

                    if (!isolatedParser.HasPendingLocation)
                    {
                        safeChunkOffset = lineEnd;
                    }
                    else if (!hadPendingBefore)
                    {
                        safeChunkOffset = lineStart;
                    }

                    if (batch.Count >= MaxHistoricalEventsPerPass && !isolatedParser.HasPendingLocation)
                    {
                        endPosition = lineEnd;
                        hitEventCap = true;
                        break;
                    }
                }

                if (!hitEventCap)
                {
                    scanOffset = chunkEndOffset;
                    endPosition = isolatedParser.HasPendingLocation ? safeChunkOffset : chunkEndOffset;
                }
            }

            if (!hitEventCap && endPosition >= fileLen)
            {
                GameLogEventItem? trailingLoc = isolatedParser.FlushPendingLocation();
                if (trailingLoc != null)
                {
                    batch.Add(trailingLoc);
                }
                endPosition = fileLen;
            }
            else if (!hitEventCap && isolatedParser.HasPendingLocation && endPosition < fileLen)
            {
                // Flush trailing Joining without Entering Room at EOF of historical file.
                GameLogEventItem? trailingLoc = isolatedParser.FlushPendingLocation();
                if (trailingLoc != null)
                {
                    batch.Add(trailingLoc);
                }
                endPosition = fileLen;
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read historical VRChat log {File}", fileName);
            return 0;
        }

        if (batch.Count > 0)
        {
            EnqueueEventsBatch(batch);
            Log.Info("Backfilled {Count} historical GameLog event(s) from {File}.", batch.Count, fileName);
        }

        if (endPosition > startOffset || !_cursor.FileOffsets.ContainsKey(fileName))
        {
            _cursor.FileOffsets[fileName] = endPosition;
            cursorUpdated = true;
        }
        return batch.Count;
    }

    private static void WarmUpIsolatedParserFromPrefix(VrcLogParser parser, string filePath, long upToOffset)
    {
        if (upToOffset <= 0) return;
        try
        {
            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            long limit = Math.Min(upToOffset, fs.Length);
            using var bounded = new BoundedReadStream(fs, limit);
            using var reader = new StreamReader(bounded, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 8192, leaveOpen: true);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                parser.ParseLine(line);
            }
            parser.FlushPendingLocation();
        }
        catch
        {
            // Non-fatal context warmup
        }
    }

    private bool _liveParserWarmupDone;

    private sealed class BoundedReadStream : Stream
    {
        private readonly Stream _inner;
        private long _remaining;

        public BoundedReadStream(Stream inner, long maxBytes)
        {
            _inner = inner;
            _remaining = Math.Max(0, maxBytes);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_remaining <= 0) return 0;
            int toRead = (int)Math.Min(count, _remaining);
            int read = _inner.Read(buffer, offset, toRead);
            _remaining -= read;
            return read;
        }
    }

    private void WarmUpLiveParserFromPrefix(string latestFile, long upToOffset)
    {
        if (_liveParserWarmupDone || upToOffset <= 0)
        {
            _liveParserWarmupDone = true;
            return;
        }
        _liveParserWarmupDone = true;

        try
        {
            using var fs = new FileStream(latestFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            long limit = Math.Min(upToOffset, fs.Length);
            using var bounded = new BoundedReadStream(fs, limit);
            using var reader = new StreamReader(bounded, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 8192, leaveOpen: true);

            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                _parser.ParseLine(line);
            }
            _parser.FlushPendingLocation();
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to warm up live parser room state from {File}", Path.GetFileName(latestFile));
        }
    }

    private int DrainRotatedActiveFileLocked(
        string prevFile,
        List<GameLogEventItem> screenshots,
        out bool cursorUpdated,
        out bool stateMutated)
    {
        cursorUpdated = false;
        stateMutated = false;
        string fileName = Path.GetFileName(prevFile);
        long fileLen;
        try
        {
            fileLen = new FileInfo(prevFile).Length;
        }
        catch
        {
            return 0;
        }

        long persistedOffset = _cursor.FileOffsets.TryGetValue(fileName, out long mapped)
            ? (fileLen < mapped ? 0 : mapped)
            : (fileLen < _cursor.ByteOffset ? 0 : _cursor.ByteOffset);

        // If _parser already buffered a pending Joining line from this rotated file, resume draining from
        // _liveReadMemoryOffset (after that Joining line) instead of re-reading from the rolled-back disk cursor.
        bool resumeAfterPending =
            _parser.HasPendingLocation &&
            _pendingLocationDiskOffset >= 0 &&
            _liveReadMemoryOffset >= _pendingLocationDiskOffset &&
            fileLen >= _liveReadMemoryOffset &&
            string.Equals(_pendingLocationFileName, fileName, StringComparison.OrdinalIgnoreCase);

        long offset = resumeAfterPending ? _liveReadMemoryOffset : persistedOffset;

        if (!resumeAfterPending && offset > 0 && !_liveParserWarmupDone)
        {
            WarmUpLiveParserFromPrefix(prevFile, offset);
        }

        var batch = new List<GameLogEventItem>();
        long endPosition = offset;

        if (fileLen > offset)
        {
            try
            {
                using var fs = new FileStream(prevFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                fs.Seek(offset, SeekOrigin.Begin);
                using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: offset == 0, bufferSize: 8192, leaveOpen: true);
                string? line;
                while ((line = reader.ReadLine()) != null)
                {
                    ProcessLiveLine(line, batch, screenshots, ref stateMutated);
                }
                endPosition = fs.Position;
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Failed to drain rotated active log {File}", fileName);
                return 0;
            }
        }

        GameLogEventItem? trailingLoc = _parser.FlushPendingLocation();
        if (trailingLoc != null)
        {
            batch.Add(trailingLoc);
            _cursor.LastEventDt = trailingLoc.CreatedAt;
        }
        ClearPendingLocationTracking();

        if (batch.Count > 0)
        {
            EnqueueEventsBatch(batch);
        }

        _cursor.FileOffsets[fileName] = endPosition;
        cursorUpdated = true;
        return batch.Count;
    }

    private static List<(string Line, long LineStartOffset, long LineEndOffset)> ReadCompleteLinesWithOffsets(
        string filePath,
        long startOffset,
        out long nextOffset)
    {
        var lines = new List<(string Line, long LineStartOffset, long LineEndOffset)>();
        nextOffset = startOffset;

        using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        long remaining = fs.Length - startOffset;
        if (remaining <= 0)
        {
            return lines;
        }

        int toRead = (int)Math.Min(remaining, MaxLiveReadChunkBytes);
        byte[] buffer = new byte[toRead];
        fs.Seek(startOffset, SeekOrigin.Begin);
        int readTotal = 0;
        while (readTotal < toRead)
        {
            int n = fs.Read(buffer, readTotal, toRead - readTotal);
            if (n == 0) break;
            readTotal += n;
        }
        if (readTotal <= 0)
        {
            return lines;
        }

        // Only advance through the last newline byte so half-written lines are deferred until complete.
        int lastNewline = Array.LastIndexOf(buffer, (byte)'\n', readTotal - 1);
        if (lastNewline < 0)
        {
            // Guard against livelock when a single log line exceeds MaxLiveReadChunkBytes (8 MiB):
            // scan forward in 64 KiB chunks until the terminating '\n' and skip past the oversized noise line.
            if (readTotal >= MaxLiveReadChunkBytes && remaining > MaxLiveReadChunkBytes)
            {
                byte[] scanBuf = new byte[64 * 1024];
                long pos = startOffset + readTotal;
                while (true)
                {
                    int n = fs.Read(scanBuf, 0, scanBuf.Length);
                    if (n <= 0)
                    {
                        // Still actively being written without '\n' yet: wait without advancing past incomplete line.
                        return lines;
                    }
                    int nlIdx = Array.IndexOf(scanBuf, (byte)'\n', 0, n);
                    if (nlIdx >= 0)
                    {
                        nextOffset = pos + nlIdx + 1;
                        Log.Warn("Skipped oversized single VRChat log line ({Bytes} bytes) to prevent tail livelock.", nextOffset - startOffset);
                        return lines;
                    }
                    pos += n;
                }
            }
            return lines;
        }

        int consumeLen = lastNewline + 1;
        int bytePos = 0;
        if (startOffset == 0 && consumeLen >= 3 && buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF)
        {
            bytePos = 3;
        }

        while (bytePos < consumeLen)
        {
            int nl = Array.IndexOf(buffer, (byte)'\n', bytePos, consumeLen - bytePos);
            if (nl < 0) break;
            int contentLen = nl - bytePos;
            if (contentLen > 0 && buffer[nl - 1] == (byte)'\r')
            {
                contentLen--;
            }
            string lineText = Encoding.UTF8.GetString(buffer, bytePos, contentLen);
            long lineStartOffset = startOffset + bytePos;
            long lineEndOffset = startOffset + nl + 1;
            lines.Add((lineText, lineStartOffset, lineEndOffset));
            bytePos = nl + 1;
        }

        nextOffset = startOffset + consumeLen;
        return lines;
    }

    private void ClearPendingLocationTracking()
    {
        _pendingLocationFileName = string.Empty;
        _pendingLocationDiskOffset = -1;
        _liveReadMemoryOffset = -1;
        _pendingLocationDetectedAtMonoMs = 0;
    }

    /// <summary>
    /// Flushes any trailing buffered Joining event (for example on graceful shutdown)
    /// and persists the advanced cursor so no location event is lost across restarts.
    /// </summary>
    public int FlushPendingLocationNow()
    {
        lock (_pollLock)
        {
            GameLogEventItem? flushed = _parser.FlushPendingLocation();
            if (flushed == null)
            {
                ClearPendingLocationTracking();
                return 0;
            }
            EnqueueEventsBatch(new List<GameLogEventItem> { flushed });
            _cursor.LastEventDt = flushed.CreatedAt;
            if (!string.IsNullOrEmpty(_pendingLocationFileName) && _liveReadMemoryOffset >= 0)
            {
                _cursor.FileName = _pendingLocationFileName;
                _cursor.ByteOffset = _liveReadMemoryOffset;
                _cursor.FileOffsets[_pendingLocationFileName] = _liveReadMemoryOffset;
            }
            ClearPendingLocationTracking();
            SaveCursor();
            return 1;
        }
    }

    private void ProcessLiveLine(
        string line,
        List<GameLogEventItem> batch,
        List<GameLogEventItem> screenshots,
        ref bool stateMutated)
    {
        string prevLoc = _parser.CurrentLocation;
        string prevWorld = _parser.CurrentWorldName;
        int prevPlayers = _parser.CurrentPlayerCount;

        GameLogEventItem? ev = _parser.ParseLine(line);
        if (ev != null)
        {
            if (ev.Type != "Location")
            {
                GameLogEventItem? pendingLoc = _parser.FlushPendingLocation();
                if (pendingLoc != null)
                {
                    batch.Add(pendingLoc);
                }
            }
            batch.Add(ev);
            _cursor.LastEventDt = ev.CreatedAt;

            if (!string.IsNullOrEmpty(ev.LocalScreenshotPath))
            {
                // Capture the exact room/player state at the moment of the screenshot line before subsequent
                // OnLeftRoom / Joining / log rotation events mutate _parser.
                ev.CapturedRoomSnapshot = CaptureLiveRoomSnapshotLocked();
                screenshots.Add(ev);
            }
        }

        if (prevLoc != _parser.CurrentLocation || prevWorld != _parser.CurrentWorldName || prevPlayers != _parser.CurrentPlayerCount)
        {
            stateMutated = true;
        }
    }

    private int ReadLatestLogFile(
        string latestFile,
        List<GameLogEventItem> screenshots,
        out bool cursorUpdated,
        out bool stateMutated)
    {
        cursorUpdated = false;
        stateMutated = false;
        string fileName = Path.GetFileName(latestFile);
        long fileLen;
        try
        {
            fileLen = new FileInfo(latestFile).Length;
        }
        catch
        {
            return 0;
        }

        long persistedOffset;
        bool fileTruncated = false;
        if (_cursor.FileOffsets.TryGetValue(fileName, out long mappedOffset))
        {
            if (fileLen < mappedOffset)
            {
                persistedOffset = 0;
                fileTruncated = true;
            }
            else
            {
                persistedOffset = mappedOffset;
            }
        }
        else if (string.Equals(_cursor.FileName, fileName, StringComparison.OrdinalIgnoreCase))
        {
            if (fileLen < _cursor.ByteOffset)
            {
                persistedOffset = 0;
                fileTruncated = true;
            }
            else
            {
                persistedOffset = _cursor.ByteOffset;
            }
        }
        else
        {
            persistedOffset = 0;
        }

        if (_pendingLocationDiskOffset >= 0 &&
            string.Equals(_pendingLocationFileName, fileName, StringComparison.OrdinalIgnoreCase) &&
            fileLen < _liveReadMemoryOffset)
        {
            fileTruncated = true;
        }

        if (fileTruncated)
        {
            // Active file was truncated in place; reset transient parser/pending state so cursor never pins at 0.
            _parser.ResetSessionState();
            ClearPendingLocationTracking();
            _liveParserWarmupDone = true;
        }

        bool hasTrackedPendingForFile =
            _parser.HasPendingLocation &&
            _pendingLocationDiskOffset >= 0 &&
            _liveReadMemoryOffset >= _pendingLocationDiskOffset &&
            fileLen >= _liveReadMemoryOffset &&
            string.Equals(_pendingLocationFileName, fileName, StringComparison.OrdinalIgnoreCase);

        if (!hasTrackedPendingForFile)
        {
            ClearPendingLocationTracking();
        }

        long offset = hasTrackedPendingForFile ? _liveReadMemoryOffset : persistedOffset;

        if (persistedOffset > 0 && !_liveParserWarmupDone)
        {
            WarmUpLiveParserFromPrefix(latestFile, persistedOffset);
        }
        else
        {
            _liveParserWarmupDone = true;
        }

        if (!string.Equals(_cursor.FileName, fileName, StringComparison.OrdinalIgnoreCase))
        {
            _cursor.FileName = fileName;
            _cursor.ByteOffset = persistedOffset;
            cursorUpdated = true;
        }

        bool IsPendingTimedOut() =>
            _parser.HasPendingLocation &&
            (PendingLocationFlushDelay <= TimeSpan.Zero ||
             (_pendingLocationDetectedAtMonoMs > 0 &&
              (Environment.TickCount64 - _pendingLocationDetectedAtMonoMs) >= (long)PendingLocationFlushDelay.TotalMilliseconds));

        if (fileLen <= offset)
        {
            if (hasTrackedPendingForFile && IsPendingTimedOut())
            {
                GameLogEventItem? flushed = _parser.FlushPendingLocation();
                ClearPendingLocationTracking();
                int flushedCount = 0;
                if (flushed != null)
                {
                    EnqueueEventsBatch(new List<GameLogEventItem> { flushed });
                    _cursor.LastEventDt = flushed.CreatedAt;
                    flushedCount = 1;
                }
                _cursor.FileName = fileName;
                _cursor.ByteOffset = offset;
                _cursor.FileOffsets[fileName] = offset;
                cursorUpdated = true;
                return flushedCount;
            }

            if (_cursor.ByteOffset != persistedOffset || !_cursor.FileOffsets.ContainsKey(fileName))
            {
                _cursor.ByteOffset = persistedOffset;
                _cursor.FileOffsets[fileName] = persistedOffset;
                cursorUpdated = true;
            }
            return 0;
        }

        long initialOffset = offset;
        List<(string Line, long LineStartOffset, long LineEndOffset)> completeLines;
        long endPosition;
        try
        {
            // When one or more oversized (>8 MiB) single noise lines are skipped (completeLines empty while endPosition advances),
            // advance past them and continue reading subsequent ready lines in the same poll cycle (bounded to 8 skips).
            int skippedOversized = 0;
            while (true)
            {
                completeLines = ReadCompleteLinesWithOffsets(latestFile, offset, out endPosition);
                if (completeLines.Count == 0 && endPosition > offset && endPosition < fileLen && skippedOversized < 8)
                {
                    offset = endPosition;
                    skippedOversized++;
                    continue;
                }
                break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read active VRChat log {File}", fileName);
            return 0;
        }

        if (endPosition <= initialOffset)
        {
            // Even when a partial trailing line without '\n' is waiting, flush an expired pending Joining line
            // and advance the persisted cursor up to `initialOffset` (never past the incomplete line).
            if (hasTrackedPendingForFile && IsPendingTimedOut())
            {
                GameLogEventItem? flushed = _parser.FlushPendingLocation();
                ClearPendingLocationTracking();
                int flushedCount = 0;
                if (flushed != null)
                {
                    EnqueueEventsBatch(new List<GameLogEventItem> { flushed });
                    _cursor.LastEventDt = flushed.CreatedAt;
                    flushedCount = 1;
                }
                _cursor.FileName = fileName;
                _cursor.ByteOffset = initialOffset;
                _cursor.FileOffsets[fileName] = initialOffset;
                cursorUpdated = true;
                return flushedCount;
            }
            return 0;
        }

        long safeDiskOffset = hasTrackedPendingForFile ? _pendingLocationDiskOffset : endPosition;
        var batch = new List<GameLogEventItem>();
        foreach ((string line, long lineStart, long lineEnd) in completeLines)
        {
            bool hadPendingBefore = _parser.HasPendingLocation;
            int batchCountBefore = batch.Count;
            ProcessLiveLine(line, batch, screenshots, ref stateMutated);
            bool hasPendingAfter = _parser.HasPendingLocation;

            if (!hasPendingAfter)
            {
                safeDiskOffset = lineEnd;
                ClearPendingLocationTracking();
            }
            else if (!hadPendingBefore || batch.Count > batchCountBefore)
            {
                // Keep the persisted cursor strictly BEFORE an un-emitted Joining line so an unexpected restart
                // replays and recovers the Location event instead of skipping past it.
                safeDiskOffset = lineStart;
                _pendingLocationFileName = fileName;
                _pendingLocationDiskOffset = lineStart;
                _pendingLocationDetectedAtMonoMs = Environment.TickCount64;
            }
        }

        if (completeLines.Count == 0 && !_parser.HasPendingLocation)
        {
            safeDiskOffset = endPosition;
        }

        if (IsPendingTimedOut())
        {
            GameLogEventItem? flushed = _parser.FlushPendingLocation();
            if (flushed != null)
            {
                batch.Add(flushed);
                _cursor.LastEventDt = flushed.CreatedAt;
            }
            safeDiskOffset = endPosition;
            ClearPendingLocationTracking();
        }
        else if (_parser.HasPendingLocation)
        {
            _liveReadMemoryOffset = endPosition;
        }

        if (batch.Count > 0)
        {
            EnqueueEventsBatch(batch);
        }

        _cursor.FileName = fileName;
        _cursor.ByteOffset = safeDiskOffset;
        _cursor.FileOffsets[fileName] = safeDiskOffset;
        cursorUpdated = true;

        return batch.Count;
    }

    private void PruneTrackedOffsets(List<string> existingFilePaths)
    {
        if (_cursor.FileOffsets.Count <= MaxTrackedLogFiles) return;
        var existingNames = new HashSet<string>(
            existingFilePaths.Select(Path.GetFileName).Where(n => !string.IsNullOrEmpty(n))!,
            StringComparer.OrdinalIgnoreCase);
        foreach (string key in _cursor.FileOffsets.Keys.ToList())
        {
            if (_cursor.FileOffsets.Count <= MaxTrackedLogFiles) break;
            if (!existingNames.Contains(key) && !string.Equals(key, _cursor.FileName, StringComparison.OrdinalIgnoreCase))
            {
                _cursor.FileOffsets.Remove(key);
            }
        }
    }

    public void EnqueueEvent(GameLogEventItem item)
    {
        lock (_queue)
        {
            if (_queue.Count >= MaxOfflineQueueEntries)
            {
                int drop = _queue.Count - MaxOfflineQueueEntries + 1;
                _queue.RemoveRange(0, drop);
                _queueHeadSeq += drop;
            }
            _queue.Add(item);
            PersistQueueLocked();
        }
    }

    private void EnqueueEventsBatch(IReadOnlyList<GameLogEventItem> items)
    {
        if (items.Count == 0) return;
        lock (_queue)
        {
            _queue.AddRange(items);
            if (_queue.Count > MaxOfflineQueueEntries)
            {
                int drop = _queue.Count - MaxOfflineQueueEntries;
                _queue.RemoveRange(0, drop);
                _queueHeadSeq += drop;
            }
            PersistQueueLocked();
        }
    }

    private void LoadPersistedState()
    {
        try
        {
            if (File.Exists(_cursorPath))
            {
                string raw = File.ReadAllText(_cursorPath, Encoding.UTF8);
                var parsed = JsonConvert.DeserializeObject<LogCursorState>(raw);
                if (parsed != null)
                {
                    _cursor = parsed;
                    _cursor.FileOffsets = _cursor.FileOffsets != null
                        ? new Dictionary<string, long>(_cursor.FileOffsets, StringComparer.OrdinalIgnoreCase)
                        : new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
                    // Migrate legacy single-file cursor.json cleanly without re-reading the active file.
                    if (!string.IsNullOrWhiteSpace(_cursor.FileName) && !_cursor.FileOffsets.ContainsKey(_cursor.FileName))
                    {
                        _cursor.FileOffsets[_cursor.FileName] = _cursor.ByteOffset;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read log cursor state; starting fresh.");
        }

        try
        {
            if (File.Exists(_queuePath))
            {
                int corruptedLines = 0;
                foreach (string line in File.ReadLines(_queuePath, Encoding.UTF8))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try
                    {
                        var item = JsonConvert.DeserializeObject<GameLogEventItem>(line);
                        if (item != null)
                        {
                            _queue.Add(item);
                        }
                    }
                    catch
                    {
                        corruptedLines++;
                    }
                }
                if (corruptedLines > 0)
                {
                    Log.Warn("Skipped {Count} corrupted line(s) while loading offline queue; recovered {Valid} valid event(s).", corruptedLines, _queue.Count);
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read offline queue; starting empty.");
        }
    }

    private void SaveCursor()
    {
        string tmp = $"{_cursorPath}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(tmp, JsonConvert.SerializeObject(_cursor, Formatting.Indented), Encoding.UTF8);
            File.Move(tmp, _cursorPath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Failed to persist log cursor.");
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* ignore */ }
        }
    }

    private void PersistQueueLocked()
    {
        string tmp = $"{_queuePath}.{Guid.NewGuid():N}.tmp";
        try
        {
            using (var sw = new StreamWriter(tmp, append: false, Encoding.UTF8))
            {
                foreach (var item in _queue)
                {
                    sw.WriteLine(JsonConvert.SerializeObject(item));
                }
            }
            File.Move(tmp, _queuePath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Failed to persist offline queue.");
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* ignore */ }
        }
    }
}
