using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
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

/// <summary>
/// Strictly read-only scanner and batched uploader for upstream original desktop VRCX (`%AppData%\VRCX\VRCX.sqlite3`).
/// Never writes to or locks the desktop database, strips all credentials/cookies/proxies before upload,
/// and never accepts arbitrary disk paths from remote commands (R.A.I.L.G.U.A.R.D.).
/// </summary>
public static class DesktopLegacyMigrator
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const int BatchRowsLimit = 80;
    private const int MaxBatchPayloadBytes = 180 * 1024;
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

    private static long EstimateD1Bytes(long rowCount, long rawBytes)
    {
        if (rowCount <= 0) return 0;
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
                        EstimatedDbBytes = EstimateD1Bytes(totalRows, totalRaw),
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

    /// <summary>
    /// Streams selected categories from the read-only desktop VRCX database in bounded batches
    /// into the dedicated cloud DB_LEGACY database, respecting cancellation and server quota stop signals.
    /// </summary>
    public static async Task<(bool Completed, long UploadedBatches, string Message)> RunMigrationAsync(
        AgentConfig config,
        string dbPath,
        string jobId,
        string accountPrefix,
        IReadOnlyList<string> categories,
        HttpSyncClient syncClient,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(dbPath) || !File.Exists(dbPath))
        {
            await syncClient
                .PostMigrationBatchAsync(config, jobId, string.Empty, Array.Empty<Dictionary<string, object?>>(), false, true, "Desktop VRCX.sqlite3 not found on this PC.", ct)
                .ConfigureAwait(false);
            return (false, 0, "Desktop VRCX.sqlite3 not found");
        }

        string safePrefix = IsValidAccountPrefix(accountPrefix) ? accountPrefix.Trim() : string.Empty;
        long batchesSent = 0;

        try
        {
            using SqliteConnection conn = OpenReadOnly(dbPath);
            HashSet<string> tables = ListTableNames(conn);

            foreach (string rawCategory in categories)
            {
                ct.ThrowIfCancellationRequested();
                if (!AllowedCategorySet.Contains(rawCategory)) continue;

                var buffer = new List<Dictionary<string, object?>>(BatchRowsLimit);
                int bufferBytes = 256;
                bool stoppedByServer = false;

                async Task<bool> FlushBufferAsync(bool categoryDone)
                {
                    if (buffer.Count == 0 && !categoryDone) return false;
                    var batchToSend = new List<Dictionary<string, object?>>(buffer);
                    buffer.Clear();
                    bufferBytes = 256;

                    LegacyMigrationBatchResponse res = await syncClient
                        .PostMigrationBatchAsync(config, jobId, rawCategory, batchToSend, categoryDone, false, null, ct)
                        .ConfigureAwait(false);
                    batchesSent++;
                    if (res.ShouldStop)
                    {
                        stoppedByServer = true;
                        return true;
                    }
                    if (!categoryDone)
                    {
                        await Task.Delay(150, ct).ConfigureAwait(false);
                    }
                    return false;
                }

                async Task<bool> EnqueueItemAsync(Dictionary<string, object?> item)
                {
                    int itemBytes = Encoding.UTF8.GetByteCount(JsonConvert.SerializeObject(item)) + 2;
                    if (buffer.Count >= BatchRowsLimit || (buffer.Count > 0 && bufferBytes + itemBytes > MaxBatchPayloadBytes))
                    {
                        if (await FlushBufferAsync(categoryDone: false).ConfigureAwait(false))
                        {
                            return true;
                        }
                    }
                    buffer.Add(item);
                    bufferBytes += itemBytes;
                    return false;
                }

                async Task<bool> StreamTableAsync(
                    string tableName,
                    string orderByClause,
                    Func<SqliteDataReader, Dictionary<string, int>, Dictionary<string, object?>?> mapper)
                {
                    if (!tables.Contains(tableName)) return false;
                    HashSet<string> cols = ListColumns(conn, tableName);
                    if (cols.Count == 0) return false;

                    string safeOrderBy = !string.IsNullOrEmpty(orderByClause) &&
                        orderByClause.Contains("created_at", StringComparison.OrdinalIgnoreCase) &&
                        !cols.Contains("created_at")
                        ? string.Empty
                        : orderByClause;

                    using var cmd = conn.CreateCommand();
                    cmd.CommandText = $"SELECT * FROM \"{tableName}\" {safeOrderBy}";
                    using SqliteDataReader reader = cmd.ExecuteReader();
                    Dictionary<string, int> ord = BuildOrdinalMap(reader);
                    while (reader.Read())
                    {
                        ct.ThrowIfCancellationRequested();
                        Dictionary<string, object?>? mapped = mapper(reader, ord);
                        if (mapped == null) continue;
                        if (await EnqueueItemAsync(mapped).ConfigureAwait(false))
                        {
                            return true;
                        }
                    }
                    return false;
                }

                if (rawCategory == "memos_notes")
                {
                    if (await StreamTableAsync("memos", "", (r, o) => new()
                    {
                        ["kind"] = "memo",
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["editedAt"] = GetColStr(r, o, "edited_at"),
                        ["memo"] = GetColStr(r, o, "memo")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("world_memos", "", (r, o) => new()
                    {
                        ["kind"] = "world_memo",
                        ["worldId"] = GetColStr(r, o, "world_id"),
                        ["editedAt"] = GetColStr(r, o, "edited_at"),
                        ["memo"] = GetColStr(r, o, "memo")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("avatar_memos", "", (r, o) => new()
                    {
                        ["kind"] = "avatar_memo",
                        ["avatarId"] = GetColStr(r, o, "avatar_id"),
                        ["editedAt"] = GetColStr(r, o, "edited_at"),
                        ["memo"] = GetColStr(r, o, "memo")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (!string.IsNullOrEmpty(safePrefix))
                    {
                        if (await StreamTableAsync($"{safePrefix}_notes", "", (r, o) => new()
                        {
                            ["kind"] = "note",
                            ["userId"] = GetColStr(r, o, "user_id"),
                            ["displayName"] = GetColStr(r, o, "display_name"),
                            ["note"] = GetColStr(r, o, "note"),
                            ["createdAt"] = GetColStr(r, o, "created_at")
                        }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                    }
                }
                else if (rawCategory == "favorites")
                {
                    if (await StreamTableAsync("favorite_friend", "", (r, o) => new()
                    {
                        ["kind"] = "favorite_friend",
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("favorite_world", "", (r, o) => new()
                    {
                        ["kind"] = "favorite_world",
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["worldId"] = GetColStr(r, o, "world_id"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("favorite_avatar", "", (r, o) => new()
                    {
                        ["kind"] = "favorite_avatar",
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["avatarId"] = GetColStr(r, o, "avatar_id"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("favorite_print", "", (r, o) => new()
                    {
                        ["kind"] = "favorite_print",
                        ["printId"] = GetColStr(r, o, "print_id"),
                        ["createdAt"] = GetColStr(r, o, "created_at")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("avatar_tags", "", (r, o) => new()
                    {
                        ["kind"] = "avatar_tag",
                        ["avatarId"] = GetColStr(r, o, "avatar_id"),
                        ["tag"] = GetColStr(r, o, "tag"),
                        ["color"] = o.TryGetValue("color", out int ci) && !r.IsDBNull(ci) ? Convert.ToString(r.GetValue(ci)) : null
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                }
                else if (rawCategory == "avatar_history" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync($"{safePrefix}_avatar_history", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["kind"] = "avatar_history",
                        ["avatarId"] = GetColStr(r, o, "avatar_id"),
                        ["createdAt"] = GetColStr(r, o, "created_at"),
                        ["time"] = GetColLong(r, o, "time")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                }
                else if (rawCategory == "friend_log" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync($"{safePrefix}_friend_log_current", "", (r, o) => new()
                    {
                        ["kind"] = "friend_log_current",
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["trustLevel"] = GetColStr(r, o, "trust_level"),
                        ["friendNumber"] = GetColLong(r, o, "friend_number")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync($"{safePrefix}_friend_log_history", "ORDER BY created_at DESC", (r, o) => new()
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
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                }
                else if (rawCategory == "notifications" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync($"{safePrefix}_notifications", "ORDER BY created_at DESC", (r, o) => new()
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
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync($"{safePrefix}_notifications_v2", "ORDER BY created_at DESC", (r, o) => new()
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
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                }
                else if (rawCategory == "moderation_profiles" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync($"{safePrefix}_moderation", "", (r, o) => new()
                    {
                        ["kind"] = "moderation",
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["updatedAt"] = GetColStr(r, o, "updated_at"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["block"] = GetColLong(r, o, "block") != 0,
                        ["mute"] = GetColLong(r, o, "mute") != 0
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync($"{safePrefix}_user_profile", "", (r, o) => new()
                    {
                        ["kind"] = "user_profile",
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["bio"] = GetColStr(r, o, "bio"),
                        ["bioLinks"] = GetColStr(r, o, "bio_links"),
                        ["updatedAt"] = GetColStr(r, o, "updated_at")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                }
                else if (rawCategory == "gamelog")
                {
                    // Stream newest historical rows first so recent history always migrates first even on multi-year DBs.
                    if (await StreamTableAsync("gamelog_location", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = "Location",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["worldId"] = GetColStr(r, o, "world_id"),
                        ["worldName"] = GetColStr(r, o, "world_name"),
                        ["time"] = GetColLong(r, o, "time"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("gamelog_join_leave", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = GetColStr(r, o, "type"),
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["time"] = GetColLong(r, o, "time")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("gamelog_portal_spawn", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = "PortalSpawn",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["instanceId"] = GetColStr(r, o, "instance_id"),
                        ["worldName"] = GetColStr(r, o, "world_name")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("gamelog_video_play", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = "VideoPlay",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["videoUrl"] = GetColStr(r, o, "video_url"),
                        ["videoName"] = GetColStr(r, o, "video_name"),
                        ["videoId"] = GetColStr(r, o, "video_id"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["userId"] = GetColStr(r, o, "user_id")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("gamelog_event", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = "Event",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["data"] = GetColStr(r, o, "data")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync("gamelog_external", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = "External",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["message"] = GetColStr(r, o, "message"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["location"] = GetColStr(r, o, "location")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                }
                else if (rawCategory == "feed" && !string.IsNullOrEmpty(safePrefix))
                {
                    if (await StreamTableAsync($"{safePrefix}_feed_gps", "ORDER BY created_at DESC", (r, o) => new()
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
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync($"{safePrefix}_feed_online_offline", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = GetColStr(r, o, "type"),
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["location"] = GetColStr(r, o, "location"),
                        ["worldName"] = GetColStr(r, o, "world_name"),
                        ["time"] = GetColLong(r, o, "time"),
                        ["groupName"] = GetColStr(r, o, "group_name")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync($"{safePrefix}_feed_status", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = "Status",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["status"] = GetColStr(r, o, "status"),
                        ["statusDescription"] = GetColStr(r, o, "status_description"),
                        ["previousStatus"] = GetColStr(r, o, "previous_status"),
                        ["previousStatusDescription"] = GetColStr(r, o, "previous_status_description")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");

                    if (await StreamTableAsync($"{safePrefix}_feed_bio", "ORDER BY created_at DESC", (r, o) => new()
                    {
                        ["type"] = "Bio",
                        ["created_at"] = GetColStr(r, o, "created_at"),
                        ["userId"] = GetColStr(r, o, "user_id"),
                        ["displayName"] = GetColStr(r, o, "display_name"),
                        ["bio"] = GetColStr(r, o, "bio"),
                        ["previousBio"] = GetColStr(r, o, "previous_bio"),
                        ["bioLinks"] = GetColStr(r, o, "bio_links"),
                        ["previousBioLinks"] = GetColStr(r, o, "previous_bio_links")
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                }
                else if (rawCategory == "settings")
                {
                    if (await StreamTableAsync("configs", "", (r, o) =>
                    {
                        string key = GetColStr(r, o, "key");
                        if (!IsSafeLegacyConfigKey(key)) return null;
                        return new Dictionary<string, object?>
                        {
                            ["kind"] = "config",
                            ["key"] = key,
                            ["value"] = GetColStr(r, o, "value")
                        };
                    }).ConfigureAwait(false)) return (false, batchesSent, "Stopped by server");
                }

                if (await FlushBufferAsync(categoryDone: true).ConfigureAwait(false) || stoppedByServer)
                {
                    return (false, batchesSent, "Stopped by server");
                }
            }

            // Signal completion across all selected categories
            await syncClient
                .PostMigrationBatchAsync(config, jobId, string.Empty, Array.Empty<Dictionary<string, object?>>(), false, true, null, ct)
                .ConfigureAwait(false);
            return (true, batchesSent, "Desktop legacy migration completed");
        }
        catch (OperationCanceledException)
        {
            return (false, batchesSent, "Desktop legacy migration cancelled");
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Desktop legacy migration job {JobId} failed.", jobId);
            try
            {
                await syncClient
                    .PostMigrationBatchAsync(config, jobId, string.Empty, Array.Empty<Dictionary<string, object?>>(), false, true, ex.Message, CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch
            {
                // Ignore secondary failure while reporting error
            }
            return (false, batchesSent, ex.Message);
        }
    }
}
