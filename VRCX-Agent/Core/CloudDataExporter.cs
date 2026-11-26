using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NLog;

namespace VRCX.Agent.Core;

public sealed class CloudExportTableSummary
{
    [JsonProperty("name")]
    public string Name { get; set; } = string.Empty;

    [JsonProperty("activeCount")]
    public long ActiveCount { get; set; }

    [JsonProperty("legacyCount")]
    public long LegacyCount { get; set; }
}

public sealed class CloudExportSummary
{
    [JsonProperty("exportedAt")]
    public string ExportedAt { get; set; } = string.Empty;

    [JsonProperty("userId")]
    public string UserId { get; set; } = string.Empty;

    [JsonProperty("userPrefix")]
    public string UserPrefix { get; set; } = string.Empty;

    [JsonProperty("legacyDbBound")]
    public bool LegacyDbBound { get; set; }

    [JsonProperty("hasLegacyData")]
    public bool HasLegacyData { get; set; }

    [JsonProperty("totalActiveRows")]
    public long TotalActiveRows { get; set; }

    [JsonProperty("totalLegacyRows")]
    public long TotalLegacyRows { get; set; }

    [JsonProperty("tables")]
    public List<CloudExportTableSummary> Tables { get; set; } = new();
}

public sealed class CloudExportPage
{
    [JsonProperty("table")]
    public string Table { get; set; } = string.Empty;

    [JsonProperty("source")]
    public string Source { get; set; } = string.Empty;

    [JsonProperty("rows")]
    public List<JObject> Rows { get; set; } = new();

    [JsonProperty("nextAfterRowId")]
    public long NextAfterRowId { get; set; }

    [JsonProperty("hasMore")]
    public bool HasMore { get; set; }
}

public sealed class CloudExportProgress
{
    public string Phase { get; set; } = "fetching";
    public string CurrentTable { get; set; } = string.Empty;
    public long ProcessedRows { get; set; }
    public long TotalRows { get; set; }
    public int Percent { get; set; }
}

public sealed class CloudExportResult
{
    public string OutputSqlitePath { get; set; } = string.Empty;
    public long FileBytes { get; set; }
    public long TotalRows { get; set; }
    public string UserPrefix { get; set; } = string.Empty;
    public Dictionary<string, long> TableCounts { get; set; } = new(StringComparer.Ordinal);
}

/// <summary>
/// One-click cloud-to-desktop exporter that downloads all sanitized cloud data (active shards + optional DB_LEGACY)
/// and directly produces a 100% upstream desktop VRCX compatible `VRCX.sqlite3` database file.
/// Never auto-overwrites the user's local `%AppData%\VRCX\VRCX.sqlite3`.
/// </summary>
public static class CloudDataExporter
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    public static string NormalizeExportUserPrefix(string? raw, string? localDesktopDbPathOverride = null)
    {
        if (!string.IsNullOrWhiteSpace(raw))
        {
            string trimmed = raw.Trim();
            if (trimmed.Contains('-', StringComparison.Ordinal))
            {
                string cleaned = trimmed.Replace("-", "", StringComparison.Ordinal).Replace("_", "", StringComparison.Ordinal);
                if (cleaned.Length > 0 && char.IsDigit(cleaned[0]))
                {
                    cleaned = "_" + cleaned;
                }
                if (DesktopLegacyMigrator.IsValidAccountPrefix(cleaned))
                {
                    return cleaned;
                }
            }
            if (DesktopLegacyMigrator.IsValidAccountPrefix(trimmed))
            {
                return trimmed;
            }
        }

        // Fallback: auto-detect existing desktop VRCX primary account prefix in read-only mode so legacy users need zero manual input.
        try
        {
            string dbPath = !string.IsNullOrWhiteSpace(localDesktopDbPathOverride)
                ? localDesktopDbPathOverride
                : DesktopLegacyMigrator.ResolveDesktopVrcxDatabasePath();
            if (!string.IsNullOrWhiteSpace(dbPath) && File.Exists(dbPath))
            {
                LegacyDesktopInventoryReport scan = DesktopLegacyMigrator.ScanDatabase(dbPath);
                string? detected = scan.Accounts.FirstOrDefault()?.Prefix;
                if (DesktopLegacyMigrator.IsValidAccountPrefix(detected))
                {
                    return detected!.Trim();
                }
            }
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Could not auto-detect local desktop VRCX account prefix during export.");
        }

        return "usrdefault";
    }

    public static async Task<CloudExportResult> ExportToSqliteAsync(
        AgentConfig config,
        HttpSyncClient syncClient,
        string outputSqlitePath,
        bool includeLegacy = true,
        string? userPrefixOverride = null,
        string? localDesktopDbPathOverride = null,
        IProgress<CloudExportProgress>? progress = null,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(outputSqlitePath))
        {
            throw new ArgumentException("Output SQLite file path is required.", nameof(outputSqlitePath));
        }

        progress?.Report(new CloudExportProgress { Phase = "summary", Percent = 2 });
        CloudExportSummary summary = await syncClient.GetCloudExportSummaryAsync(config, includeLegacy, ct).ConfigureAwait(false);
        long totalExpected = summary.Tables.Sum(t => t.ActiveCount + (includeLegacy ? t.LegacyCount : 0));
        string resolvedPrefix = NormalizeExportUserPrefix(
            !string.IsNullOrWhiteSpace(userPrefixOverride) ? userPrefixOverride : summary.UserPrefix,
            localDesktopDbPathOverride);

        var mergedTables = new Dictionary<string, List<JObject>>(StringComparer.Ordinal);
        var tableCounts = new Dictionary<string, long>(StringComparer.Ordinal);
        long fetchedRows = 0;

        foreach (CloudExportTableSummary t in summary.Tables)
        {
            ct.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(t.Name)) continue;

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var rows = new List<JObject>();

            async Task PullSourceAsync(string source, long expectedCount)
            {
                if (expectedCount <= 0) return;
                long afterRowId = 0;
                while (true)
                {
                    ct.ThrowIfCancellationRequested();
                    CloudExportPage page = await syncClient
                        .GetCloudExportPageAsync(config, t.Name, source, afterRowId, 400, ct)
                        .ConfigureAwait(false);
                    foreach (JObject row in page.Rows)
                    {
                        string key = BuildNaturalRowKey(t.Name, row);
                        if (seen.Add(key))
                        {
                            rows.Add(row);
                        }
                    }
                    fetchedRows += page.Rows.Count;
                    int pct = totalExpected > 0
                        ? (int)Math.Min(82, Math.Max(5, (fetchedRows * 82L) / Math.Max(totalExpected, fetchedRows)))
                        : 40;
                    progress?.Report(new CloudExportProgress
                    {
                        Phase = "fetching",
                        CurrentTable = t.Name,
                        ProcessedRows = fetchedRows,
                        TotalRows = Math.Max(totalExpected, fetchedRows),
                        Percent = pct
                    });
                    if (!page.HasMore || page.Rows.Count == 0 || page.NextAfterRowId <= afterRowId)
                    {
                        break;
                    }
                    afterRowId = page.NextAfterRowId;
                }
            }

            await PullSourceAsync("active", t.ActiveCount).ConfigureAwait(false);
            if (includeLegacy)
            {
                await PullSourceAsync("legacy", t.LegacyCount).ConfigureAwait(false);
            }

            mergedTables[t.Name] = rows;
            tableCounts[t.Name] = rows.Count;
        }

        long totalExportedRows = tableCounts.Values.Sum();

        string workDir = Path.Combine(Path.GetTempPath(), "vrcx_cloud_export_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string tempTargetPath = outputSqlitePath + ".part";
        string? targetDir = Path.GetDirectoryName(outputSqlitePath);
        if (!string.IsNullOrWhiteSpace(targetDir))
        {
            Directory.CreateDirectory(targetDir);
        }

        try
        {
            ct.ThrowIfCancellationRequested();
            progress?.Report(new CloudExportProgress
            {
                Phase = "building_sqlite",
                CurrentTable = Path.GetFileName(outputSqlitePath),
                ProcessedRows = totalExportedRows,
                TotalRows = totalExportedRows,
                Percent = 88
            });

            string sqlitePath = Path.Combine(workDir, "VRCX.sqlite3");
            BuildUpstreamDesktopSqlite(sqlitePath, resolvedPrefix, mergedTables, ct);

            ct.ThrowIfCancellationRequested();
            progress?.Report(new CloudExportProgress
            {
                Phase = "saving",
                CurrentTable = Path.GetFileName(outputSqlitePath),
                ProcessedRows = totalExportedRows,
                TotalRows = totalExportedRows,
                Percent = 96
            });

            if (File.Exists(tempTargetPath))
            {
                File.Delete(tempTargetPath);
            }

            // Copy into target directory first so final rename is atomic even across volumes/drives.
            File.Copy(sqlitePath, tempTargetPath, overwrite: true);
            File.Move(tempTargetPath, outputSqlitePath, overwrite: true);
            long fileBytes = new FileInfo(outputSqlitePath).Length;

            progress?.Report(new CloudExportProgress
            {
                Phase = "done",
                CurrentTable = string.Empty,
                ProcessedRows = totalExportedRows,
                TotalRows = totalExportedRows,
                Percent = 100
            });

            return new CloudExportResult
            {
                OutputSqlitePath = outputSqlitePath,
                FileBytes = fileBytes,
                TotalRows = totalExportedRows,
                UserPrefix = resolvedPrefix,
                TableCounts = tableCounts
            };
        }
        catch
        {
            try
            {
                if (File.Exists(tempTargetPath)) File.Delete(tempTargetPath);
            }
            catch
            {
                // Ignore cleanup error
            }
            throw;
        }
        finally
        {
            try
            {
                if (Directory.Exists(workDir)) Directory.Delete(workDir, recursive: true);
            }
            catch
            {
                // Ignore temporary workspace cleanup errors
            }
        }
    }

    private static string GetStr(JObject row, string prop)
    {
        JToken? tok = row[prop];
        return tok == null || tok.Type == JTokenType.Null ? string.Empty : tok.ToString();
    }

    private static string? GetNullableStr(JObject row, string prop)
    {
        JToken? tok = row[prop];
        return tok == null || tok.Type == JTokenType.Null ? null : tok.ToString();
    }

    private static long GetLong(JObject row, string prop)
    {
        JToken? tok = row[prop];
        if (tok == null || tok.Type == JTokenType.Null) return 0;
        if (tok.Type == JTokenType.Integer) return tok.Value<long>();
        if (tok.Type == JTokenType.Boolean) return tok.Value<bool>() ? 1 : 0;
        return long.TryParse(tok.ToString(), out long parsed) ? parsed : 0;
    }

    private static string BuildNaturalRowKey(string tableName, JObject row)
    {
        return tableName switch
        {
            "configs" => GetStr(row, "key").ToLowerInvariant(),
            "memos" or "notes" or "friend_log_current" or "moderation" or "user_profile" => GetStr(row, "user_id"),
            "world_memos" => GetStr(row, "world_id"),
            "avatar_memos" or "avatar_history" => GetStr(row, "avatar_id"),
            "favorite_friend" => $"{GetStr(row, "user_id")}|{GetStr(row, "group_name")}",
            "favorite_world" => $"{GetStr(row, "world_id")}|{GetStr(row, "group_name")}",
            "favorite_avatar" => $"{GetStr(row, "avatar_id")}|{GetStr(row, "group_name")}",
            "favorite_print" => GetStr(row, "print_id"),
            "avatar_tags" => $"{GetStr(row, "avatar_id")}|{GetStr(row, "tag")}",
            "friend_log_history" => $"{GetStr(row, "created_at")}|{GetStr(row, "type")}|{GetStr(row, "user_id")}|{GetStr(row, "display_name")}",
            "notifications" or "notifications_v2" => GetStr(row, "id"),
            "gamelog_location" => $"{GetStr(row, "created_at")}|{GetStr(row, "location")}",
            "gamelog_join_leave" => $"{GetStr(row, "created_at")}|{GetStr(row, "type")}|{GetStr(row, "display_name")}",
            "gamelog_portal_spawn" => $"{GetStr(row, "created_at")}|{GetStr(row, "display_name")}",
            "gamelog_video_play" => $"{GetStr(row, "created_at")}|{GetStr(row, "video_url")}",
            "gamelog_event" => $"{GetStr(row, "created_at")}|{GetStr(row, "data")}",
            "gamelog_external" => $"{GetStr(row, "created_at")}|{GetStr(row, "message")}",
            "feed_gps" => $"{GetStr(row, "created_at")}|{GetStr(row, "user_id")}|{GetStr(row, "location")}",
            "feed_online_offline" => $"{GetStr(row, "created_at")}|{GetStr(row, "user_id")}|{GetStr(row, "type")}",
            "feed_status" => $"{GetStr(row, "created_at")}|{GetStr(row, "user_id")}|{GetStr(row, "status")}|{GetStr(row, "status_description")}",
            "feed_bio" => $"{GetStr(row, "created_at")}|{GetStr(row, "user_id")}|{GetStr(row, "bio")}",
            _ => row.ToString(Formatting.None)
        };
    }

    /// <summary>
    /// Creates a 100% upstream original desktop VRCX compatible SQLite database matching
    /// `src/services/database/index.js` (`initTables` + `initUserTables`) and `src/services/config.js`.
    /// </summary>
    public static void BuildUpstreamDesktopSqlite(
        string sqlitePath,
        string userPrefix,
        IReadOnlyDictionary<string, List<JObject>> tableData,
        CancellationToken ct = default)
    {
        string p = DesktopLegacyMigrator.IsValidAccountPrefix(userPrefix) ? userPrefix.Trim() : "usrdefault";
        var csb = new SqliteConnectionStringBuilder
        {
            DataSource = sqlitePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false
        };

        using var conn = new SqliteConnection(csb.ToString());
        conn.Open();

        using (var pragma = conn.CreateCommand())
        {
            pragma.CommandText = "PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;";
            pragma.ExecuteNonQuery();
        }

        using (SqliteTransaction tx = conn.BeginTransaction())
        {
            using (var ddl = conn.CreateCommand())
            {
                ddl.Transaction = tx;
                ddl.CommandText = $@"
CREATE TABLE IF NOT EXISTS configs (`key` TEXT PRIMARY KEY, `value` TEXT);
CREATE TABLE IF NOT EXISTS memos (user_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT);
CREATE TABLE IF NOT EXISTS world_memos (world_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT);
CREATE TABLE IF NOT EXISTS avatar_memos (avatar_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT);
CREATE TABLE IF NOT EXISTS favorite_friend (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, group_name TEXT);
CREATE TABLE IF NOT EXISTS favorite_world (id INTEGER PRIMARY KEY, created_at TEXT, world_id TEXT, group_name TEXT);
CREATE TABLE IF NOT EXISTS favorite_avatar (id INTEGER PRIMARY KEY, created_at TEXT, avatar_id TEXT, group_name TEXT);
CREATE TABLE IF NOT EXISTS favorite_print (id INTEGER PRIMARY KEY, print_id TEXT UNIQUE, created_at TEXT);
CREATE TABLE IF NOT EXISTS avatar_tags (avatar_id TEXT NOT NULL, tag TEXT NOT NULL, color TEXT, PRIMARY KEY (avatar_id, tag));
CREATE TABLE IF NOT EXISTS gamelog_location (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT, world_id TEXT, world_name TEXT, time INTEGER, group_name TEXT, UNIQUE(created_at, location));
CREATE INDEX IF NOT EXISTS gamelog_location_created_at_idx ON gamelog_location (created_at);
CREATE INDEX IF NOT EXISTS idx_gamelog_location_world_created ON gamelog_location (world_id, created_at);
CREATE TABLE IF NOT EXISTS gamelog_join_leave (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, display_name TEXT, location TEXT, user_id TEXT, time INTEGER, UNIQUE(created_at, type, display_name));
CREATE INDEX IF NOT EXISTS idx_gamelog_jl_location ON gamelog_join_leave (location);
CREATE INDEX IF NOT EXISTS idx_gamelog_jl_user_created ON gamelog_join_leave (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gamelog_jl_display_created ON gamelog_join_leave (display_name, created_at);
CREATE TABLE IF NOT EXISTS gamelog_portal_spawn (id INTEGER PRIMARY KEY, created_at TEXT, display_name TEXT, location TEXT, user_id TEXT, instance_id TEXT, world_name TEXT, UNIQUE(created_at, display_name));
CREATE TABLE IF NOT EXISTS gamelog_video_play (id INTEGER PRIMARY KEY, created_at TEXT, video_url TEXT, video_name TEXT, video_id TEXT, location TEXT, display_name TEXT, user_id TEXT, UNIQUE(created_at, video_url));
CREATE TABLE IF NOT EXISTS gamelog_resource_load (id INTEGER PRIMARY KEY, created_at TEXT, resource_url TEXT, resource_type TEXT, location TEXT, UNIQUE(created_at, resource_url));
CREATE TABLE IF NOT EXISTS gamelog_event (id INTEGER PRIMARY KEY, created_at TEXT, data TEXT, UNIQUE(created_at, data));
CREATE TABLE IF NOT EXISTS gamelog_external (id INTEGER PRIMARY KEY, created_at TEXT, message TEXT, display_name TEXT, user_id TEXT, location TEXT, UNIQUE(created_at, message));
CREATE TABLE IF NOT EXISTS {p}_notes (user_id TEXT PRIMARY KEY, display_name TEXT, note TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS {p}_avatar_history (avatar_id TEXT PRIMARY KEY, created_at TEXT, time INTEGER);
CREATE TABLE IF NOT EXISTS {p}_friend_log_current (user_id TEXT PRIMARY KEY, display_name TEXT, trust_level TEXT, friend_number INTEGER);
CREATE TABLE IF NOT EXISTS {p}_friend_log_history (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number INTEGER);
CREATE INDEX IF NOT EXISTS {p}_friend_log_history_user_id_idx ON {p}_friend_log_history (user_id);
CREATE TABLE IF NOT EXISTS {p}_notifications (id TEXT PRIMARY KEY, created_at TEXT, type TEXT, sender_user_id TEXT, sender_username TEXT, receiver_user_id TEXT, message TEXT, world_id TEXT, world_name TEXT, image_url TEXT, invite_message TEXT, request_message TEXT, response_message TEXT, expired INTEGER);
CREATE TABLE IF NOT EXISTS {p}_notifications_v2 (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, expires_at TEXT, type TEXT, link TEXT, link_text TEXT, message TEXT, title TEXT, image_url TEXT, seen INTEGER, sender_user_id TEXT, sender_username TEXT, data TEXT, responses TEXT, details TEXT);
CREATE TABLE IF NOT EXISTS {p}_moderation (user_id TEXT PRIMARY KEY, updated_at TEXT, display_name TEXT, block INTEGER, mute INTEGER);
CREATE TABLE IF NOT EXISTS {p}_user_profile (user_id TEXT PRIMARY KEY, bio TEXT, bio_links TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS {p}_feed_gps (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, location TEXT, world_name TEXT, previous_location TEXT, time INTEGER, group_name TEXT);
CREATE TABLE IF NOT EXISTS {p}_feed_online_offline (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, type TEXT, location TEXT, world_name TEXT, time INTEGER, group_name TEXT);
CREATE INDEX IF NOT EXISTS {p}_feed_online_offline_user_created_idx ON {p}_feed_online_offline (user_id, created_at);
CREATE TABLE IF NOT EXISTS {p}_feed_status (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, status TEXT, status_description TEXT, previous_status TEXT, previous_status_description TEXT);
CREATE TABLE IF NOT EXISTS {p}_feed_bio (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, bio TEXT, previous_bio TEXT, bio_links TEXT, previous_bio_links TEXT);
";
                ddl.ExecuteNonQuery();
            }

            void InsertRows(string sourceKey, string sql, Action<SqliteCommand, JObject> binder)
            {
                if (!tableData.TryGetValue(sourceKey, out List<JObject>? rows) || rows.Count == 0) return;
                using var cmd = conn.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = sql;
                foreach (JObject row in rows)
                {
                    ct.ThrowIfCancellationRequested();
                    cmd.Parameters.Clear();
                    binder(cmd, row);
                    cmd.ExecuteNonQuery();
                }
            }

            InsertRows("configs", "INSERT OR IGNORE INTO configs (`key`, `value`) VALUES ($k, $v)", (c, r) =>
            {
                c.Parameters.AddWithValue("$k", GetStr(r, "key"));
                c.Parameters.AddWithValue("$v", GetStr(r, "value"));
            });
            InsertRows("memos", "INSERT OR IGNORE INTO memos (user_id, edited_at, memo) VALUES ($a, $b, $c)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "edited_at"));
                c.Parameters.AddWithValue("$c", GetStr(r, "memo"));
            });
            InsertRows("world_memos", "INSERT OR IGNORE INTO world_memos (world_id, edited_at, memo) VALUES ($a, $b, $c)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "world_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "edited_at"));
                c.Parameters.AddWithValue("$c", GetStr(r, "memo"));
            });
            InsertRows("avatar_memos", "INSERT OR IGNORE INTO avatar_memos (avatar_id, edited_at, memo) VALUES ($a, $b, $c)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "avatar_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "edited_at"));
                c.Parameters.AddWithValue("$c", GetStr(r, "memo"));
            });
            InsertRows("favorite_friend", "INSERT INTO favorite_friend (created_at, user_id, group_name) VALUES ($a, $b, $c)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$c", GetStr(r, "group_name"));
            });
            InsertRows("favorite_world", "INSERT INTO favorite_world (created_at, world_id, group_name) VALUES ($a, $b, $c)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "world_id"));
                c.Parameters.AddWithValue("$c", GetStr(r, "group_name"));
            });
            InsertRows("favorite_avatar", "INSERT INTO favorite_avatar (created_at, avatar_id, group_name) VALUES ($a, $b, $c)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "avatar_id"));
                c.Parameters.AddWithValue("$c", GetStr(r, "group_name"));
            });
            InsertRows("favorite_print", "INSERT OR IGNORE INTO favorite_print (print_id, created_at) VALUES ($a, $b)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "print_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "created_at"));
            });
            InsertRows("avatar_tags", "INSERT OR IGNORE INTO avatar_tags (avatar_id, tag, color) VALUES ($a, $b, $c)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "avatar_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "tag"));
                string? color = GetNullableStr(r, "color");
                c.Parameters.AddWithValue("$c", (object?)color ?? DBNull.Value);
            });
            InsertRows("notes", $"INSERT OR IGNORE INTO {p}_notes (user_id, display_name, note, created_at) VALUES ($a, $b, $c, $d)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$c", GetStr(r, "note"));
                c.Parameters.AddWithValue("$d", GetStr(r, "created_at"));
            });
            InsertRows("avatar_history", $"INSERT OR IGNORE INTO {p}_avatar_history (avatar_id, created_at, time) VALUES ($a, $b, $c)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "avatar_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$c", GetLong(r, "time"));
            });
            InsertRows("friend_log_current", $"INSERT OR IGNORE INTO {p}_friend_log_current (user_id, display_name, trust_level, friend_number) VALUES ($a, $b, $c, $d)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$c", GetStr(r, "trust_level"));
                c.Parameters.AddWithValue("$d", GetLong(r, "friend_number"));
            });
            InsertRows("friend_log_history", $"INSERT INTO {p}_friend_log_history (created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number) VALUES ($a, $b, $c, $d, $e, $f, $g, $h)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "type"));
                c.Parameters.AddWithValue("$c", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$d", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$e", GetStr(r, "previous_display_name"));
                c.Parameters.AddWithValue("$f", GetStr(r, "trust_level"));
                c.Parameters.AddWithValue("$g", GetStr(r, "previous_trust_level"));
                c.Parameters.AddWithValue("$h", GetLong(r, "friend_number"));
            });
            InsertRows("notifications", $"INSERT OR IGNORE INTO {p}_notifications (id, created_at, type, sender_user_id, sender_username, receiver_user_id, message, world_id, world_name, image_url, invite_message, request_message, response_message, expired) VALUES ($a, $b, $c, $d, $e, $f, $g, $h, $i, $j, $k, $l, $m, $n)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$c", GetStr(r, "type"));
                c.Parameters.AddWithValue("$d", GetStr(r, "sender_user_id"));
                c.Parameters.AddWithValue("$e", GetStr(r, "sender_username"));
                c.Parameters.AddWithValue("$f", GetStr(r, "receiver_user_id"));
                c.Parameters.AddWithValue("$g", GetStr(r, "message"));
                c.Parameters.AddWithValue("$h", GetStr(r, "world_id"));
                c.Parameters.AddWithValue("$i", GetStr(r, "world_name"));
                c.Parameters.AddWithValue("$j", GetStr(r, "image_url"));
                c.Parameters.AddWithValue("$k", GetStr(r, "invite_message"));
                c.Parameters.AddWithValue("$l", GetStr(r, "request_message"));
                c.Parameters.AddWithValue("$m", GetStr(r, "response_message"));
                c.Parameters.AddWithValue("$n", GetLong(r, "expired"));
            });
            InsertRows("notifications_v2", $"INSERT OR IGNORE INTO {p}_notifications_v2 (id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details) VALUES ($a, $b, $c, $d, $e, $f, $g, $h, $i, $j, $k, $l, $m, $n, $o, $p)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$c", GetStr(r, "updated_at"));
                c.Parameters.AddWithValue("$d", GetStr(r, "expires_at"));
                c.Parameters.AddWithValue("$e", GetStr(r, "type"));
                c.Parameters.AddWithValue("$f", GetStr(r, "link"));
                c.Parameters.AddWithValue("$g", GetStr(r, "link_text"));
                c.Parameters.AddWithValue("$h", GetStr(r, "message"));
                c.Parameters.AddWithValue("$i", GetStr(r, "title"));
                c.Parameters.AddWithValue("$j", GetStr(r, "image_url"));
                c.Parameters.AddWithValue("$k", GetLong(r, "seen"));
                c.Parameters.AddWithValue("$l", GetStr(r, "sender_user_id"));
                c.Parameters.AddWithValue("$m", GetStr(r, "sender_username"));
                c.Parameters.AddWithValue("$n", GetStr(r, "data"));
                c.Parameters.AddWithValue("$o", GetStr(r, "responses"));
                c.Parameters.AddWithValue("$p", GetStr(r, "details"));
            });
            InsertRows("moderation", $"INSERT OR IGNORE INTO {p}_moderation (user_id, updated_at, display_name, block, mute) VALUES ($a, $b, $c, $d, $e)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "updated_at"));
                c.Parameters.AddWithValue("$c", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$d", GetLong(r, "block"));
                c.Parameters.AddWithValue("$e", GetLong(r, "mute"));
            });
            InsertRows("user_profile", $"INSERT OR IGNORE INTO {p}_user_profile (user_id, bio, bio_links, updated_at) VALUES ($a, $b, $c, $d)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$b", GetStr(r, "bio"));
                c.Parameters.AddWithValue("$c", GetStr(r, "bio_links"));
                c.Parameters.AddWithValue("$d", GetStr(r, "updated_at"));
            });
            InsertRows("gamelog_location", "INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES ($a, $b, $c, $d, $e, $f)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "location"));
                c.Parameters.AddWithValue("$c", GetStr(r, "world_id"));
                c.Parameters.AddWithValue("$d", GetStr(r, "world_name"));
                c.Parameters.AddWithValue("$e", GetLong(r, "time"));
                c.Parameters.AddWithValue("$f", GetStr(r, "group_name"));
            });
            InsertRows("gamelog_join_leave", "INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES ($a, $b, $c, $d, $e, $f)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "type"));
                c.Parameters.AddWithValue("$c", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$d", GetStr(r, "location"));
                c.Parameters.AddWithValue("$e", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$f", GetLong(r, "time"));
            });
            InsertRows("gamelog_portal_spawn", "INSERT OR IGNORE INTO gamelog_portal_spawn (created_at, display_name, location, user_id, instance_id, world_name) VALUES ($a, $b, $c, $d, $e, $f)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$c", GetStr(r, "location"));
                c.Parameters.AddWithValue("$d", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$e", GetStr(r, "instance_id"));
                c.Parameters.AddWithValue("$f", GetStr(r, "world_name"));
            });
            InsertRows("gamelog_video_play", "INSERT OR IGNORE INTO gamelog_video_play (created_at, video_url, video_name, video_id, location, display_name, user_id) VALUES ($a, $b, $c, $d, $e, $f, $g)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "video_url"));
                c.Parameters.AddWithValue("$c", GetStr(r, "video_name"));
                c.Parameters.AddWithValue("$d", GetStr(r, "video_id"));
                c.Parameters.AddWithValue("$e", GetStr(r, "location"));
                c.Parameters.AddWithValue("$f", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$g", GetStr(r, "user_id"));
            });
            InsertRows("gamelog_event", "INSERT OR IGNORE INTO gamelog_event (created_at, data) VALUES ($a, $b)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "data"));
            });
            InsertRows("gamelog_external", "INSERT OR IGNORE INTO gamelog_external (created_at, message, display_name, user_id, location) VALUES ($a, $b, $c, $d, $e)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "message"));
                c.Parameters.AddWithValue("$c", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$d", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$e", GetStr(r, "location"));
            });
            InsertRows("feed_gps", $"INSERT INTO {p}_feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES ($a, $b, $c, $d, $e, $f, $g, $h)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$c", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$d", GetStr(r, "location"));
                c.Parameters.AddWithValue("$e", GetStr(r, "world_name"));
                c.Parameters.AddWithValue("$f", GetStr(r, "previous_location"));
                c.Parameters.AddWithValue("$g", GetLong(r, "time"));
                c.Parameters.AddWithValue("$h", GetStr(r, "group_name"));
            });
            InsertRows("feed_online_offline", $"INSERT INTO {p}_feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES ($a, $b, $c, $d, $e, $f, $g, $h)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$c", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$d", GetStr(r, "type"));
                c.Parameters.AddWithValue("$e", GetStr(r, "location"));
                c.Parameters.AddWithValue("$f", GetStr(r, "world_name"));
                c.Parameters.AddWithValue("$g", GetLong(r, "time"));
                c.Parameters.AddWithValue("$h", GetStr(r, "group_name"));
            });
            InsertRows("feed_status", $"INSERT INTO {p}_feed_status (created_at, user_id, display_name, status, status_description, previous_status, previous_status_description) VALUES ($a, $b, $c, $d, $e, $f, $g)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$c", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$d", GetStr(r, "status"));
                c.Parameters.AddWithValue("$e", GetStr(r, "status_description"));
                c.Parameters.AddWithValue("$f", GetStr(r, "previous_status"));
                c.Parameters.AddWithValue("$g", GetStr(r, "previous_status_description"));
            });
            InsertRows("feed_bio", $"INSERT INTO {p}_feed_bio (created_at, user_id, display_name, bio, previous_bio, bio_links, previous_bio_links) VALUES ($a, $b, $c, $d, $e, $f, $g)", (c, r) =>
            {
                c.Parameters.AddWithValue("$a", GetStr(r, "created_at"));
                c.Parameters.AddWithValue("$b", GetStr(r, "user_id"));
                c.Parameters.AddWithValue("$c", GetStr(r, "display_name"));
                c.Parameters.AddWithValue("$d", GetStr(r, "bio"));
                c.Parameters.AddWithValue("$e", GetStr(r, "previous_bio"));
                c.Parameters.AddWithValue("$f", GetStr(r, "bio_links"));
                c.Parameters.AddWithValue("$g", GetStr(r, "previous_bio_links"));
            });

            tx.Commit();
        }

        using (var finalize = conn.CreateCommand())
        {
            finalize.CommandText = "PRAGMA journal_mode = DELETE;";
            finalize.ExecuteNonQuery();
        }
        conn.Close();
        SqliteConnection.ClearPool(conn);
    }
}
