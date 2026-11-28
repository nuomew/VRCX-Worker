using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NLog;

namespace VRCX.Agent.Core;

public sealed class LegacyCategoryInventory
{
    [JsonProperty("key")]
    public string Key { get; set; } = string.Empty;

    [JsonProperty("rowCount")]
    public long RowCount { get; set; }

    [JsonProperty("rawBytes")]
    public long RawBytes { get; set; }

    [JsonProperty("estimatedDbBytes")]
    public long EstimatedDbBytes { get; set; }

    [JsonProperty("tables")]
    public List<string> Tables { get; set; } = new();
}

public sealed class LegacyAccountInventory
{
    [JsonProperty("prefix")]
    public string Prefix { get; set; } = string.Empty;

    [JsonProperty("label")]
    public string Label { get; set; } = string.Empty;

    [JsonProperty("categories")]
    public List<LegacyCategoryInventory> Categories { get; set; } = new();
}

public sealed class LegacyDesktopInventoryReport
{
    [JsonProperty("deviceName")]
    public string DeviceName { get; set; } = string.Empty;

    [JsonProperty("dbFound")]
    public bool DbFound { get; set; }

    [JsonProperty("dbFileName")]
    public string DbFileName { get; set; } = "VRCX.sqlite3";

    [JsonProperty("dbFileBytes")]
    public long DbFileBytes { get; set; }

    [JsonProperty("errorMessage", NullValueHandling = NullValueHandling.Ignore)]
    public string? ErrorMessage { get; set; }

    [JsonProperty("sharedCategories")]
    public List<LegacyCategoryInventory> SharedCategories { get; set; } = new();

    [JsonProperty("accounts")]
    public List<LegacyAccountInventory> Accounts { get; set; } = new();
}

public sealed class LegacyMigrationBatchResponse
{
    [JsonProperty("inserted")]
    public int Inserted { get; set; }

    [JsonProperty("skipped")]
    public int Skipped { get; set; }

    [JsonProperty("legacyDbBytes")]
    public long LegacyDbBytes { get; set; }

    [JsonProperty("shouldStop")]
    public bool ShouldStop { get; set; }

    [JsonProperty("reason")]
    public string? Reason { get; set; }
}

public sealed class LegacyTableCursor
{
    [JsonProperty("createdAt")]
    public string CreatedAt { get; set; } = string.Empty;

    [JsonProperty("rowId")]
    public long RowId { get; set; }

    [JsonProperty("completed")]
    public bool Completed { get; set; }

    [JsonProperty("rowsDone")]
    public long RowsDone { get; set; }

    [JsonProperty("updatedAt", NullValueHandling = NullValueHandling.Ignore)]
    public string? UpdatedAt { get; set; }
}

public sealed class LegacyMigrationCursorUpdate
{
    [JsonProperty("table")]
    public string Table { get; set; } = string.Empty;

    [JsonProperty("createdAt")]
    public string CreatedAt { get; set; } = string.Empty;

    [JsonProperty("rowId")]
    public long RowId { get; set; }

    [JsonProperty("completed")]
    public bool Completed { get; set; }

    [JsonProperty("rowsDone")]
    public long RowsDone { get; set; }
}

/// <summary>
/// Strictly read-only scanner and batched uploader for upstream original desktop VRCX (`%AppData%\VRCX\VRCX.sqlite3`).
/// Never writes to or locks the desktop database, strips all credentials/cookies/proxies before upload,
/// and never accepts arbitrary disk paths from remote commands (R.A.I.L.G.U.A.R.D.).
/// </summary>
public static class DesktopLegacyMigrator
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    public const int MinConcurrency = 1;
    public const int MaxConcurrency = 8;
    public const int DefaultConcurrency = 2;
    private const int BatchRowsLimit = 240;
    private const int MaxBatchPayloadBytes = 180 * 1024;
    // Logical tables whose cloud ingest writes directly into <=1,000-row / <=512 KiB D1 chunks,
    // cutting D1 rows_written by >99.5% (single-row tables like friend_log_current keep 240-row batches).
    private const int CompactBatchRowsLimit = 1000;
    private const int CompactMaxBatchPayloadBytes = 512 * 1024;
    private static readonly HashSet<string> CompactChunkLogicalTables = new(StringComparer.Ordinal)
    {
        "feed_gps",
        "feed_online_offline",
        "feed_status",
        "feed_bio",
        "gamelog_location",
        "gamelog_join_leave",
        "gamelog_portal_spawn",
        "gamelog_video_play",
        "gamelog_event",
        "gamelog_external",
        "friend_log_history",
        "notifications",
        "notifications_v2"
    };
    private const int MaxSingleFieldChars = 16384;
    private const int MaxBatchRetryAttempts = 3;
    private const int SampleHalfRows = 200;

    public static readonly IReadOnlyList<string> AllowedCategories = new[]
    {
        "memos_notes",
        "favorites",
        "avatar_history",
        "friend_log",
        "notifications",
        "moderation_profiles",
        "gamelog",
        "feed",
        "settings"
    };

    public static readonly IReadOnlySet<string> AllowedCategorySet =
        new HashSet<string>(AllowedCategories, StringComparer.Ordinal);

    private static readonly Regex SafeAccountPrefixRegex = new(
        @"^[A-Za-z_][A-Za-z0-9_]{2,64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex SafeLogicalTableRegex = new(
        @"^[a-z0-9_]{2,48}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex UserTableSuffixRegex = new(
        @"^([A-Za-z_][A-Za-z0-9_]{2,64})_(feed_gps|feed_online_offline|feed_status|feed_bio|friend_log_current|friend_log_history|notifications|notifications_v2|moderation|avatar_history|notes|user_profile)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly string[] SensitiveOrDesktopConfigFragments =
    {
        "savedcredentials",
        "password",
        "cookie",
        "token",
        "secret",
        "apikey",
        "api_key",
        "auth",
        "proxy",
        "endpoint",
        "databaselocation",
        "vrclaunch",
        "launchpath",
        "launchcommand",
        "autolaunch",
        "customcss",
        "customscript",
        "translationapi",
        "primarypassword",
        "twofactor",
        "totp",
        "discord",
        "xsoverlay",
        "ovrtoolkit",
        "startup",
        "minimized",
        "closetotray",
        "gpuacceleration",
        "autoupdate",
        "zoomlevel",
        "vrcx_navwidth",
        "cloud:"
    };

    public static bool IsValidAccountPrefix(string? prefix)
    {
        return !string.IsNullOrWhiteSpace(prefix) && SafeAccountPrefixRegex.IsMatch(prefix.Trim());
    }

    public static bool IsValidLogicalTableName(string? tableName)
    {
        return !string.IsNullOrWhiteSpace(tableName) && SafeLogicalTableRegex.IsMatch(tableName.Trim());
    }

    public static Dictionary<string, LegacyTableCursor> ParseResumeCursors(object? raw)
    {
        var result = new Dictionary<string, LegacyTableCursor>(StringComparer.Ordinal);
        if (raw == null) return result;

        if (raw is IReadOnlyDictionary<string, LegacyTableCursor> typed)
        {
            foreach (var kv in typed)
            {
                string key = kv.Key?.Trim() ?? string.Empty;
                if (!SafeLogicalTableRegex.IsMatch(key) || kv.Value == null) continue;
                result[key] = new LegacyTableCursor
                {
                    CreatedAt = (kv.Value.CreatedAt ?? string.Empty).Trim(),
                    RowId = Math.Max(0, kv.Value.RowId),
                    Completed = kv.Value.Completed,
                    RowsDone = Math.Max(0, kv.Value.RowsDone),
                    UpdatedAt = kv.Value.UpdatedAt
                };
            }
            return result;
        }

        JObject? obj = raw as JObject;
        if (obj == null)
        {
            try
            {
                obj = JObject.FromObject(raw);
            }
            catch
            {
                return result;
            }
        }

        foreach (JProperty prop in obj.Properties())
        {
            string key = prop.Name.Trim();
            if (!SafeLogicalTableRegex.IsMatch(key) || prop.Value is not JObject cObj) continue;
            string createdAt = (cObj["createdAt"]?.Value<string>() ?? string.Empty).Trim();
            if (createdAt.Length > 64) createdAt = createdAt.Substring(0, 64);
            long rowId = Math.Max(0, cObj["rowId"]?.Value<long?>() ?? 0);
            bool completed = cObj["completed"]?.Value<bool?>() == true;
            long rowsDone = Math.Max(0, cObj["rowsDone"]?.Value<long?>() ?? 0);
            string? updatedAt = cObj["updatedAt"]?.Value<string>();
            result[key] = new LegacyTableCursor
            {
                CreatedAt = createdAt,
                RowId = rowId,
                Completed = completed,
                RowsDone = rowsDone,
                UpdatedAt = updatedAt
            };
        }
        return result;
    }

    public static bool IsSafeLegacyConfigKey(string? rawKey)
    {
        if (string.IsNullOrWhiteSpace(rawKey)) return false;
        string trimmed = rawKey.Trim();
        if (trimmed.Length > 160) return false;
        string lower = trimmed.ToLowerInvariant();
        foreach (string frag in SensitiveOrDesktopConfigFragments)
        {
            if (lower.Contains(frag, StringComparison.Ordinal))
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>
    /// Resolves the local original desktop VRCX database path (`%AppData%\VRCX\VRCX.sqlite3`),
    /// honoring custom `VRCX_DatabaseLocation` stored in `%AppData%\VRCX\VRCX.json`.
    /// </summary>
    public static string ResolveDesktopVrcxDatabasePath(string? vrcxAppDataDirOverride = null)
    {
        string vrcxDir = !string.IsNullOrWhiteSpace(vrcxAppDataDirOverride)
            ? vrcxAppDataDirOverride.Trim()
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "VRCX");

        string defaultDbPath = Path.Combine(vrcxDir, "VRCX.sqlite3");
        try
        {
            string jsonPath = Path.Combine(vrcxDir, "VRCX.json");
            if (File.Exists(jsonPath))
            {
                string raw = File.ReadAllText(jsonPath, Encoding.UTF8);
                if (!string.IsNullOrWhiteSpace(raw))
                {
                    var obj = JsonConvert.DeserializeObject<JObject>(raw);
                    string? customPath = obj?.Value<string>("VRCX_DatabaseLocation")?.Trim();
                    if (!string.IsNullOrWhiteSpace(customPath) && File.Exists(customPath))
                    {
                        return customPath;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Failed to read VRCX.json custom database location; using default path.");
        }

        return defaultDbPath;
    }

    private static SqliteConnection OpenReadOnly(string dbPath)
    {
        var csb = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
            DefaultTimeout = 5
        };
        var conn = new SqliteConnection(csb.ToString());
        conn.Open();
        using (var pragma = conn.CreateCommand())
        {
            pragma.CommandText = "PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;";
            pragma.ExecuteNonQuery();
        }
        return conn;
    }

    private static HashSet<string> ListTableNames(SqliteConnection conn)
    {
        var tables = new HashSet<string>(StringComparer.Ordinal);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table'";
        using SqliteDataReader reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            if (!reader.IsDBNull(0))
            {
                string name = reader.GetString(0);
                if (!string.IsNullOrWhiteSpace(name))
                {
                    tables.Add(name);
                }
            }
        }
        return tables;
    }

    private static HashSet<string> ListColumns(SqliteConnection conn, string tableName)
    {
        var cols = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"PRAGMA table_info(\"{tableName}\")";
        using SqliteDataReader reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            if (!reader.IsDBNull(1))
            {
                cols.Add(reader.GetString(1));
            }
        }
        return cols;
    }

    private static long EstimateD1Bytes(long rowCount, long rawBytes, bool compactChunked = false)
    {
        if (rowCount <= 0) return 0;
        if (compactChunked)
        {
            // Historical Feed rows are stored in compact JSON tuple chunks (~240 rows per 1 D1 row),
            // eliminating per-row B-tree index & FTS5 dictionary amplification.
            return Math.Max(4096L, (long)Math.Ceiling(rawBytes * 1.05));
        }
        // Accounts for SQLite B-tree page overhead, secondary indexes, unique constraints, and FTS5 dictionary entries.
        return Math.Max(4096L, (long)Math.Ceiling(rawBytes * 1.45 + rowCount * 48.0));
    }

    private static (long RowCount, long RawBytes) MeasureTableFootprint(SqliteConnection conn, string tableName, bool filterSafeConfigs = false)
    {
        if (filterSafeConfigs)
        {
            long count = 0;
            long bytes = 0;
            using var cfgCmd = conn.CreateCommand();
            cfgCmd.CommandText = $"SELECT key, value FROM \"{tableName}\"";
            using SqliteDataReader r = cfgCmd.ExecuteReader();
            while (r.Read())
            {
                string k = r.IsDBNull(0) ? string.Empty : Convert.ToString(r.GetValue(0)) ?? string.Empty;
                if (!IsSafeLegacyConfigKey(k)) continue;
                string v = r.IsDBNull(1) ? string.Empty : Convert.ToString(r.GetValue(1)) ?? string.Empty;
                count++;
                bytes += Encoding.UTF8.GetByteCount(k) + Encoding.UTF8.GetByteCount(v) + 24;
            }
            return (count, bytes);
        }

        long totalRows = 0;
        using (var cntCmd = conn.CreateCommand())
        {
            cntCmd.CommandText = $"SELECT COUNT(*) FROM \"{tableName}\"";
            object? scalar = cntCmd.ExecuteScalar();
            totalRows = scalar != null && scalar != DBNull.Value ? Convert.ToInt64(scalar) : 0;
        }
        if (totalRows <= 0) return (0, 0);

        long sampleRows = 0;
        long sampleBytes = 0;

        static (long Rows, long Bytes) ReadSample(SqliteConnection c, string sql)
        {
            long rows = 0;
            long bytes = 0;
            using var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            using SqliteDataReader reader = cmd.ExecuteReader();
            int fieldCount = reader.FieldCount;
            while (reader.Read())
            {
                rows++;
                long rowBytes = 16;
                for (int i = 0; i < fieldCount; i++)
                {
                    if (reader.IsDBNull(i)) continue;
                    object val = reader.GetValue(i);
                    if (val is string s)
                    {
                        rowBytes += Encoding.UTF8.GetByteCount(s);
                    }
                    else if (val is byte[] b)
                    {
                        rowBytes += b.Length;
                    }
                    else
                    {
                        rowBytes += 8;
                    }
                }
                bytes += rowBytes;
            }
            return (rows, bytes);
        }

        if (totalRows <= SampleHalfRows * 2)
        {
            (sampleRows, sampleBytes) = ReadSample(conn, $"SELECT * FROM \"{tableName}\"");
            return (totalRows, sampleBytes);
        }

        (long headRows, long headBytes) = ReadSample(conn, $"SELECT * FROM \"{tableName}\" ORDER BY rowid ASC LIMIT {SampleHalfRows}");
        (long tailRows, long tailBytes) = ReadSample(conn, $"SELECT * FROM \"{tableName}\" ORDER BY rowid DESC LIMIT {SampleHalfRows}");
        sampleRows = headRows + tailRows;
        sampleBytes = headBytes + tailBytes;
        double avgBytesPerRow = sampleRows > 0 ? (double)sampleBytes / sampleRows : 160.0;
        long estimatedRaw = (long)Math.Ceiling(avgBytesPerRow * totalRows);
        return (totalRows, estimatedRaw);
    }

    private static string FormatAccountLabel(string prefix)
    {
        // Format `usr` + 32 hex chars back into readable `usr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
        if (prefix.StartsWith("usr", StringComparison.OrdinalIgnoreCase) && prefix.Length == 35)
        {
            string hex = prefix.Substring(3);
            if (hex.All(Uri.IsHexDigit))
            {
                return $"usr_{hex[..8]}-{hex[8..12]}-{hex[12..16]}-{hex[16..20]}-{hex[20..]}";
            }
        }
        return prefix;
    }

    /// <summary>
    /// Inspects the local original desktop VRCX database in read-only mode and computes exact row counts
    /// and estimated Cloudflare D1 storage footprints per category and account.
    /// </summary>
    public static LegacyDesktopInventoryReport ScanDatabase(string dbPath, string deviceName = "")
    {
        var report = new LegacyDesktopInventoryReport
        {
            DeviceName = deviceName,
            DbFileName = string.IsNullOrWhiteSpace(dbPath) ? "VRCX.sqlite3" : Path.GetFileName(dbPath)
        };

        if (string.IsNullOrWhiteSpace(dbPath) || !File.Exists(dbPath))
        {
            report.DbFound = false;
            return report;
        }

        try
        {
            report.DbFileBytes = new FileInfo(dbPath).Length;
            using SqliteConnection conn = OpenReadOnly(dbPath);
            HashSet<string> tables = ListTableNames(conn);
            report.DbFound = true;

            void AddCategoryMeasurement(
                List<LegacyCategoryInventory> targetList,
                string categoryKey,
                IEnumerable<string> tableNames,
                bool filterSafeConfigs = false)
            {
                long totalRows = 0;
                long totalRaw = 0;
                var matchedTables = new List<string>();
                foreach (string tbl in tableNames)
                {
                    if (!tables.Contains(tbl)) continue;
                    var (rows, raw) = MeasureTableFootprint(conn, tbl, filterSafeConfigs);
                    matchedTables.Add(tbl);
                    totalRows += rows;
                    totalRaw += raw;
                }
                if (matchedTables.Count > 0 || totalRows > 0)
                {
                    targetList.Add(new LegacyCategoryInventory
                    {
                        Key = categoryKey,
                        RowCount = totalRows,
                        RawBytes = totalRaw,
                        EstimatedDbBytes = EstimateD1Bytes(totalRows, totalRaw, compactChunked: categoryKey == "feed"),
                        Tables = matchedTables
                    });
                }
            }

            // Shared global desktop tables (not prefixed by userPrefix)
            AddCategoryMeasurement(report.SharedCategories, "memos_notes", new[] { "memos", "world_memos", "avatar_memos" });
            AddCategoryMeasurement(report.SharedCategories, "favorites", new[] { "favorite_friend", "favorite_world", "favorite_avatar", "favorite_print", "avatar_tags" });
            AddCategoryMeasurement(report.SharedCategories, "gamelog", new[] { "gamelog_location", "gamelog_join_leave", "gamelog_portal_spawn", "gamelog_video_play", "gamelog_event", "gamelog_external" });
            AddCategoryMeasurement(report.SharedCategories, "settings", new[] { "configs" }, filterSafeConfigs: true);

            // Discover per-account prefixed tables (`<userPrefix>_feed_gps`, `<userPrefix>_notes`, etc.)
            var discoveredPrefixes = new HashSet<string>(StringComparer.Ordinal);
            foreach (string tbl in tables)
            {
                Match m = UserTableSuffixRegex.Match(tbl);
                if (m.Success)
                {
                    discoveredPrefixes.Add(m.Groups[1].Value);
                }
            }

            var accountReports = new List<(LegacyAccountInventory Account, long Score)>();
            foreach (string prefix in discoveredPrefixes.OrderBy(p => p, StringComparer.Ordinal))
            {
                var acc = new LegacyAccountInventory
                {
                    Prefix = prefix,
                    Label = FormatAccountLabel(prefix)
                };
                AddCategoryMeasurement(acc.Categories, "memos_notes", new[] { $"{prefix}_notes" });
                AddCategoryMeasurement(acc.Categories, "avatar_history", new[] { $"{prefix}_avatar_history" });
                AddCategoryMeasurement(acc.Categories, "friend_log", new[] { $"{prefix}_friend_log_current", $"{prefix}_friend_log_history" });
                AddCategoryMeasurement(acc.Categories, "notifications", new[] { $"{prefix}_notifications", $"{prefix}_notifications_v2" });
                AddCategoryMeasurement(acc.Categories, "moderation_profiles", new[] { $"{prefix}_moderation", $"{prefix}_user_profile" });
                AddCategoryMeasurement(acc.Categories, "feed", new[] { $"{prefix}_feed_gps", $"{prefix}_feed_online_offline", $"{prefix}_feed_status", $"{prefix}_feed_bio" });

                long totalAccountRows = acc.Categories.Sum(c => c.RowCount);
                accountReports.Add((acc, totalAccountRows));
            }

            // Show the most active desktop account first
            report.Accounts = accountReports
                .OrderByDescending(x => x.Score)
                .Select(x => x.Account)
                .ToList();
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to scan desktop VRCX database {Path}.", dbPath);
            report.DbFound = false;
            report.ErrorMessage = ex.Message;
        }

        return report;
    }

    private static string GetColStr(SqliteDataReader r, Dictionary<string, int> ordinals, string colName)
    {
        if (!ordinals.TryGetValue(colName, out int idx) || r.IsDBNull(idx)) return string.Empty;
        return Convert.ToString(r.GetValue(idx)) ?? string.Empty;
    }

    private static long GetColLong(SqliteDataReader r, Dictionary<string, int> ordinals, string colName)
    {
        if (!ordinals.TryGetValue(colName, out int idx) || r.IsDBNull(idx)) return 0;
        try
        {
            return Convert.ToInt64(r.GetValue(idx));
        }
        catch
        {
            return 0;
        }
    }

    private static Dictionary<string, int> BuildOrdinalMap(SqliteDataReader reader)
    {
        var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < reader.FieldCount; i++)
        {
            map[reader.GetName(i)] = i;
        }
        return map;
    }

    private static void ClampOversizedStringFields(Dictionary<string, object?> item, int maxChars)
    {
        if (maxChars <= 0 || item.Count == 0) return;
        foreach (string key in item.Keys.ToList())
        {
            if (item[key] is string s && s.Length > maxChars)
            {
                int cut = maxChars;
                if (cut > 0 && char.IsHighSurrogate(s[cut - 1]))
                {
                    cut--;
                }
                item[key] = s.Substring(0, cut);
            }
        }
    }

    private static bool IsTransientBatchError(Exception ex, CancellationToken externalCt)
    {
        if (externalCt.IsCancellationRequested) return false;
        if (ex is TaskCanceledException) return true; // HttpClient request timeout
        if (ex is HttpRequestException httpEx)
        {
            if (httpEx.StatusCode == null) return true; // network/socket error
            int code = (int)httpEx.StatusCode.Value;
            return code == (int)HttpStatusCode.TooManyRequests ||
                   code == (int)HttpStatusCode.RequestTimeout ||
                   code >= 500;
        }
        return false;
    }

    private sealed class MigrationBatchWorkItem
    {
        public int Seq { get; init; }
        public List<Dictionary<string, object?>> Items { get; init; } = new();
        public string LastCreatedAt { get; init; } = string.Empty;
        public long LastRowId { get; init; }
        public int RowCount { get; init; }
    }

    /// <summary>
    /// Tracks contiguous confirmed batch watermarks for a single logical table under concurrent uploads.
    /// The safe cursor only advances across uninterrupted sequence numbers 0..k so an early stop or
    /// failure can never skip unconfirmed batches when resuming later.
    /// </summary>
    private sealed class TableWatermarkTracker
    {
        private readonly object _gate = new();
        private readonly string _logicalTable;
        private readonly int _reportEveryBatches;
        private readonly Dictionary<int, (string CreatedAt, long RowId, int RowCount)> _acked = new();
        private int _nextExpectedSeq;
        private string _safeCreatedAt;
        private long _safeRowId;
        private long _safeRowsDone;
        private int _batchesSinceReport;
        private bool _hasUnreportedProgress;

        public TableWatermarkTracker(string logicalTable, LegacyTableCursor? initialCursor, int effectiveConcurrency)
        {
            _logicalTable = logicalTable;
            _reportEveryBatches = Math.Max(1, effectiveConcurrency / 2);
            _safeCreatedAt = initialCursor?.CreatedAt ?? string.Empty;
            _safeRowId = initialCursor?.RowId ?? 0;
            _safeRowsDone = initialCursor?.RowsDone ?? 0;
        }

        public void RecordAck(int seq, string lastCreatedAt, long lastRowId, int rowCount)
        {
            lock (_gate)
            {
                _acked[seq] = (lastCreatedAt, lastRowId, rowCount);
                while (_acked.Remove(_nextExpectedSeq, out var meta))
                {
                    _safeCreatedAt = meta.CreatedAt;
                    _safeRowId = meta.RowId;
                    _safeRowsDone += meta.RowCount;
                    _nextExpectedSeq++;
                    _batchesSinceReport++;
                    _hasUnreportedProgress = true;
                }
            }
        }

        public LegacyMigrationCursorUpdate? TryTakePiggybackUpdate(bool force = false)
        {
            lock (_gate)
            {
                if (!_hasUnreportedProgress) return null;
                if (!force && _batchesSinceReport < _reportEveryBatches) return null;
                _batchesSinceReport = 0;
                _hasUnreportedProgress = false;
                return new LegacyMigrationCursorUpdate
                {
                    Table = _logicalTable,
                    CreatedAt = _safeCreatedAt,
                    RowId = _safeRowId,
                    Completed = false,
                    RowsDone = _safeRowsDone
                };
            }
        }

        public LegacyMigrationCursorUpdate BuildCompletedUpdate()
        {
            lock (_gate)
            {
                _batchesSinceReport = 0;
                _hasUnreportedProgress = false;
                return new LegacyMigrationCursorUpdate
                {
                    Table = _logicalTable,
                    CreatedAt = _safeCreatedAt,
                    RowId = _safeRowId,
                    Completed = true,
                    RowsDone = _safeRowsDone
                };
            }
        }
    }

    private static async Task<LegacyMigrationBatchResponse> PostMigrationBatchWithRetryAsync(
        HttpSyncClient syncClient,
        AgentConfig config,
        string jobId,
        string category,
        IReadOnlyList<Dictionary<string, object?>> items,
        bool categoryDone,
        bool allDone,
        string? errorMessage,
        CancellationToken ct,
        LegacyMigrationCursorUpdate? cursorUpdate = null)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                return await syncClient
                    .PostMigrationBatchAsync(config, jobId, category, items, categoryDone, allDone, errorMessage, ct, cursorUpdate)
                    .ConfigureAwait(false);
            }
            catch (Exception ex) when (attempt < MaxBatchRetryAttempts && IsTransientBatchError(ex, ct))
            {
                int delayMs = attempt switch
                {
                    0 => 500,
                    1 => 1500,
                    _ => 3500
                };
                Log.Warn(ex, "Transient migration batch error for {JobId}/{Category} (attempt {Attempt}/{Max}); retrying in {DelayMs}ms.",
                    jobId, category, attempt + 1, MaxBatchRetryAttempts, delayMs);
                await Task.Delay(delayMs, ct).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Streams selected categories from the read-only desktop VRCX database in bounded per-table batches
    /// into the dedicated cloud DB_LEGACY database, supporting cloud-configured concurrency,
    /// deterministic table-level cursor resume checkpoints, contiguous watermark tracking,
    /// transient batch retries, cancellation, and server quota stop signals.
    /// </summary>
    public static async Task<(bool Completed, long UploadedBatches, string Message)> RunMigrationAsync(
        AgentConfig config,
        string dbPath,
        string jobId,
        string accountPrefix,
        IReadOnlyList<string> categories,
        HttpSyncClient syncClient,
        CancellationToken ct,
        int concurrency = 1,
        IReadOnlyDictionary<string, LegacyTableCursor>? resumeCursors = null)
    {
        if (string.IsNullOrWhiteSpace(dbPath) || !File.Exists(dbPath))
        {
            await syncClient
                .PostMigrationBatchAsync(config, jobId, string.Empty, Array.Empty<Dictionary<string, object?>>(), false, true, "Desktop VRCX.sqlite3 not found on this PC.", ct)
                .ConfigureAwait(false);
            return (false, 0, "Desktop VRCX.sqlite3 not found");
        }

        string safePrefix = IsValidAccountPrefix(accountPrefix) ? accountPrefix.Trim() : string.Empty;
        int effectiveConcurrency = Math.Clamp(concurrency, MinConcurrency, MaxConcurrency);
        long batchesSent = 0;
        string stopReason = "Stopped by server";
        LegacyMigrationCursorUpdate? lastKnownSafeCursor = null;

        try
        {
            using SqliteConnection conn = OpenReadOnly(dbPath);
            HashSet<string> tables = ListTableNames(conn);

            foreach (string rawCategory in categories)
            {
                ct.ThrowIfCancellationRequested();
                if (!AllowedCategorySet.Contains(rawCategory)) continue;

                async Task<bool> StreamTableAsync(
                    string logicalTable,
                    string physicalTable,
                    bool orderByCreatedAtDesc,
                    Func<SqliteDataReader, Dictionary<string, int>, Dictionary<string, object?>?> mapper)
                {
                    LegacyTableCursor? existingCursor = null;
                    if (resumeCursors != null && resumeCursors.TryGetValue(logicalTable, out var foundCursor))
                    {
                        existingCursor = foundCursor;
                        if (existingCursor.Completed)
                        {
                            return false;
                        }
                    }

                    if (!tables.Contains(physicalTable)) return false;
                    HashSet<string> cols = ListColumns(conn, physicalTable);
                    if (cols.Count == 0) return false;

                    bool useCreatedAtDesc = orderByCreatedAtDesc && cols.Contains("created_at");
                    using var cmd = conn.CreateCommand();
                    var whereClauses = new List<string>();
                    if (useCreatedAtDesc)
                    {
                        if (existingCursor != null)
                        {
                            if (!string.IsNullOrEmpty(existingCursor.CreatedAt) && existingCursor.RowId > 0)
                            {
                                whereClauses.Add("(COALESCE(created_at, '') < $cTs OR (COALESCE(created_at, '') = $cTs AND rowid < $cRid))");
                                cmd.Parameters.AddWithValue("$cTs", existingCursor.CreatedAt);
                                cmd.Parameters.AddWithValue("$cRid", existingCursor.RowId);
                            }
                            else if (!string.IsNullOrEmpty(existingCursor.CreatedAt))
                            {
                                whereClauses.Add("COALESCE(created_at, '') < $cTs");
                                cmd.Parameters.AddWithValue("$cTs", existingCursor.CreatedAt);
                            }
                            else if (existingCursor.RowId > 0)
                            {
                                whereClauses.Add("rowid < $cRid");
                                cmd.Parameters.AddWithValue("$cRid", existingCursor.RowId);
                            }
                        }
                        string whereSql = whereClauses.Count > 0 ? "WHERE " + string.Join(" AND ", whereClauses) : string.Empty;
                        cmd.CommandText = $"SELECT rowid AS __vrcx_rowid, * FROM \"{physicalTable}\" {whereSql} ORDER BY COALESCE(created_at, '') DESC, rowid DESC";
                    }
                    else
                    {
                        if (existingCursor != null && existingCursor.RowId > 0)
                        {
                            whereClauses.Add("rowid > $cRid");
                            cmd.Parameters.AddWithValue("$cRid", existingCursor.RowId);
                        }
                        string whereSql = whereClauses.Count > 0 ? "WHERE " + string.Join(" AND ", whereClauses) : string.Empty;
                        cmd.CommandText = $"SELECT rowid AS __vrcx_rowid, * FROM \"{physicalTable}\" {whereSql} ORDER BY rowid ASC";
                    }

                    bool isCompactTable = CompactChunkLogicalTables.Contains(logicalTable);
                    int effectiveBatchRowsLimit = isCompactTable ? CompactBatchRowsLimit : BatchRowsLimit;
                    int effectiveMaxBatchPayloadBytes = isCompactTable ? CompactMaxBatchPayloadBytes : MaxBatchPayloadBytes;
                    var buffer = new List<Dictionary<string, object?>>(effectiveBatchRowsLimit);
                    int bufferBytes = 256;
                    string bufferLastCreatedAt = existingCursor?.CreatedAt ?? string.Empty;
                    long bufferLastRowId = existingCursor?.RowId ?? 0;
                    long singleThreadRowsDone = existingCursor?.RowsDone ?? 0;
                    int nextBatchSeq = 0;

                    int stoppedByServer = 0;
                    Exception? workerFailure = null;
                    TableWatermarkTracker? watermark = null;
                    CancellationTokenSource? tableCts = null;
                    Channel<MigrationBatchWorkItem>? batchChannel = null;
                    Task[]? workerTasks = null;

                    void EnsureConcurrentWorkersStarted()
                    {
                        if (batchChannel != null) return;
                        watermark = new TableWatermarkTracker(logicalTable, existingCursor, effectiveConcurrency);
                        tableCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                        batchChannel = Channel.CreateBounded<MigrationBatchWorkItem>(
                            new BoundedChannelOptions(effectiveConcurrency * 2)
                            {
                                SingleWriter = true,
                                SingleReader = false,
                                FullMode = BoundedChannelFullMode.Wait
                            });
                        workerTasks = new Task[effectiveConcurrency];
                        for (int w = 0; w < effectiveConcurrency; w++)
                        {
                            workerTasks[w] = Task.Run(async () =>
                            {
                                try
                                {
                                    await foreach (MigrationBatchWorkItem work in batchChannel.Reader.ReadAllAsync(tableCts.Token).ConfigureAwait(false))
                                    {
                                        if (Volatile.Read(ref stoppedByServer) != 0) break;
                                        LegacyMigrationCursorUpdate? piggyback = watermark.TryTakePiggybackUpdate(force: false);
                                        LegacyMigrationBatchResponse res = await PostMigrationBatchWithRetryAsync(
                                            syncClient,
                                            config,
                                            jobId,
                                            rawCategory,
                                            work.Items,
                                            categoryDone: false,
                                            allDone: false,
                                            errorMessage: null,
                                            tableCts.Token,
                                            cursorUpdate: piggyback).ConfigureAwait(false);
                                        Interlocked.Increment(ref batchesSent);
                                        if (res.ShouldStop)
                                        {
                                            if (!string.IsNullOrWhiteSpace(res.Reason))
                                            {
                                                stopReason = res.Reason!;
                                            }
                                            Interlocked.Exchange(ref stoppedByServer, 1);
                                            try { tableCts.Cancel(); } catch { /* ignore */ }
                                            break;
                                        }
                                        watermark.RecordAck(work.Seq, work.LastCreatedAt, work.LastRowId, work.RowCount);
                                    }
                                }
                                catch (OperationCanceledException) when (Volatile.Read(ref stoppedByServer) != 0 || ct.IsCancellationRequested)
                                {
                                    // Normal halt on server stop signal or external cancellation
                                }
                                catch (Exception ex)
                                {
                                    Interlocked.CompareExchange(ref workerFailure, ex, null);
                                    try { tableCts.Cancel(); } catch { /* ignore */ }
                                }
                            }, CancellationToken.None);
                        }
                    }

                    async Task DrainWorkersAsync(bool cancelInFlight)
                    {
                        if (batchChannel != null && workerTasks != null)
                        {
                            batchChannel.Writer.TryComplete();
                            if (cancelInFlight && tableCts != null)
                            {
                                try { tableCts.Cancel(); } catch { /* ignore */ }
                            }
                            await Task.WhenAll(workerTasks).ConfigureAwait(false);
                        }
                        if (watermark != null)
                        {
                            LegacyMigrationCursorUpdate? pending = watermark.TryTakePiggybackUpdate(force: true);
                            if (pending != null)
                            {
                                lastKnownSafeCursor = pending;
                            }
                        }
                        tableCts?.Dispose();
                        tableCts = null;
                    }

                    async Task<bool> FlushBatchAsync(bool isFinalTableBatch)
                    {
                        if (buffer.Count == 0) return false;
                        var itemsToSend = new List<Dictionary<string, object?>>(buffer);
                        string lastTs = bufferLastCreatedAt;
                        long lastRid = bufferLastRowId;
                        int count = itemsToSend.Count;
                        buffer.Clear();
                        bufferBytes = 256;

                        // Use concurrent channel only when concurrency > 1 and the table spans multiple batches.
                        if (effectiveConcurrency > 1 && (!isFinalTableBatch || batchChannel != null))
                        {
                            EnsureConcurrentWorkersStarted();
                            var work = new MigrationBatchWorkItem
                            {
                                Seq = nextBatchSeq++,
                                Items = itemsToSend,
                                LastCreatedAt = lastTs,
                                LastRowId = lastRid,
                                RowCount = count
                            };
                            try
                            {
                                await batchChannel!.Writer.WriteAsync(work, tableCts!.Token).ConfigureAwait(false);
                            }
                            catch (OperationCanceledException) when (Volatile.Read(ref stoppedByServer) != 0 || workerFailure != null)
                            {
                                return true;
                            }
                            return Volatile.Read(ref stoppedByServer) != 0 || workerFailure != null;
                        }

                        // Single-threaded mode (or single-batch small table): attach exact cursor directly to this batch.
                        singleThreadRowsDone += count;
                        var cursorUpdate = new LegacyMigrationCursorUpdate
                        {
                            Table = logicalTable,
                            CreatedAt = lastTs,
                            RowId = lastRid,
                            Completed = isFinalTableBatch,
                            RowsDone = singleThreadRowsDone
                        };
                        LegacyMigrationBatchResponse res = await PostMigrationBatchWithRetryAsync(
                            syncClient,
                            config,
                            jobId,
                            rawCategory,
                            itemsToSend,
                            categoryDone: false,
                            allDone: false,
                            errorMessage: null,
                            ct,
                            cursorUpdate: cursorUpdate).ConfigureAwait(false);
                        Interlocked.Increment(ref batchesSent);
                        if (res.ShouldStop)
                        {
                            if (!string.IsNullOrWhiteSpace(res.Reason))
                            {
                                stopReason = res.Reason!;
                            }
                            Interlocked.Exchange(ref stoppedByServer, 1);
                            return true;
                        }
                        if (isFinalTableBatch)
                        {
                            lastKnownSafeCursor = null;
                        }
                        return false;
                    }

                    bool anyValidRowSent = false;
                    try
                    {
                        using SqliteDataReader reader = cmd.ExecuteReader();
                        Dictionary<string, int> ord = BuildOrdinalMap(reader);
                        while (reader.Read())
                        {
                            ct.ThrowIfCancellationRequested();
                            Dictionary<string, object?>? mapped = mapper(reader, ord);
                            if (mapped == null) continue;

                            long rowId = GetColLong(reader, ord, "__vrcx_rowid");
                            string rowCreatedAt = useCreatedAtDesc ? GetColStr(reader, ord, "created_at") : string.Empty;

                            int itemBytes = Encoding.UTF8.GetByteCount(JsonConvert.SerializeObject(mapped)) + 2;
                            if (itemBytes > effectiveMaxBatchPayloadBytes)
                            {
                                ClampOversizedStringFields(mapped, MaxSingleFieldChars);
                                itemBytes = Encoding.UTF8.GetByteCount(JsonConvert.SerializeObject(mapped)) + 2;
                                if (itemBytes > effectiveMaxBatchPayloadBytes)
                                {
                                    ClampOversizedStringFields(mapped, 4096);
                                    itemBytes = Encoding.UTF8.GetByteCount(JsonConvert.SerializeObject(mapped)) + 2;
                                }
                            }

                            if (buffer.Count >= effectiveBatchRowsLimit || (buffer.Count > 0 && bufferBytes + itemBytes > effectiveMaxBatchPayloadBytes))
                            {
                                anyValidRowSent = true;
                                if (await FlushBatchAsync(isFinalTableBatch: false).ConfigureAwait(false))
                                {
                                    await DrainWorkersAsync(cancelInFlight: true).ConfigureAwait(false);
                                    if (workerFailure != null && Volatile.Read(ref stoppedByServer) == 0)
                                    {
                                        throw workerFailure;
                                    }
                                    return true;
                                }
                            }

                            buffer.Add(mapped);
                            bufferBytes += itemBytes;
                            bufferLastRowId = rowId;
                            bufferLastCreatedAt = rowCreatedAt;
                        }

                        if (buffer.Count > 0)
                        {
                            anyValidRowSent = true;
                            if (await FlushBatchAsync(isFinalTableBatch: true).ConfigureAwait(false))
                            {
                                await DrainWorkersAsync(cancelInFlight: true).ConfigureAwait(false);
                                if (workerFailure != null && Volatile.Read(ref stoppedByServer) == 0)
                                {
                                    throw workerFailure;
                                }
                                return true;
                            }
                        }

                        if (batchChannel != null)
                        {
                            await DrainWorkersAsync(cancelInFlight: false).ConfigureAwait(false);
                            if (workerFailure != null && Volatile.Read(ref stoppedByServer) == 0)
                            {
                                throw workerFailure;
                            }
                            ct.ThrowIfCancellationRequested();
                            if (Volatile.Read(ref stoppedByServer) != 0)
                            {
                                return true;
                            }

                            // All concurrent workers for this table drained cleanly; seal table cursor as completed.
                            LegacyMigrationBatchResponse sealRes = await PostMigrationBatchWithRetryAsync(
                                syncClient,
                                config,
                                jobId,
                                rawCategory,
                                Array.Empty<Dictionary<string, object?>>(),
                                categoryDone: false,
                                allDone: false,
                                errorMessage: null,
                                ct,
                                cursorUpdate: watermark!.BuildCompletedUpdate()).ConfigureAwait(false);
                            if (sealRes.ShouldStop)
                            {
                                if (!string.IsNullOrWhiteSpace(sealRes.Reason))
                                {
                                    stopReason = sealRes.Reason!;
                                }
                                return true;
                            }
                            // Clear cross-table safe cursor once this table is sealed completed so a failure
                            // in a subsequent table can never replay an older Completed=false watermark.
                            lastKnownSafeCursor = null;
                        }
                        else if (!anyValidRowSent && existingCursor != null && !existingCursor.Completed)
                        {
                            // Resumed right at the end of a previously unfinished table; mark it completed.
                            LegacyMigrationBatchResponse sealRes = await PostMigrationBatchWithRetryAsync(
                                syncClient,
                                config,
                                jobId,
                                rawCategory,
                                Array.Empty<Dictionary<string, object?>>(),
                                categoryDone: false,
                                allDone: false,
                                errorMessage: null,
                                ct,
                                cursorUpdate: new LegacyMigrationCursorUpdate
                                {
                                    Table = logicalTable,
                                    CreatedAt = existingCursor.CreatedAt,
                                    RowId = existingCursor.RowId,
                                    Completed = true,
                                    RowsDone = existingCursor.RowsDone
                                }).ConfigureAwait(false);
                            if (sealRes.ShouldStop)
                            {
                                if (!string.IsNullOrWhiteSpace(sealRes.Reason))
                                {
                                    stopReason = sealRes.Reason!;
                                }
                                return true;
                            }
                            lastKnownSafeCursor = null;
                        }

                        return false;
                    }
                    catch
                    {
                        await DrainWorkersAsync(cancelInFlight: true).ConfigureAwait(false);
                        throw;
                    }
                }

                if (rawCategory == "memos_notes")
                {
                    if (await StreamTableAsync("memos", "memos", false, (r, o) => new()
                    {
                        ["kind"] = "memo",
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["editedAt"] = GetColStr(r, o, "edited_at"),
                        ["memo"] = GetColStr(r, o, "memo")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("world_memos", "world_memos", false, (r, o) => new()
                    {
                        ["kind"] = "world_memo",
                        ["worldId"] = GetColStr(r, o, "world_id"),
                        ["editedAt"] = GetColStr(r, o, "edited_at"),
                        ["memo"] = GetColStr(r, o, "memo")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("avatar_memos", "avatar_memos", false, (r, o) => new()
                    {
                        ["kind"] = "avatar_memo",
                        ["avatarId"] = GetColStr(r, o, "avatar_id"),
                        ["editedAt"] = GetColStr(r, o, "edited_at"),
                        ["memo"] = GetColStr(r, o, "memo")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (!string.IsNullOrEmpty(safePrefix))
                    {
                        if (await StreamTableAsync("notes", $"{safePrefix}_notes", false, (r, o) => new()
                        {
                            ["kind"] = "note",
                            ["userId"] = GetColStr(r, o, "user_id"),
                            ["displayName"] = GetColStr(r, o, "display_name"),
                            ["note"] = GetColStr(r, o, "note"),
                            ["createdAt"] = GetColStr(r, o, "created_at")
                        }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                    }
                }
                else if (rawCategory == "favorites")
                {
                    if (await StreamTableAsync("favorite_friend", "favorite_friend", false, (r, o) => new()
                    {
                        ["kind"] = "favorite_friend",
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("favorite_world", "favorite_world", false, (r, o) => new()
                    {
                        ["kind"] = "favorite_world",
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["worldId"] = GetColStr(r, o, "world_id"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("favorite_avatar", "favorite_avatar", false, (r, o) => new()
                    {
                        ["kind"] = "favorite_avatar",
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["avatarId"] = GetColStr(r, o, "avatar_id"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("favorite_print", "favorite_print", false, (r, o) => new()
                    {
                        ["kind"] = "favorite_print",
                        ["printId"] = GetColStr(r, o, "print_id"),
                        ["createdAt"] = GetColStr(r, o, "created_at")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("avatar_tags", "avatar_tags", false, (r, o) => new()
                    {
                        ["kind"] = "avatar_tag",
                        ["avatarId"] = GetColStr(r, o, "avatar_id"),
                        ["tag"] = GetColStr(r, o, "tag"),
                        ["color"] = o.TryGetValue("color", out int ci) && !r.IsDBNull(ci) ? Convert.ToString(r.GetValue(ci)) : null
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                }
                else if (rawCategory == "avatar_history" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync("avatar_history", $"{safePrefix}_avatar_history", true, (r, o) => new()
                    {
                        ["kind"] = "avatar_history",
                        ["avatarId"] = GetColStr(r, o, "avatar_id"),
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["time"] = GetColLong(r, o, "time")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                }
                else if (rawCategory == "friend_log" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync("friend_log_current", $"{safePrefix}_friend_log_current", false, (r, o) => new()
                    {
                        ["kind"] = "friend_log_current",
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["trustLevel"] = GetColStr(r, o, "trust_level"),
                        ["friendNumber"] = GetColLong(r, o, "friend_number")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("friend_log_history", $"{safePrefix}_friend_log_history", true, (r, o) => new()
                    {
                        ["kind"] = "friend_log_history",
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["type"] = GetColStr(r, o, "type"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["previousDisplayName"] = GetColStr(r, o, "previous_display_name"),
                        ["trustLevel"] = GetColStr(r, o, "trust_level"),
                        ["previousTrustLevel"] = GetColStr(r, o, "previous_trust_level"),
                        ["friendNumber"] = GetColLong(r, o, "friend_number")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                }
                else if (rawCategory == "notifications" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync("notifications", $"{safePrefix}_notifications", true, (r, o) => new()
                    {
                        ["kind"] = "notification_v1",
                        ["id"] = GetColStr(r, o, "id"),
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["type"] = GetColStr(r, o, "type"),
                        ["senderUserId"] = GetColStr(r, o, "sender_user_id"),
                        ["senderUsername"] = GetColStr(r, o, "sender_username"),
                        ["receiverUserId"] = GetColStr(r, o, "receiver_user_id"),
                        ["message"] = GetColStr(r, o, "message"),
                        ["worldId"] = GetColStr(r, o, "world_id"),
                        ["worldName"] = GetColStr(r, o, "world_name"),
                        ["imageUrl"] = GetColStr(r, o, "image_url"),
                        ["inviteMessage"] = GetColStr(r, o, "invite_message"),
                        ["requestMessage"] = GetColStr(r, o, "request_message"),
                        ["responseMessage"] = GetColStr(r, o, "response_message"),
                        ["expired"] = GetColLong(r, o, "expired") != 0
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("notifications_v2", $"{safePrefix}_notifications_v2", true, (r, o) => new()
                    {
                        ["kind"] = "notification_v2",
                        ["id"] = GetColStr(r, o, "id"),
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["updatedAt"] = GetColStr(r, o, "updated_at"),
                        ["expiresAt"] = GetColStr(r, o, "expires_at"),
                        ["type"] = GetColStr(r, o, "type"),
                        ["link"] = GetColStr(r, o, "link"),
                        ["linkText"] = GetColStr(r, o, "link_text"),
                        ["message"] = GetColStr(r, o, "message"),
                        ["title"] = GetColStr(r, o, "title"),
                        ["imageUrl"] = GetColStr(r, o, "image_url"),
                        ["seen"] = GetColLong(r, o, "seen") != 0,
                        ["senderUserId"] = GetColStr(r, o, "sender_user_id"),
                        ["senderUsername"] = GetColStr(r, o, "sender_username"),
                        ["data"] = GetColStr(r, o, "data"),
                        ["responses"] = GetColStr(r, o, "responses"),
                        ["details"] = GetColStr(r, o, "details")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                }
                else if (rawCategory == "moderation_profiles" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync("moderation", $"{safePrefix}_moderation", false, (r, o) => new()
                    {
                        ["kind"] = "moderation",
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["updatedAt"] = GetColStr(r, o, "updated_at"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["block"] = GetColLong(r, o, "block") != 0,
                        ["mute"] = GetColLong(r, o, "mute") != 0
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("user_profile", $"{safePrefix}_user_profile", false, (r, o) => new()
                    {
                        ["kind"] = "user_profile",
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["bio"] = GetColStr(r, o, "bio"),
                        ["bioLinks"] = GetColStr(r, o, "bio_links"),
                        ["updatedAt"] = GetColStr(r, o, "updated_at")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                }
                else if (rawCategory == "gamelog")
                {
                    // Stream newest historical rows first so recent history always migrates first even on multi-year DBs.
                    if (await StreamTableAsync("gamelog_location", "gamelog_location", true, (r, o) => new()
                    {
                        ["type"] = "Location",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["worldId"] = GetColStr(r, o, "world_id"),
                        ["worldName"] = GetColStr(r, o, "world_name"),
                        ["time"] = GetColLong(r, o, "time"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("gamelog_join_leave", "gamelog_join_leave", true, (r, o) => new()
                    {
                        ["type"] = GetColStr(r, o, "type"),
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["time"] = GetColLong(r, o, "time")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("gamelog_portal_spawn", "gamelog_portal_spawn", true, (r, o) => new()
                    {
                        ["type"] = "PortalSpawn",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["instanceId"] = GetColStr(r, o, "instance_id"),
                        ["worldName"] = GetColStr(r, o, "world_name")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("gamelog_video_play", "gamelog_video_play", true, (r, o) => new()
                    {
                        ["type"] = "VideoPlay",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["videoUrl"] = GetColStr(r, o, "video_url"),
                        ["videoName"] = GetColStr(r, o, "video_name"),
                        ["videoId"] = GetColStr(r, o, "video_id"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["userId"] = GetColStr(r, o, "user_id")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("gamelog_event", "gamelog_event", true, (r, o) => new()
                    {
                        ["type"] = "Event",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["data"] = GetColStr(r, o, "data")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("gamelog_external", "gamelog_external", true, (r, o) => new()
                    {
                        ["type"] = "External",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["message"] = GetColStr(r, o, "message"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["location"] = GetColStr(r, o, "location")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                }
                else if (rawCategory == "feed" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync("feed_gps", $"{safePrefix}_feed_gps", true, (r, o) => new()
                    {
                        ["type"] = "GPS",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["worldName"] = GetColStr(r, o, "world_name"),
                        ["previousLocation"] = GetColStr(r, o, "previous_location"),
                        ["time"] = GetColLong(r, o, "time"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("feed_online_offline", $"{safePrefix}_feed_online_offline", true, (r, o) => new()
                    {
                        ["type"] = GetColStr(r, o, "type"),
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["worldName"] = GetColStr(r, o, "world_name"),
                        ["time"] = GetColLong(r, o, "time"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("feed_status", $"{safePrefix}_feed_status", true, (r, o) => new()
                    {
                        ["type"] = "Status",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["status"] = GetColStr(r, o, "status"),
                        ["statusDescription"] = GetColStr(r, o, "status_description"),
                        ["previousStatus"] = GetColStr(r, o, "previous_status"),
                        ["previousStatusDescription"] = GetColStr(r, o, "previous_status_description")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);

                    if (await StreamTableAsync("feed_bio", $"{safePrefix}_feed_bio", true, (r, o) => new()
                    {
                        ["type"] = "Bio",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["bio"] = GetColStr(r, o, "bio"),
                        ["previousBio"] = GetColStr(r, o, "previous_bio"),
                        ["bioLinks"] = GetColStr(r, o, "bio_links"),
                        ["previousBioLinks"] = GetColStr(r, o, "previous_bio_links")
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                }
                else if (rawCategory == "settings")
                {
                    if (await StreamTableAsync("configs", "configs", false, (r, o) =>
                    {
                        string key = GetColStr(r, o, "key");
                        if (!IsSafeLegacyConfigKey(key)) return null;
                        return new Dictionary<string, object?>
                        {
                            ["kind"] = "config",
                            ["key"] = key,
                            ["value"] = GetColStr(r, o, "value")
                        };
                    }).ConfigureAwait(false)) return (false, Volatile.Read(ref batchesSent), stopReason);
                }

                // Mark category done after all tables in this category have finished and sealed their cursors.
                LegacyMigrationBatchResponse catDoneRes = await PostMigrationBatchWithRetryAsync(
                    syncClient,
                    config,
                    jobId,
                    rawCategory,
                    Array.Empty<Dictionary<string, object?>>(),
                    categoryDone: true,
                    allDone: false,
                    errorMessage: null,
                    ct).ConfigureAwait(false);
                if (catDoneRes.ShouldStop)
                {
                    if (!string.IsNullOrWhiteSpace(catDoneRes.Reason))
                    {
                        stopReason = catDoneRes.Reason!;
                    }
                    return (false, Volatile.Read(ref batchesSent), stopReason);
                }
            }

            // Signal completion across all selected categories
            await PostMigrationBatchWithRetryAsync(
                syncClient,
                config,
                jobId,
                string.Empty,
                Array.Empty<Dictionary<string, object?>>(),
                categoryDone: false,
                allDone: true,
                errorMessage: null,
                ct).ConfigureAwait(false);
            return (true, Volatile.Read(ref batchesSent), "Desktop legacy migration completed");
        }
        catch (OperationCanceledException)
        {
            return (false, Volatile.Read(ref batchesSent), "Desktop legacy migration cancelled");
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Desktop legacy migration job {JobId} failed.", jobId);
            try
            {
                await syncClient
                    .PostMigrationBatchAsync(
                        config,
                        jobId,
                        string.Empty,
                        Array.Empty<Dictionary<string, object?>>(),
                        false,
                        true,
                        ex.Message,
                        CancellationToken.None,
                        cursorUpdate: lastKnownSafeCursor)
                    .ConfigureAwait(false);
            }
            catch
            {
                // Ignore secondary failure while reporting error
            }
            return (false, Volatile.Read(ref batchesSent), ex.Message);
        }
    }
}
