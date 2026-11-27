using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using VRCX.Agent.Core;
using Xunit;

namespace VRCX.Agent.Tests;

public sealed class AgentCoreTests
{
    [Fact]
    public void CommandValidator_EnforcesAllowlistAndBlocksInjectionAndSsrf()
    {
        Assert.True(CommandValidator.ValidateRemoteCommand("sync_now", null).Ok);
        Assert.True(CommandValidator.ValidateRemoteCommand("quit_vrc", null).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("run_powershell", null).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("exec_shell", null).Ok);

        // Valid vrchat://launch URL
        string validUrl = "vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345~region(jp)";
        Assert.True(CommandValidator.ValidateRemoteCommand("launch_vrc", new Dictionary<string, object?> { ["launchUrl"] = validUrl }).Ok);

        // Shell injection / protocol abuse rejected
        Assert.False(CommandValidator.ValidateRemoteCommand("launch_vrc", new Dictionary<string, object?> { ["launchUrl"] = validUrl + " & calc.exe" }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("launch_vrc", new Dictionary<string, object?> { ["launchUrl"] = "cmd.exe /c whoami" }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("launch_vrc", new Dictionary<string, object?> { ["launchUrl"] = "http://evil.example/payload" }).Ok);

        // SSRF allowlist
        Assert.True(CommandValidator.IsAllowedVrcUrl("https://api.vrchat.cloud/api/1/auth/user"));
        Assert.True(CommandValidator.IsAllowedVrcUrl("https://files.vrchat.cloud/file_1/1/file"));
        Assert.False(CommandValidator.IsAllowedVrcUrl("http://api.vrchat.cloud/api/1/auth/user")); // non-HTTPS
        Assert.False(CommandValidator.IsAllowedVrcUrl("https://169.254.169.254/latest/meta-data/"));
        Assert.False(CommandValidator.IsAllowedVrcUrl("https://evil-vrchat.com.attacker.net/api"));
    }

    [Fact]
    public void VrcLogParser_ParsesCjkWorldsPlayersVideosFiltersNoiseAndFoldsFloods()
    {
        var parser = new VrcLogParser();

        // Noise line should be ignored
        Assert.Null(parser.ParseLine("2026.11.24 12:00:00 Log        -  [AssetBundleDownloadManager] Downloading asset avtr_123"));

        // Joining + Entering Room emits Location with CJK world name
        Assert.Null(parser.ParseLine("2026.11.24 12:00:01 Log        -  [Behaviour] Joining wrld_12345678-1234-1234-1234-1234567890ab:99999~region(jp)"));
        GameLogEventItem? locEv = parser.ParseLine("2026.11.24 12:00:02 Log        -  [Behaviour] Entering Room: 日本語ワールド 中文吧");
        Assert.NotNull(locEv);
        Assert.Equal("Location", locEv!.Type);
        Assert.Equal("wrld_12345678-1234-1234-1234-1234567890ab", locEv.WorldId);
        Assert.Equal("日本語ワールド 中文吧", locEv.WorldName);

        // Duplicate within flood window folded
        Assert.Null(parser.ParseLine("2026.11.24 12:00:03 Log        -  [Behaviour] Entering Room: 日本語ワールド 中文吧"));

        // Player joined & left
        GameLogEventItem? joinEv = parser.ParseLine("2026.11.24 12:00:04 Log        -  [Behaviour] OnPlayerJoined 桜ちゃん (usr_11111111-1111-1111-1111-111111111111)");
        Assert.NotNull(joinEv);
        Assert.Equal("OnPlayerJoined", joinEv!.Type);
        Assert.Equal("桜ちゃん", joinEv.DisplayName);
        Assert.Equal("usr_11111111-1111-1111-1111-111111111111", joinEv.UserId);
        Assert.Equal(1, parser.CurrentPlayerCount);

        GameLogEventItem? leftEv = parser.ParseLine("2026.11.24 12:00:10 Log        -  [Behaviour] OnPlayerLeft 桜ちゃん (usr_11111111-1111-1111-1111-111111111111)");
        Assert.NotNull(leftEv);
        Assert.Equal("OnPlayerLeft", leftEv!.Type);
        Assert.Equal(0, parser.CurrentPlayerCount);

        // Video playback
        GameLogEventItem? vidEv = parser.ParseLine("2026.11.24 12:00:12 Log        -  [Video Playback] Attempting to resolve URL 'https://youtu.be/dQw4w9WgXcQ'");
        Assert.NotNull(vidEv);
        Assert.Equal("VideoPlay", vidEv!.Type);
        Assert.Equal("https://youtu.be/dQw4w9WgXcQ", vidEv.VideoUrl);
    }

    [Fact]
    public async Task PeriodicHttpSync_TailsCursorUploadsWithBearerSecretPullsCommandsAndReportsResult()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-agent-test-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);

        try
        {
            string logFile = Path.Combine(logDir, "output_log_2026-11-24_01-00-00.txt");
            await File.WriteAllTextAsync(
                logFile,
                "2026.11.24 12:00:01 Log        -  [Behaviour] Joining wrld_12345678-1234-1234-1234-1234567890ab:100\n" +
                "2026.11.24 12:00:02 Log        -  [Behaviour] Entering Room: Test Shrine\n",
                Encoding.UTF8);

            var cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx-cloud.example.workers.dev",
                SyncSecret = "vrcx_sync_secret_token_123",
                DeviceName = "公主的台式机",
                SyncIntervalSeconds = 45
            };
            Assert.True(cfg.IsConfigured);
            Assert.Equal(45, cfg.EffectiveSyncIntervalSeconds);

            var collector = new LogTailCollector(stateDir);
            int parsed = collector.PollLogDirectory(logDir);
            Assert.Equal(1, parsed);
            Assert.Equal(1, collector.OfflineQueueCount);

            // Second poll without new lines reads 0 bytes
            Assert.Equal(0, collector.PollLogDirectory(logDir));

            string? capturedSyncPath = null;
            string? capturedAuth = null;
            string? capturedBody = null;
            string? capturedResultPath = null;

            using var handler = new StubHttpHandler(async (req) =>
            {
                string path = req.RequestUri!.AbsolutePath;
                if (path == "/api/agent/sync")
                {
                    capturedSyncPath = path;
                    capturedAuth = req.Headers.Authorization?.ToString();
                    capturedBody = await req.Content!.ReadAsStringAsync();
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(
                            "{\"ok\":true,\"data\":{\"deviceId\":\"win-srv-01\",\"deviceName\":\"公主的台式机\",\"syncedAt\":\"2026-11-24T01:05:00Z\",\"ingest\":{\"inserted\":1,\"skipped\":0},\"pendingCommands\":[{\"cmdId\":\"cmd_abc123\",\"action\":\"quit_vrc\",\"params\":{},\"expiresAt\":\"2026-11-24T01:15:00Z\"}]}}",
                            Encoding.UTF8,
                            "application/json")
                    };
                }
                if (path == "/api/agent/commands/cmd_abc123/result")
                {
                    capturedResultPath = path;
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json")
                    };
                }
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            });
            using var http = new HttpClient(handler);
            var syncClient = new HttpSyncClient(http);

            var batch = collector.PeekBatch(50);
            Assert.Single(batch);

            AgentSyncResponse res = await syncClient.SyncOnceAsync(
                cfg,
                batch,
                collector.SnapshotCursor(),
                new LiveAgentState { VrcRunning = true, CurrentWorldName = "Test Shrine" },
                CancellationToken.None);

            collector.AcknowledgeBatch(batch.Count);

            Assert.Equal("/api/agent/sync", capturedSyncPath);
            Assert.Equal("Bearer vrcx_sync_secret_token_123", capturedAuth);
            Assert.Contains("Test Shrine", capturedBody);
            Assert.Contains("公主的台式机", capturedBody);
            Assert.Equal(0, collector.OfflineQueueCount);
            Assert.Equal(1, res.Ingest.Inserted);
            Assert.Single(res.PendingCommands);
            Assert.Equal("cmd_abc123", res.PendingCommands[0].CmdId);

            bool reported = await syncClient.ReportCommandResultAsync(
                cfg,
                new CommandExecutionResult { CmdId = "cmd_abc123", Status = "succeeded", Message = "Done" },
                CancellationToken.None);
            Assert.True(reported);
            Assert.Equal("/api/agent/commands/cmd_abc123/result", capturedResultPath);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void ScreenshotPipeline_EmbedsUpstreamPngMetadataAndEncodesBoundedWebpThumbnail()
    {
        string tempPng = Path.Combine(Path.GetTempPath(), $"vrcx-shot-{Guid.NewGuid():N}.png");
        try
        {
            // Create a real 2400x1200 PNG to test both upstream PNGFile metadata write and <= 1600px WebP downscale
            using (var img = new Image<Rgba32>(2400, 1200, new Rgba32(40, 120, 200, 255)))
            {
                img.SaveAsPng(tempPng);
            }

            var meta = new ScreenshotMetaPayload
            {
                TakenAt = "2026-11-24T01:00:00Z",
                LocalFilename = Path.GetFileName(tempPng),
                WorldId = "wrld_12345678-1234-1234-1234-1234567890ab",
                WorldName = "Sakura Garden 桜庭",
                InstanceId = "12345~region(jp)",
                Players = new List<Dictionary<string, string>>
                {
                    new() { ["displayName"] = "Alice", ["userId"] = "usr_1" }
                }
            };

            bool written = ScreenshotPipeline.WriteVrcxPngMetadata(tempPng, meta);
            Assert.True(written);

            // Read back using upstream PNGFile + PNGHelper
            using (var readPng = new VRCX.PNGFile(tempPng, writeAccess: false))
            {
                string? desc = VRCX.PNGHelper.ReadTextChunk("Description", readPng);
                Assert.NotNull(desc);
                Assert.Contains("Sakura Garden 桜庭", desc);
                Assert.Contains("wrld_12345678-1234-1234-1234-1234567890ab", desc);
            }

            // Encode WebP thumbnail and confirm resize ceiling <= 1600px
            byte[] webp = ScreenshotPipeline.EncodeWebpThumbnail(tempPng, maxDim: 1600, quality: 80);
            Assert.NotEmpty(webp);
            using Image decoded = Image.Load(webp);
            Assert.Equal(1600, decoded.Width);
            Assert.Equal(800, decoded.Height);
        }
        finally
        {
            if (File.Exists(tempPng)) File.Delete(tempPng);
        }
    }

    [Fact]
    public void ProxyHttpClientFactory_SwitchesOverseasDirectAndMainlandProxyModes()
    {
        // 1. Overseas mode (ProxyEnabled = false) disables proxy completely even if an old address is present
        using (var directHandler = ProxyHttpClientFactory.CreateHandler(proxyEnabled: false, "http://127.0.0.1:7890"))
        {
            Assert.False(directHandler.UseProxy);
            Assert.Null(directHandler.Proxy);
        }

        // 2. Mainland China mode with empty address follows Windows system proxy
        using (var sysHandler = ProxyHttpClientFactory.CreateHandler(proxyEnabled: true, ""))
        {
            Assert.True(sysHandler.UseProxy);
            Assert.NotNull(sysHandler.Proxy);
        }

        // 3. Mainland China mode with shorthand host:port normalizes to http://
        var (okHttp, httpUri, _) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri("127.0.0.1:7890");
        Assert.True(okHttp);
        Assert.Equal("http://127.0.0.1:7890/", httpUri!.ToString());

        // 4. Mainland China mode supports SOCKS5 and optional user:pass credentials
        var (okSocks, socksUri, _) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri("socks5://alice:secret@127.0.0.1:7891");
        Assert.True(okSocks);
        Assert.Equal("socks5", socksUri!.Scheme);

        using (var socksHandler = ProxyHttpClientFactory.CreateHandler(proxyEnabled: true, "socks5://alice:secret@127.0.0.1:7891"))
        {
            Assert.True(socksHandler.UseProxy);
            var webProxy = Assert.IsType<WebProxy>(socksHandler.Proxy);
            Assert.Equal("socks5://127.0.0.1:7891/", webProxy.Address!.ToString());
            var creds = Assert.IsType<NetworkCredential>(webProxy.Credentials);
            Assert.Equal("alice", creds.UserName);
            Assert.Equal("secret", creds.Password);
        }

        // 5. Unsupported proxy schemes are rejected
        Assert.False(ProxyHttpClientFactory.NormalizeAndValidateProxyUri("ftp://127.0.0.1:21").Ok);
        Assert.False(ProxyHttpClientFactory.NormalizeAndValidateProxyUri("file:///etc/passwd").Ok);
    }

    [Fact]
    public void SyncScheduleGate_StrictlyFollowsWebIntervalAndBlocksEarlySync()
    {
        var gate = new SyncScheduleGate();
        var t0 = new DateTimeOffset(2026, 11, 24, 3, 0, 0, TimeSpan.Zero);

        // Initial handshake is due immediately upon startup
        Assert.True(gate.IsDue(t0));
        Assert.False(gate.HasSyncedWithWeb);

        // Web instructs a 120s (2 min) sync interval
        int applied = gate.ApplyServerSchedule(new AgentSyncResponse { SyncIntervalSeconds = 120 }, t0);
        Assert.Equal(120, applied);
        Assert.True(gate.HasSyncedWithWeb);
        Assert.Equal(t0.AddSeconds(120), gate.NextSyncAtUtc);

        // Strictly blocked during the entire 120s window (no early uploads even if local logs arrive)
        Assert.False(gate.IsDue(t0));
        Assert.False(gate.IsDue(t0.AddSeconds(30)));
        Assert.False(gate.IsDue(t0.AddSeconds(119)));

        // Permitted only once the scheduled Web sync timestamp arrives
        Assert.True(gate.IsDue(t0.AddSeconds(120)));

        // Web updates interval to 60s -> next cycle immediately follows 60s
        var t1 = t0.AddSeconds(120);
        Assert.Equal(60, gate.ApplyServerSchedule(new AgentSyncResponse { SyncIntervalSeconds = 60 }, t1));
        Assert.False(gate.IsDue(t1.AddSeconds(59)));
        Assert.True(gate.IsDue(t1.AddSeconds(60)));

        // Transient failure backoff never accelerates faster than the Web-configured interval
        gate.ApplyFailureBackoff(consecutiveFailures: 1, t1.AddSeconds(60));
        Assert.False(gate.IsDue(t1.AddSeconds(119)));
        Assert.True(gate.IsDue(t1.AddSeconds(120)));
    }

    [Fact]
    public async Task ScreenshotSync_DefaultsOff_AndSupportsOriginalOrCompressedUpload()
    {
        var defaultCfg = new AgentConfig
        {
            CloudUrl = "https://vrcx.example.workers.dev",
            SyncSecret = "secret"
        };
        Assert.False(defaultCfg.AutoUploadScreenshots);
        Assert.False(defaultCfg.CompressScreenshots);

        string tempPng = Path.Combine(Path.GetTempPath(), $"vrcx-test-shot-{Guid.NewGuid():N}.png");
        try
        {
            using (var img = new SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>(64, 64))
            {
                img.SaveAsPng(tempPng);
            }
            byte[] originalBytes = await File.ReadAllBytesAsync(tempPng);

            // Default (AutoUploadScreenshots = false) sends zero HTTP requests
            int requestCount = 0;
            using var http = new HttpClient(new StubHttpHandler(_ =>
            {
                requestCount++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
            }));
            var pipeline = new ScreenshotPipeline(() => defaultCfg, http);
            bool skipped = await pipeline.UploadQueuedTaskAsync(
                new PendingScreenshotTask { LocalPath = tempPng, TakenAtIso = "2026-11-24T04:00:00Z" },
                CancellationToken.None);
            Assert.True(skipped);
            Assert.Equal(0, requestCount);

            // compress = false preserves original PNG bytes & image/png MIME
            var (rawBytes, rawMime) = ScreenshotPipeline.PrepareUploadPayload(tempPng, compress: false);
            Assert.Equal("image/png", rawMime);
            Assert.Equal(originalBytes, rawBytes);

            // compress = true encodes WebP & image/webp MIME
            var (webpBytes, webpMime) = ScreenshotPipeline.PrepareUploadPayload(tempPng, compress: true);
            Assert.Equal("image/webp", webpMime);
            Assert.True(webpBytes.Length > 12);
            Assert.Equal((byte)'R', webpBytes[0]);
            Assert.Equal((byte)'I', webpBytes[1]);
            Assert.Equal((byte)'F', webpBytes[2]);
            Assert.Equal((byte)'F', webpBytes[3]);
        }
        finally
        {
            if (File.Exists(tempPng)) File.Delete(tempPng);
        }
    }

    [Fact]
    public void AgentStrings_SupportsSimplifiedChineseAndEnglishFallback()
    {
        string? previous = AgentStrings.LanguageOverride;
        try
        {
            AgentStrings.LanguageOverride = "zh-CN";
            Assert.True(AgentStrings.IsChinese);
            Assert.Equal("Microsoft YaHei UI", AgentStrings.UiFontFamily);
            Assert.Equal("VRCX 云端伴侣", AgentStrings.AppTitle);
            Assert.Contains("同步与代理设置", AgentStrings.SettingsWindowTitle);
            Assert.Contains("开机自动后台运行", AgentStrings.AutoStartCheckbox);
            Assert.DoesNotContain("&", AgentStrings.NetworkGroupTitle);
            Assert.DoesNotContain("&", AgentStrings.SettingsDefaultHint);
            Assert.Equal("海外直连", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = false }));
            Assert.Equal("中国大陆 · 系统代理", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = true, ProxyAddress = "" }));
            Assert.Equal("中国大陆 · 自定义代理", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = true, ProxyAddress = "127.0.0.1:7890" }));

            AgentStrings.LanguageOverride = "en-US";
            Assert.False(AgentStrings.IsChinese);
            Assert.Equal("Segoe UI", AgentStrings.UiFontFamily);
            Assert.Equal("VRCX Cloud Agent", AgentStrings.AppTitle);
            // WinForms control labels must escape '&' as '&&' so no mnemonic underscore is rendered
            Assert.Contains("&&", AgentStrings.NetworkGroupTitle);
            Assert.Contains("&&", AgentStrings.SettingsDefaultHint);
            Assert.Equal("Overseas Direct", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = false }));
            Assert.Equal("Mainland · System Proxy", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = true, ProxyAddress = "" }));
            Assert.Equal("Mainland · Custom Proxy", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = true, ProxyAddress = "127.0.0.1:7890" }));
        }
        finally
        {
            AgentStrings.LanguageOverride = previous;
        }
    }

    [Fact]
    public async Task AgentUpdater_ParsesReleasesFallsBackOnRateLimitAndVerifiesSha256()
    {
        // 1. Semantic version comparisons
        Assert.True(AgentUpdater.IsNewerVersion("1.3.0", "v1.4.0"));
        Assert.True(AgentUpdater.IsNewerVersion("1.9.0", "v1.10.0"));
        Assert.False(AgentUpdater.IsNewerVersion("1.4.0", "v1.4.0"));
        Assert.False(AgentUpdater.IsNewerVersion("1.5.0", "v1.4.0"));
        Assert.False(AgentUpdater.IsNewerVersion("1.4.0", "not-a-tag"));

        // 2. Trusted GitHub download host allowlist (SSRF / supply-chain protection)
        Assert.True(AgentUpdater.IsTrustedDownloadUrl("https://github.com/nuomew/VRCX-Worker/releases/download/v1.4.0/VRCX.Agent-v1.4.0-Setup-win-x64.exe"));
        Assert.True(AgentUpdater.IsTrustedDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset/123"));
        Assert.False(AgentUpdater.IsTrustedDownloadUrl("http://github.com/nuomew/VRCX-Worker/releases/download/v1.4.0/a.exe"));
        Assert.False(AgentUpdater.IsTrustedDownloadUrl("https://evil-github.com.attacker.net/payload.exe"));

        // 3. API JSON parsing with GitHub native sha256 digest
        byte[] fakeInstallerBytes = new byte[4096];
        new Random(42).NextBytes(fakeInstallerBytes);
        string expectedSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(fakeInstallerBytes)).ToLowerInvariant();

        string apiJson = $@"{{
            ""tag_name"": ""v1.5.0"",
            ""html_url"": ""https://github.com/nuomew/VRCX-Worker/releases/tag/v1.5.0"",
            ""body"": ""Release notes"",
            ""assets"": [
                {{
                    ""name"": ""VRCX.Agent-v1.5.0-Setup-win-x64.exe"",
                    ""size"": {fakeInstallerBytes.Length},
                    ""digest"": ""sha256:{expectedSha}"",
                    ""browser_download_url"": ""https://github.com/nuomew/VRCX-Worker/releases/download/v1.5.0/VRCX.Agent-v1.5.0-Setup-win-x64.exe""
                }}
            ]
        }}";
        AgentReleaseInfo? parsed = AgentUpdater.ParseReleaseApiJson(apiJson, "1.4.0");
        Assert.NotNull(parsed);
        Assert.True(parsed!.IsUpdateAvailable);
        Assert.Equal("v1.5.0", parsed.TagName);
        Assert.Equal(expectedSha, parsed.ExpectedSha256);

        // 4. Rate-limit (HTTP 403) fallback to github.com/releases/latest redirect + HTML checksum extraction
        using var fallbackHttp = new HttpClient(new StubHttpHandler(req =>
        {
            string url = req.RequestUri!.AbsoluteUri;
            if (url == AgentUpdater.LatestApiUrl)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden)
                {
                    Content = new StringContent("{\"message\":\"API rate limit exceeded\"}")
                });
            }
            if (url == AgentUpdater.LatestWebRedirectUrl)
            {
                var res = new HttpResponseMessage(HttpStatusCode.OK)
                {
                    RequestMessage = new HttpRequestMessage(HttpMethod.Get, "https://github.com/nuomew/VRCX-Worker/releases/tag/v1.5.0"),
                    Content = new StringContent($"<code>VRCX.Agent-v1.5.0-Setup-win-x64.exe</code>: <code>{expectedSha}</code>")
                };
                return Task.FromResult(res);
            }
            if (url.EndsWith("VRCX.Agent-v1.5.0-Setup-win-x64.exe", StringComparison.Ordinal))
            {
                var content = new ByteArrayContent(fakeInstallerBytes);
                content.Headers.ContentLength = fakeInstallerBytes.Length;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }));

        var updater = new AgentUpdater(fallbackHttp);
        AgentReleaseInfo fallbackRelease = await updater.CheckForUpdateAsync("1.4.0", CancellationToken.None);
        Assert.True(fallbackRelease.UsedFallbackRedirect);
        Assert.True(fallbackRelease.IsUpdateAvailable);
        Assert.Equal("v1.5.0", fallbackRelease.TagName);
        Assert.Equal(expectedSha, fallbackRelease.ExpectedSha256);

        // 5. Streaming download + SHA-256 verification succeeds and writes exact file
        string tempDir = Path.Combine(Path.GetTempPath(), "vrcx-update-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            string savedPath = await updater.DownloadAndVerifyInstallerAsync(fallbackRelease, tempDir, null, CancellationToken.None);
            Assert.True(File.Exists(savedPath));
            Assert.Equal(fakeInstallerBytes, await File.ReadAllBytesAsync(savedPath));

            // 6. Tampered checksum is rejected and temporary .part file is removed
            fallbackRelease.ExpectedSha256 = new string('0', 64);
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                updater.DownloadAndVerifyInstallerAsync(fallbackRelease, tempDir, null, CancellationToken.None));
            Assert.False(File.Exists(savedPath + ".part"));

            // 7. Missing expected SHA-256 is strictly rejected (never silently skips integrity verification)
            fallbackRelease.ExpectedSha256 = string.Empty;
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                updater.DownloadAndVerifyInstallerAsync(fallbackRelease, tempDir, null, CancellationToken.None));

            // 8. ParseReleaseApiJson never falls back to arbitrary non-Setup .exe assets
            string arbitraryExeJson = @"{
                ""tag_name"": ""v1.6.0"",
                ""html_url"": ""https://github.com/nuomew/VRCX-Worker/releases/tag/v1.6.0"",
                ""body"": """",
                ""assets"": [
                    {
                        ""name"": ""random-tool.exe"",
                        ""size"": 4096,
                        ""browser_download_url"": ""https://github.com/nuomew/VRCX-Worker/releases/download/v1.6.0/random-tool.exe""
                    }
                ]
            }";
            AgentReleaseInfo? arbitraryParsed = AgentUpdater.ParseReleaseApiJson(arbitraryExeJson, "1.5.0");
            Assert.NotNull(arbitraryParsed);
            Assert.Equal(string.Empty, arbitraryParsed!.SetupFileName);
            Assert.Equal(string.Empty, arbitraryParsed.SetupDownloadUrl);

            // 9. Truncated body (downloadedBytes != Content-Length) is rejected
            using var truncatedHttp = new HttpClient(new StubHttpHandler(_ =>
            {
                var content = new ByteArrayContent(fakeInstallerBytes);
                content.Headers.ContentLength = fakeInstallerBytes.Length + 512;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
            }));
            var truncatedUpdater = new AgentUpdater(truncatedHttp);
            fallbackRelease.ExpectedSha256 = expectedSha;
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                truncatedUpdater.DownloadAndVerifyInstallerAsync(fallbackRelease, tempDir, null, CancellationToken.None));
            Assert.False(File.Exists(savedPath + ".part"));
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public async Task VmessAead_MatchesXrayCoreGoldenVectors_ParsesLinks_AndTunnelsHttpEndToEnd()
    {
        // 1. Verify exact byte-for-byte parity with Xray-core Go reference vectors (aead/kdf.go & authid.go)
        Assert.True(VmessConfig.TryParseUuidBigEndian("de305d54-75b4-431b-adb2-eb6b9e546014", out byte[] uuidBytes));
        byte[] cmdKey = VmessAeadClient.ComputeCmdKey(uuidBytes);
        Assert.Equal("cec646f87c62b6dba283881bc99c68d7", Convert.ToHexString(cmdKey).ToLowerInvariant());

        byte[] authKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("AES Auth ID Encryption"));
        Assert.Equal("bd22928503ab58c8acb9447e2ffcf573", Convert.ToHexString(authKey).ToLowerInvariant());

        byte[] rand4 = { 0x11, 0x22, 0x33, 0x44 };
        byte[] authId = VmessAeadClient.CreateAuthId(cmdKey, 1700000000L, rand4);
        Assert.Equal("33d6d6abd11fdca3aa72c4ab08f49eb7", Convert.ToHexString(authId).ToLowerInvariant());

        byte[] nonce8 = { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 };
        byte[] lenKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key_Length"), authId, nonce8);
        byte[] lenIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce_Length"), authId, nonce8)[..12];
        byte[] hdrKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key"), authId, nonce8);
        byte[] hdrIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce"), authId, nonce8)[..12];

        Assert.Equal("fcca660effd25d4d0de16cf79773d917", Convert.ToHexString(lenKey).ToLowerInvariant());
        Assert.Equal("824675708e90699854a6d202", Convert.ToHexString(lenIv).ToLowerInvariant());
        Assert.Equal("9875e8ff998b6b63b598ab0e962a4094", Convert.ToHexString(hdrKey).ToLowerInvariant());
        Assert.Equal("7b29291b1db539251f2d4713", Convert.ToHexString(hdrIv).ToLowerInvariant());

        // 2. Parse v2rayN standard JSON vmess:// (WS + TLS + custom SNI/Host/Path) and Shadowrocket compact link
        string wsJson = "{\"v\":\"2\",\"ps\":\"香港节点\",\"add\":\"1.2.3.4\",\"port\":\"443\",\"id\":\"de305d54-75b4-431b-adb2-eb6b9e546014\",\"aid\":\"0\",\"scy\":\"auto\",\"net\":\"ws\",\"type\":\"none\",\"host\":\"cdn.example.com\",\"path\":\"/vrcx\",\"tls\":\"tls\",\"sni\":\"sni.example.com\"}";
        string wsLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(wsJson));
        Assert.True(ProxyHttpClientFactory.NormalizeAndValidateProxyUri(wsLink).Ok);
        Assert.True(VmessConfig.TryParse(wsLink, out VmessConfig? wsCfg, out _));
        Assert.Equal("香港节点", wsCfg!.Remarks);
        Assert.Equal("ws", wsCfg.Network);
        Assert.True(wsCfg.UseTls);
        Assert.Equal("sni.example.com", wsCfg.EffectiveSni);
        Assert.Equal("/vrcx", wsCfg.EffectiveWsPath);
        Assert.Equal(0x03, wsCfg.WireSecurityByte);

        string compactPayload = Convert.ToBase64String(Encoding.UTF8.GetBytes("aes-128-gcm:de305d54-75b4-431b-adb2-eb6b9e546014@10.0.0.1:8443"));
        string compactLink = $"vmess://{compactPayload}?remarks=Tokyo&obfs=websocket&path=/ray&obfsParam=ws.example.com&tls=1";
        Assert.True(VmessConfig.TryParse(compactLink, out VmessConfig? compactCfg, out _));
        Assert.Equal("Tokyo", compactCfg!.Remarks);
        Assert.Equal("ws", compactCfg.Network);
        Assert.Equal("ws.example.com", compactCfg.Host);
        Assert.True(compactCfg.UseTls);

        // Unsupported transport (e.g. grpc) is rejected cleanly with explanation
        string grpcJson = "{\"add\":\"1.2.3.4\",\"port\":443,\"id\":\"de305d54-75b4-431b-adb2-eb6b9e546014\",\"net\":\"grpc\"}";
        Assert.False(ProxyHttpClientFactory.NormalizeAndValidateProxyUri("vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(grpcJson))).Ok);

        // 3. End-to-end real HttpClient -> ProxyHttpClientFactory(vmess://) -> loopback VMess AEAD Server
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int serverPort = ((IPEndPoint)listener.LocalEndpoint).Port;

        string tcpJson = $"{{\"v\":\"2\",\"ps\":\"LocalTest\",\"add\":\"127.0.0.1\",\"port\":{serverPort},\"id\":\"de305d54-75b4-431b-adb2-eb6b9e546014\",\"aid\":0,\"scy\":\"aes-128-gcm\",\"net\":\"tcp\",\"tls\":\"\"}}";
        string tcpVmessLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(tcpJson));

        string? capturedTargetHost = null;
        int capturedTargetPort = 0;
        string? capturedHttpReq = null;

        Task serverTask = Task.Run(async () =>
        {
            using var tcpClient = await listener.AcceptTcpClientAsync();
            using var net = tcpClient.GetStream();

            static async Task<byte[]> ReadExact(Stream s, int n)
            {
                byte[] buf = new byte[n];
                int total = 0;
                while (total < n)
                {
                    int r = await s.ReadAsync(buf.AsMemory(total, n - total));
                    if (r == 0) throw new EndOfStreamException();
                    total += r;
                }
                return buf;
            }

            // Read & decrypt VMess AEAD Request Header
            byte[] reqAuthId = await ReadExact(net, 16);
            byte[] encLen = await ReadExact(net, 18);
            byte[] reqNonce = await ReadExact(net, 8);

            // Decrypt AuthID and validate CRC32
            using (var aes = System.Security.Cryptography.Aes.Create())
            {
                aes.Key = authKey;
                byte[] decAuth = aes.DecryptEcb(reqAuthId, System.Security.Cryptography.PaddingMode.None);
                uint crcActual = VmessAeadClient.ComputeCrc32Ieee(decAuth.AsSpan(0, 12));
                uint crcExpected = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(decAuth.AsSpan(12, 4));
                Assert.Equal(crcExpected, crcActual);
            }

            byte[] lKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key_Length"), reqAuthId, reqNonce);
            byte[] lIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce_Length"), reqAuthId, reqNonce)[..12];
            byte[] plainLenBytes = VmessAeadClient.AesGcmOpen(lKey, lIv, encLen, reqAuthId);
            ushort headerLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(plainLenBytes);

            byte[] encHdr = await ReadExact(net, headerLen + 16);
            byte[] hKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key"), reqAuthId, reqNonce);
            byte[] hIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce"), reqAuthId, reqNonce)[..12];
            byte[] hdr = VmessAeadClient.AesGcmOpen(hKey, hIv, encHdr, reqAuthId);

            // Verify FNV-1a32 checksum and parse fields
            uint fnvActual = VmessAeadClient.ComputeFnv1a32(hdr.AsSpan(0, hdr.Length - 4));
            uint fnvExpected = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(hdr.AsSpan(hdr.Length - 4, 4));
            Assert.Equal(fnvExpected, fnvActual);

            byte[] reqBodyIv = hdr[1..17];
            byte[] reqBodyKey = hdr[17..33];
            byte respAuthV = hdr[33];
            capturedTargetPort = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(hdr.AsSpan(38, 2));
            byte addrType = hdr[40];
            Assert.Equal(0x02, addrType);
            int domainLen = hdr[41];
            capturedTargetHost = Encoding.ASCII.GetString(hdr, 42, domainLen);

            // Read first encrypted data chunk (HTTP request)
            byte[] chunkLenBytes = await ReadExact(net, 2);
            ushort chunkLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(chunkLenBytes);
            byte[] chunkEnc = await ReadExact(net, chunkLen);
            byte[] chunkIv = new byte[12];
            Buffer.BlockCopy(reqBodyIv, 2, chunkIv, 2, 10); // count = 0
            byte[] plainReq = VmessAeadClient.AesGcmOpen(reqBodyKey, chunkIv, chunkEnc, ReadOnlySpan<byte>.Empty);
            capturedHttpReq = Encoding.ASCII.GetString(plainReq);

            // Encode AEAD Response Header + encrypted HTTP 200 response chunk + EOF chunk
            byte[] respBodyKey = System.Security.Cryptography.SHA256.HashData(reqBodyKey)[..16];
            byte[] respBodyIv = System.Security.Cryptography.SHA256.HashData(reqBodyIv)[..16];
            byte[] respHdrPlain = { respAuthV, 0x00, 0x00, 0x00 };
            byte[] respHdrLenPlain = { 0x00, 0x04 };
            byte[] rLenKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Len Key"));
            byte[] rLenIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header Len IV"))[..12];
            byte[] rHdrKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Key"));
            byte[] rHdrIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header IV"))[..12];

            await net.WriteAsync(VmessAeadClient.AesGcmSeal(rLenKey, rLenIv, respHdrLenPlain, ReadOnlySpan<byte>.Empty));
            await net.WriteAsync(VmessAeadClient.AesGcmSeal(rHdrKey, rHdrIv, respHdrPlain, ReadOnlySpan<byte>.Empty));

            byte[] httpBody = Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nVMESS_PONG");
            byte[] respChunkIv0 = new byte[12];
            Buffer.BlockCopy(respBodyIv, 2, respChunkIv0, 2, 10);
            byte[] sealedResp = VmessAeadClient.AesGcmSeal(respBodyKey, respChunkIv0, httpBody, ReadOnlySpan<byte>.Empty);
            byte[] respFrame = new byte[2 + sealedResp.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(respFrame.AsSpan(0, 2), (ushort)sealedResp.Length);
            Buffer.BlockCopy(sealedResp, 0, respFrame, 2, sealedResp.Length);
            await net.WriteAsync(respFrame);

            // Send AEAD EOF chunk (count = 1, empty plaintext -> 16B tag)
            byte[] respChunkIv1 = new byte[12];
            respChunkIv1[1] = 1;
            Buffer.BlockCopy(respBodyIv, 2, respChunkIv1, 2, 10);
            byte[] sealedEof = VmessAeadClient.AesGcmSeal(respBodyKey, respChunkIv1, ReadOnlySpan<byte>.Empty, ReadOnlySpan<byte>.Empty);
            byte[] eofFrame = new byte[2 + sealedEof.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(eofFrame.AsSpan(0, 2), (ushort)sealedEof.Length);
            Buffer.BlockCopy(sealedEof, 0, eofFrame, 2, sealedEof.Length);
            await net.WriteAsync(eofFrame);
            await net.FlushAsync();
        });

        using HttpClient vmessHttp = ProxyHttpClientFactory.CreateHttpClient(new AgentConfig
        {
            ProxyEnabled = true,
            ProxyAddress = tcpVmessLink
        }, TimeSpan.FromSeconds(10));

        string responseText = await vmessHttp.GetStringAsync("http://vrcx-test.internal:8080/ping");
        await serverTask;

        Assert.Equal("VMESS_PONG", responseText);
        Assert.Equal("vrcx-test.internal", capturedTargetHost);
        Assert.Equal(8080, capturedTargetPort);
        Assert.Contains("GET /ping HTTP/1.1", capturedHttpReq);
    }

    [Fact]
    public async Task HttpSyncClient_OmitsDeviceNameWhenBlank_AndUsesWebAuthoritativeDeviceName()
    {
        var defaultCfg = new AgentConfig();
        Assert.Equal(string.Empty, defaultCfg.DeviceName);

        string? capturedBody = null;
        using var handler = new StubHttpHandler(async (req) =>
        {
            capturedBody = await req.Content!.ReadAsStringAsync();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"ok\":true,\"data\":{\"deviceId\":\"win-web-01\",\"deviceName\":\"网页端设置的电脑\",\"syncIntervalSeconds\":90,\"syncedAt\":\"2026-11-24T01:05:00Z\",\"ingest\":{\"inserted\":0,\"skipped\":0},\"pendingCommands\":[]}}",
                    Encoding.UTF8,
                    "application/json")
            };
        });
        using var http = new HttpClient(handler);
        var client = new HttpSyncClient(http);

        var (ok, _, res) = await client.TestConnectionAsync(
            "https://vrcx-cloud.example.workers.dev",
            "vrcx_sync_key_abc",
            "win-local-id",
            string.Empty,
            proxyEnabled: false,
            proxyAddress: string.Empty,
            CancellationToken.None);

        Assert.True(ok);
        Assert.NotNull(res);
        Assert.Equal("网页端设置的电脑", res!.DeviceName);
        Assert.NotNull(capturedBody);
        Assert.DoesNotContain("\"deviceName\"", capturedBody);

        string? prevLang = AgentStrings.LanguageOverride;
        try
        {
            AgentStrings.LanguageOverride = "zh-CN";
            Assert.Contains("网页端设置的电脑", AgentStrings.FormatWebDeviceAndScheduleHint(res.DeviceName, 90));
            Assert.Contains("网页端统一控制", AgentStrings.FormatWebDeviceAndScheduleHint(string.Empty, 60));
            // Verify UI labels contain no parenthetical descriptions
            Assert.DoesNotContain("（", AgentStrings.CloudUrlLabel);
            Assert.DoesNotContain("（", AgentStrings.SyncSecretLabel);
            Assert.DoesNotContain("（", AgentStrings.NetworkGroupTitle);
            Assert.DoesNotContain("（", AgentStrings.OverseasDirectRadio);
            Assert.DoesNotContain("（", AgentStrings.MainlandProxyRadio);
            Assert.DoesNotContain("（", AgentStrings.ProxyAddressLabel);
            Assert.DoesNotContain("（", AgentStrings.SyncScreenshotsCheckbox);
            Assert.DoesNotContain("（", AgentStrings.CompressScreenshotsCheckbox);
            Assert.DoesNotContain("（", AgentStrings.AutoStartCheckbox);
            Assert.DoesNotContain("（", AgentStrings.AutoCheckUpdatesCheckbox);
        }
        finally
        {
            AgentStrings.LanguageOverride = prevLang;
        }
    }

    [Fact]
    public async Task VmessTcpHttpObfuscation_TunnelsHttpEndToEnd_AndInstallerCleanupRemovesOldExes()
    {
        // 1. Parse VMess tcp/http with comma-separated obfuscation hosts + Shadowrocket obfs=http
        string uuid = "de305d54-75b4-431b-adb2-eb6b9e546014";
        Assert.True(VmessConfig.TryParseUuidBigEndian(uuid, out byte[] uuidBytes));
        byte[] cmdKey = VmessAeadClient.ComputeCmdKey(uuidBytes);
        byte[] authKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("AES Auth ID Encryption"));

        string compactHttp = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes($"auto:{uuid}@127.0.0.1:80"))
            + "?obfs=http&obfsParam=a.cdn.test,b.cdn.test&path=/obfs";
        Assert.True(VmessConfig.TryParse(compactHttp, out VmessConfig? compactCfg, out _));
        Assert.Equal("tcp", compactCfg!.Network);
        Assert.Equal("http", compactCfg.HeaderType);
        Assert.Equal("a.cdn.test", compactCfg.EffectiveHttpHeaderHost);
        Assert.Equal("/obfs", compactCfg.EffectiveWsPath);

        // 2. End-to-end loopback VMess tcp/http server verifying HTTP request obfuscation + response header stripping
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int serverPort = ((IPEndPoint)listener.LocalEndpoint).Port;

        string tcpHttpJson = $"{{\"v\":\"2\",\"ps\":\"AirportTcpHttp\",\"add\":\"127.0.0.1\",\"port\":{serverPort},\"id\":\"{uuid}\",\"aid\":0,\"scy\":\"auto\",\"net\":\"tcp\",\"type\":\"http\",\"host\":\"a.obfs.example,b.obfs.example\",\"path\":\"/ray\",\"tls\":\"\"}}";
        string tcpHttpLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(tcpHttpJson));
        Assert.True(ProxyHttpClientFactory.NormalizeAndValidateProxyUri(tcpHttpLink).Ok);

        string? capturedObfsHeader = null;
        Task serverTask = Task.Run(async () =>
        {
            using var tcpClient = await listener.AcceptTcpClientAsync();
            using var net = tcpClient.GetStream();

            // Read until CRLFCRLF (HTTP obfuscation request header)
            using var hdrMs = new MemoryStream();
            byte[] one = new byte[1];
            byte[] tail = new byte[4];
            int matched = 0;
            while (matched < 4)
            {
                int r = await net.ReadAsync(one.AsMemory(0, 1));
                if (r == 0) throw new EndOfStreamException();
                hdrMs.WriteByte(one[0]);
                tail[0] = tail[1]; tail[1] = tail[2]; tail[2] = tail[3]; tail[3] = one[0];
                if (tail[0] == '\r' && tail[1] == '\n' && tail[2] == '\r' && tail[3] == '\n') matched = 4;
            }
            capturedObfsHeader = Encoding.ASCII.GetString(hdrMs.ToArray());

            static async Task<byte[]> ReadExact(Stream s, int n)
            {
                byte[] buf = new byte[n];
                int total = 0;
                while (total < n)
                {
                    int r = await s.ReadAsync(buf.AsMemory(total, n - total));
                    if (r == 0) throw new EndOfStreamException();
                    total += r;
                }
                return buf;
            }

            byte[] reqAuthId = await ReadExact(net, 16);
            byte[] encLen = await ReadExact(net, 18);
            byte[] reqNonce = await ReadExact(net, 8);

            byte[] lKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key_Length"), reqAuthId, reqNonce);
            byte[] lIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce_Length"), reqAuthId, reqNonce)[..12];
            ushort headerLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(
                VmessAeadClient.AesGcmOpen(lKey, lIv, encLen, reqAuthId));

            byte[] encHdr = await ReadExact(net, headerLen + 16);
            byte[] hKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key"), reqAuthId, reqNonce);
            byte[] hIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce"), reqAuthId, reqNonce)[..12];
            byte[] hdr = VmessAeadClient.AesGcmOpen(hKey, hIv, encHdr, reqAuthId);

            byte[] reqBodyIv = hdr[1..17];
            byte[] reqBodyKey = hdr[17..33];
            byte respAuthV = hdr[33];

            // Consume first encrypted HTTP request chunk
            ushort chunkLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(await ReadExact(net, 2));
            _ = await ReadExact(net, chunkLen);

            // Prefix response with fake HTTP/1.1 200 OK header just like Xray-core TCP/HTTP server
            byte[] fakeRespHeader = Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\nCache-Control: private\r\nContent-Type: application/octet-stream\r\n\r\n");
            await net.WriteAsync(fakeRespHeader);

            byte[] respBodyKey = System.Security.Cryptography.SHA256.HashData(reqBodyKey)[..16];
            byte[] respBodyIv = System.Security.Cryptography.SHA256.HashData(reqBodyIv)[..16];
            byte[] rLenKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Len Key"));
            byte[] rLenIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header Len IV"))[..12];
            byte[] rHdrKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Key"));
            byte[] rHdrIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header IV"))[..12];

            await net.WriteAsync(VmessAeadClient.AesGcmSeal(rLenKey, rLenIv, new byte[] { 0x00, 0x04 }, ReadOnlySpan<byte>.Empty));
            await net.WriteAsync(VmessAeadClient.AesGcmSeal(rHdrKey, rHdrIv, new byte[] { respAuthV, 0x00, 0x00, 0x00 }, ReadOnlySpan<byte>.Empty));

            byte[] httpBody = Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 18\r\nConnection: close\r\n\r\nVMESS_HTTP_OBFS_OK");
            byte[] respChunkIv0 = new byte[12];
            Buffer.BlockCopy(respBodyIv, 2, respChunkIv0, 2, 10);
            byte[] sealedResp = VmessAeadClient.AesGcmSeal(respBodyKey, respChunkIv0, httpBody, ReadOnlySpan<byte>.Empty);
            byte[] respFrame = new byte[2 + sealedResp.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(respFrame.AsSpan(0, 2), (ushort)sealedResp.Length);
            Buffer.BlockCopy(sealedResp, 0, respFrame, 2, sealedResp.Length);
            await net.WriteAsync(respFrame);

            byte[] respChunkIv1 = new byte[12];
            respChunkIv1[1] = 1;
            Buffer.BlockCopy(respBodyIv, 2, respChunkIv1, 2, 10);
            byte[] sealedEof = VmessAeadClient.AesGcmSeal(respBodyKey, respChunkIv1, ReadOnlySpan<byte>.Empty, ReadOnlySpan<byte>.Empty);
            byte[] eofFrame = new byte[2 + sealedEof.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(eofFrame.AsSpan(0, 2), (ushort)sealedEof.Length);
            Buffer.BlockCopy(sealedEof, 0, eofFrame, 2, sealedEof.Length);
            await net.WriteAsync(eofFrame);
            await net.FlushAsync();
        });

        using HttpClient vmessHttp = ProxyHttpClientFactory.CreateHttpClient(new AgentConfig
        {
            ProxyEnabled = true,
            ProxyAddress = tcpHttpLink
        }, TimeSpan.FromSeconds(10));

        string responseText = await vmessHttp.GetStringAsync("http://vrcx-obfs.internal:80/test");
        await serverTask;

        Assert.Equal("VMESS_HTTP_OBFS_OK", responseText);
        Assert.NotNull(capturedObfsHeader);
        Assert.StartsWith("GET /ray HTTP/1.1\r\n", capturedObfsHeader);
        Assert.Contains("Host: a.obfs.example\r\n", capturedObfsHeader);

        // 3. Verify AgentUpdater.CleanupOldInstallers removes leftover .exe and .part files cleanly
        string tempUpdatesDir = Path.Combine(Path.GetTempPath(), "vrcx-cleanup-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempUpdatesDir);
        try
        {
            string oldExe = Path.Combine(tempUpdatesDir, "VRCX.Agent-v1.6.0-Setup-win-x64.exe");
            string stalePart = Path.Combine(tempUpdatesDir, "VRCX.Agent-v1.7.0-Setup-win-x64.exe.part");
            string keepNote = Path.Combine(tempUpdatesDir, "keep.txt");
            await File.WriteAllBytesAsync(oldExe, new byte[] { 1, 2, 3 });
            await File.WriteAllBytesAsync(stalePart, new byte[] { 4, 5, 6 });
            await File.WriteAllTextAsync(keepNote, "keep");

            int removed = AgentUpdater.CleanupOldInstallers(tempUpdatesDir);
            Assert.Equal(2, removed);
            Assert.False(File.Exists(oldExe));
            Assert.False(File.Exists(stalePart));
            Assert.True(File.Exists(keepNote));
        }
        finally
        {
            if (Directory.Exists(tempUpdatesDir)) Directory.Delete(tempUpdatesDir, recursive: true);
        }
    }

    [Fact]
    public async Task ScreenshotPipeline_UploadsEachPhotoStrictlyOnceAcrossRestartsAndCompressionSwitch()
    {
        string tempDir = Path.Combine(Path.GetTempPath(), "vrcx-shot-dedupe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            string pngPath = Path.Combine(tempDir, "VRChat_2026-11-24_06-00-00.000_1920x1080.png");
            string copiedPath = Path.Combine(tempDir, "renamed_copy.png");
            using (var img = new Image<Rgba32>(16, 16, new Rgba32(120, 180, 240, 255)))
            {
                img.SaveAsPng(pngPath);
            }
            File.Copy(pngPath, copiedPath);

            var cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "vrcx_sync_test_secret_key",
                AutoUploadScreenshots = true,
                CompressScreenshots = false
            };

            int uploadCount = 0;
            string? firstUploadedUrl = null;
            using var http = new HttpClient(new StubHttpHandler(req =>
            {
                Interlocked.Increment(ref uploadCount);
                firstUploadedUrl ??= req.RequestUri?.AbsoluteUri;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"ok\":true,\"data\":{\"duplicate\":false}}", Encoding.UTF8, "application/json")
                });
            }));

            var task = new PendingScreenshotTask
            {
                LocalPath = pngPath,
                TakenAtIso = "2026-11-24T06:00:00.000Z",
                WorldId = "wrld_once",
                WorldName = "Once World"
            };

            // 1. First upload sends exactly 1 PUT request and persists ledger
            var pipeline1 = new ScreenshotPipeline(() => cfg, http, tempDir);
            Assert.False(pipeline1.HasAlreadyUploaded(pngPath));
            Assert.True(await pipeline1.UploadQueuedTaskAsync(task, CancellationToken.None));
            Assert.Equal(1, uploadCount);
            Assert.True(pipeline1.HasAlreadyUploaded(pngPath));

            // 2. Immediate retry on same pipeline sends 0 extra PUT requests
            Assert.True(await pipeline1.UploadQueuedTaskAsync(task, CancellationToken.None));
            Assert.Equal(1, uploadCount);

            // 3. New pipeline instance (simulating agent restart) + compression toggled ON still skips upload
            cfg.CompressScreenshots = true;
            var pipeline2 = new ScreenshotPipeline(() => cfg, http, tempDir);
            Assert.True(pipeline2.HasAlreadyUploaded(pngPath));
            Assert.True(await pipeline2.UploadQueuedTaskAsync(task, CancellationToken.None));
            Assert.Equal(1, uploadCount);

            // 4. Renamed copy with identical file bytes is caught by source-file SHA-256 deduplication -> 0 extra PUTs
            var renamedTask = new PendingScreenshotTask
            {
                LocalPath = copiedPath,
                TakenAtIso = "2026-11-24T06:00:00.000Z",
                WorldId = "wrld_once",
                WorldName = "Once World"
            };
            Assert.True(await pipeline2.UploadQueuedTaskAsync(renamedTask, CancellationToken.None));
            Assert.Equal(1, uploadCount);
            Assert.NotNull(firstUploadedUrl);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public async Task ScreenshotPipeline_ScansHistoricalPhotosReadsConfigAndExistingMetadataOnceOnly()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-hist-scan-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "vrc-log");
        string customPhotosDir = Path.Combine(tempRoot, "MyCustomPhotos");
        string monthDir = Path.Combine(customPhotosDir, "2026-11");
        string printsDir = Path.Combine(customPhotosDir, "Prints");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(monthDir);
        Directory.CreateDirectory(printsDir);
        Directory.CreateDirectory(stateDir);

        try
        {
            // 1. VRChat config.json picture_output_folder takes precedence
            await File.WriteAllTextAsync(
                Path.Combine(logDir, "config.json"),
                Newtonsoft.Json.JsonConvert.SerializeObject(new { picture_output_folder = customPhotosDir }),
                Encoding.UTF8);
            Assert.Equal(customPhotosDir, ScreenshotPipeline.ResolveVrChatPhotosDirectory(logDir));

            // 2. Create two historical VRChat photos (one with embedded VRCX PNG metadata) + one Print that must be ignored
            string olderPhoto = Path.Combine(monthDir, "VRChat_2026-11-10_08-15-30.500_1920x1080.png");
            string newerPhoto = Path.Combine(monthDir, "VRChat_2026-11-24_21-35-00.000_1920x1080.png");
            string ignoredPrint = Path.Combine(printsDir, "VRChat_2026-11-24_22-00-00.000_1920x1080.png");

            using (var img = new Image<Rgba32>(20, 20, new Rgba32(10, 20, 30, 255)))
            {
                img.SaveAsPng(olderPhoto);
            }
            using (var img = new Image<Rgba32>(20, 20, new Rgba32(200, 100, 50, 255)))
            {
                img.SaveAsPng(newerPhoto);
            }
            using (var img = new Image<Rgba32>(20, 20, new Rgba32(99, 99, 99, 255)))
            {
                img.SaveAsPng(ignoredPrint);
            }

            ScreenshotPipeline.WriteVrcxPngMetadata(newerPhoto, new ScreenshotMetaPayload
            {
                WorldId = "wrld_sakura_123",
                WorldName = "Sakura Shrine",
                InstanceId = "12345"
            });

            var cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "vrcx_sync_test_secret_key",
                AutoUploadScreenshots = true,
                CompressScreenshots = false
            };

            int putCount = 0;
            using var http = new HttpClient(new StubHttpHandler(_ =>
            {
                Interlocked.Increment(ref putCount);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"ok\":true,\"data\":{\"duplicate\":false}}", Encoding.UTF8, "application/json")
                });
            }));

            var pipeline = new ScreenshotPipeline(() => cfg, http, stateDir);
            List<PendingScreenshotTask> scanned = pipeline.ScanUnsyncedScreenshots(customPhotosDir, maxResults: 50);

            // Must find both VRChat photos newest-first, ignore Prints/, parse exact timestamps, and extract WorldName
            Assert.Equal(2, scanned.Count);
            Assert.Equal(newerPhoto, scanned[0].LocalPath);
            Assert.Equal(olderPhoto, scanned[1].LocalPath);
            Assert.Equal("Sakura Shrine", scanned[0].WorldName);
            Assert.Equal("wrld_sakura_123", scanned[0].WorldId);

            DateTimeOffset parsedNewerLocal = DateTimeOffset.Parse(scanned[0].TakenAtIso).ToLocalTime();
            Assert.Equal(2026, parsedNewerLocal.Year);
            Assert.Equal(11, parsedNewerLocal.Month);
            Assert.Equal(24, parsedNewerLocal.Day);
            Assert.Equal(21, parsedNewerLocal.Hour);
            Assert.Equal(35, parsedNewerLocal.Minute);

            // Uploading both marks them persisted so a second scan returns 0 items
            foreach (PendingScreenshotTask t in scanned)
            {
                Assert.True(await pipeline.UploadQueuedTaskAsync(t, CancellationToken.None));
            }
            Assert.Equal(2, putCount);
            Assert.Empty(pipeline.ScanUnsyncedScreenshots(customPhotosDir, maxResults: 50));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void CommandValidator_AcceptsFullVrChatInviteLaunchUrlsAndRejectsInjection()
    {
        Assert.True(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345~region(jp)"));
        Assert.True(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?ref=vrcx.app&id=wrld_12345678-1234-1234-1234-1234567890ab:12345~private(usr_abc)&shortName=abc123&attach=1"));

        Assert.False(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?ref=vrcx.app&shortName=abc123")); // missing id
        Assert.False(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345&evil=1")); // unknown param
        Assert.False(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345 --no-vr")); // whitespace injection
    }

    [Fact]
    public void LogTailCollector_BackfillsHistoricalOutputLogsOnceWithoutPollutingLiveParser()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-hist-logs-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);

        try
        {
            string olderLog = Path.Combine(logDir, "output_log_2026-11-20_10-00-00.txt");
            string newerLog = Path.Combine(logDir, "output_log_2026-11-24_20-00-00.txt");

            File.WriteAllLines(olderLog, new[]
            {
                "2026.11.20 10:01:00 Log        -  [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:1001",
                "2026.11.20 10:01:02 Log        -  [Behaviour] Entering Room: Old Memory Shrine",
                "2026.11.20 10:02:00 Log        -  [Behaviour] OnPlayerJoined OldFriend (usr_11111111-1111-1111-1111-111111111111)",
                @"2026.11.20 10:03:00 Log        -  [VRC Camera] Took screenshot to: C:\old_shot.png"
            });
            File.SetLastWriteTimeUtc(olderLog, new DateTime(2026, 11, 20, 10, 5, 0, DateTimeKind.Utc));

            File.WriteAllLines(newerLog, new[]
            {
                "2026.11.24 20:01:00 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:2002",
                "2026.11.24 20:01:02 Log        -  [Behaviour] Entering Room: Live Current World"
            });
            File.SetLastWriteTimeUtc(newerLog, new DateTime(2026, 11, 24, 20, 5, 0, DateTimeKind.Utc));

            int liveScreenshotCallbacks = 0;
            var collector1 = new LogTailCollector(stateDir);
            collector1.ScreenshotCaptured += _ => liveScreenshotCallbacks++;

            int parsed = collector1.PollLogDirectory(logDir);
            Assert.Equal(4, parsed); // Old Memory Shrine + OldFriend + Screenshot event + Live Current World
            // Historical log screenshot must NOT trigger live ScreenshotCaptured callback
            Assert.Equal(0, liveScreenshotCallbacks);
            // Live parser must reflect ONLY the newest active log file, not polluted by older logs
            Assert.Equal("Live Current World", collector1.Parser.CurrentWorldName);
            Assert.Equal(0, collector1.Parser.CurrentPlayerCount);

            List<GameLogEventItem> queued = collector1.PeekBatch(20);
            Assert.Contains(queued, e => e.Type == "Location" && e.WorldName == "Old Memory Shrine");
            Assert.Contains(queued, e => e.Type == "OnPlayerJoined" && e.DisplayName == "OldFriend");
            Assert.Contains(queued, e => e.Type == "Location" && e.WorldName == "Live Current World");

            // Polling again (including after restart with a fresh LogTailCollector) must NOT re-read historical logs
            Assert.Equal(0, collector1.PollLogDirectory(logDir));
            var collector2 = new LogTailCollector(stateDir);
            Assert.Equal(0, collector2.PollLogDirectory(logDir));

            // Appending a new line to the latest log is still picked up cleanly
            File.AppendAllLines(newerLog, new[]
            {
                "2026.11.24 20:06:00 Log        -  [Behaviour] OnPlayerJoined LiveBuddy (usr_22222222-2222-2222-2222-222222222222)"
            });
            Assert.Equal(1, collector2.PollLogDirectory(logDir));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void LocalProcessMonitor_SelectsEarliestStartTimeAndSerializesStateTimestamps()
    {
        var older = new DateTimeOffset(2026, 11, 24, 1, 15, 0, TimeSpan.Zero);
        var newer = new DateTimeOffset(2026, 11, 24, 2, 30, 0, TimeSpan.Zero);
        var prev = new DateTimeOffset(2026, 11, 24, 2, 0, 0, TimeSpan.Zero);
        var fallbackNow = new DateTimeOffset(2026, 11, 24, 3, 0, 0, TimeSpan.Zero);

        // Prefers earliest valid OS process start timestamp
        Assert.Equal(older, LiveAgentState.SelectEarliestStartTimeUtc(new[] { newer, older }, prev, fallbackNow));
        // Falls back to previously observed start timestamp when Win32 handle permissions restrict reads
        Assert.Equal(prev, LiveAgentState.SelectEarliestStartTimeUtc(Array.Empty<DateTimeOffset>(), prev, fallbackNow));
        // Falls back to detection time only when no prior timestamp exists
        Assert.Equal(fallbackNow, LiveAgentState.SelectEarliestStartTimeUtc(Array.Empty<DateTimeOffset>(), null, fallbackNow));

        var liveState = new LiveAgentState
        {
            VrcRunning = true,
            VrcStartedAt = older.ToString("O"),
            SteamVrRunning = true,
            SteamVrStartedAt = prev.ToString("O")
        };
        string json = JsonConvert.SerializeObject(liveState);
        Assert.Contains("\"vrcStartedAt\":\"2026-11-24T01:15:00.0000000+00:00\"", json);
        Assert.Contains("\"steamVrStartedAt\":\"2026-11-24T02:00:00.0000000+00:00\"", json);
    }

    [Fact]
    public void VrcLogParser_HandlesRealVrChatEnteringBeforeJoiningOrder_OnLeftRoom_AndStartupWarmup()
    {
        var parser = new VrcLogParser();

        // Real VRChat output_log order: Entering Room precedes Joining (matching Dotnet/LogWatcher.cs)
        Assert.Null(parser.ParseLine("2026.11.24 14:00:01 Log        -  [Behaviour] Entering Room: VRChat Home"));
        GameLogEventItem? room1 = parser.ParseLine("2026.11.24 14:00:01 Log        -  [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:1001~private(usr_self)");
        Assert.NotNull(room1);
        Assert.Equal("Location", room1!.Type);
        Assert.Equal("wrld_11111111-1111-1111-1111-111111111111:1001~private(usr_self)", room1.Location);
        Assert.Equal("VRChat Home", room1.WorldName);

        parser.ParseLine("2026.11.24 14:00:05 Log        -  [Behaviour] OnPlayerJoined Alice (usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)");
        parser.ParseLine("2026.11.24 14:00:06 Log        -  [Behaviour] OnPlayerJoined Bob (usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb)");
        Assert.Equal(2, parser.CurrentPlayerCount);
        List<AgentPlayerSnapshot> details = parser.SnapshotCurrentPlayerDetails();
        Assert.Equal(2, details.Count);
        Assert.Contains(details, p => p.DisplayName == "Alice" && p.UserId == "usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" && !string.IsNullOrEmpty(p.JoinedAt));

        // OnLeftRoom clears current room players cleanly
        Assert.Null(parser.ParseLine("2026.11.24 14:05:00 Debug      -  [Behaviour] OnLeftRoom"));
        Assert.Equal(0, parser.CurrentPlayerCount);

        // Entering second room must pair Room 2's name with Room 2's location (never Room 1's location)
        Assert.Null(parser.ParseLine("2026.11.24 14:05:05 Log        -  [Behaviour] Entering Room: Sakura Shrine"));
        GameLogEventItem? room2 = parser.ParseLine("2026.11.24 14:05:05 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:2002~region(jp)");
        Assert.NotNull(room2);
        Assert.Equal("wrld_22222222-2222-2222-2222-222222222222:2002~region(jp)", room2!.Location);
        Assert.Equal("Sakura Shrine", room2.WorldName);

        // Verify LogTailCollector warms up live room & player state on Agent restart without re-enqueueing events
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-warmup-test-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);
        try
        {
            string logFile = Path.Combine(logDir, "output_log_2026-11-24_14-00-00.txt");
            File.WriteAllLines(logFile, new[]
            {
                "2026.11.24 14:05:05 Log        -  [Behaviour] Entering Room: Sakura Shrine",
                "2026.11.24 14:05:05 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:2002~region(jp)",
                "2026.11.24 14:05:08 Log        -  [Behaviour] OnPlayerJoined Charlie (usr_cccccccc-cccc-cccc-cccc-cccccccccccc)"
            });

            var c1 = new LogTailCollector(stateDir);
            Assert.Equal(2, c1.PollLogDirectory(logDir));
            c1.AcknowledgeBatch(2);

            // Simulate Agent restart: fresh collector sees cursor at EOF, warms up Parser state, enqueues 0 duplicates
            var c2 = new LogTailCollector(stateDir);
            Assert.Equal(0, c2.PollLogDirectory(logDir));
            Assert.Equal(0, c2.OfflineQueueCount);
            Assert.Equal("wrld_22222222-2222-2222-2222-222222222222:2002~region(jp)", c2.Parser.CurrentLocation);
            Assert.Equal("Sakura Shrine", c2.Parser.CurrentWorldName);
            Assert.Equal(1, c2.Parser.CurrentPlayerCount);
            Assert.Contains(c2.Parser.SnapshotCurrentPlayerDetails(), p => p.UserId == "usr_cccccccc-cccc-cccc-cccc-cccccccccccc");
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void VrcLogParser_PreservesLocationWhenEnteringRoomLineIsMissing()
    {
        var parser = new VrcLogParser();

        // Joining without a preceding Entering Room buffers a pending Location event
        Assert.Null(parser.ParseLine("2026.11.24 16:00:00 Log        -  [Behaviour] Joining wrld_33333333-3333-3333-3333-333333333333:3003~region(jp)"));
        GameLogEventItem? flushed = parser.FlushPendingLocation();
        Assert.NotNull(flushed);
        Assert.Equal("Location", flushed!.Type);
        Assert.Equal("wrld_33333333-3333-3333-3333-333333333333:3003~region(jp)", flushed.Location);
        Assert.Equal("wrld_33333333-3333-3333-3333-333333333333", flushed.WorldId);
        // Subsequent flush returns null (no duplicate)
        Assert.Null(parser.FlushPendingLocation());

        // Verify LogTailCollector flushes pending Location before OnPlayerJoined when Entering Room is absent
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-no-entering-test-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);
        try
        {
            string logFile = Path.Combine(logDir, "output_log_2026-11-24_16-00-00.txt");
            File.WriteAllLines(logFile, new[]
            {
                "2026.11.24 16:00:00 Log        -  [Behaviour] Joining wrld_44444444-4444-4444-4444-444444444444:4004~region(jp)",
                "2026.11.24 16:00:05 Log        -  [Behaviour] OnPlayerJoined SoloBuddy (usr_44444444-4444-4444-4444-444444444444)"
            });

            var collector = new LogTailCollector(stateDir);
            int parsed = collector.PollLogDirectory(logDir);
            Assert.Equal(2, parsed);
            List<GameLogEventItem> batch = collector.PeekBatch(10);
            Assert.Equal("Location", batch[0].Type);
            Assert.Equal("wrld_44444444-4444-4444-4444-444444444444:4004~region(jp)", batch[0].Location);
            Assert.Equal("OnPlayerJoined", batch[1].Type);
            Assert.Equal("SoloBuddy", batch[1].DisplayName);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void VrcLogParser_ParsesLegacyUserIdsParenthesizedNamesAndRemovesByUserId()
    {
        var parser = new VrcLogParser();
        Assert.Null(parser.ParseLine("2026.11.27 10:00:00 Log        -  [RoomManager] Entering Room: Legacy Shrine"));
        GameLogEventItem? loc = parser.ParseLine("2026.11.27 10:00:01 Log        -  [RoomManager] Joining wrld_55555555-5555-5555-5555-555555555555:5005~region(jp)");
        Assert.NotNull(loc);
        Assert.Equal("Legacy Shrine", loc!.WorldName);

        // Legacy 10-char VRChat user ID (non-usr_ prefix) + parenthesized display name without ID + standard usr_ ID
        GameLogEventItem? legacyJoin = parser.ParseLine("2026.11.27 10:00:05 Debug      -  [Behaviour] OnPlayerJoined OldTimer (8JoV9XEdpo)");
        Assert.NotNull(legacyJoin);
        Assert.Equal("OldTimer", legacyJoin!.DisplayName);
        Assert.Equal("8JoV9XEdpo", legacyJoin.UserId);

        GameLogEventItem? parenNameJoin = parser.ParseLine("2026.11.27 10:00:06 Debug      -  [Behaviour] OnPlayerJoined Sakura (AFK)");
        Assert.NotNull(parenNameJoin);
        Assert.Equal("Sakura (AFK)", parenNameJoin!.DisplayName);
        Assert.Equal(string.Empty, parenNameJoin.UserId);

        // Ignored synthetic OnPlayerJoined:Unnamed & OnPlayerLeftRoom lines must not pollute player list
        Assert.Null(parser.ParseLine("2026.11.27 10:00:07 Log        -  [Behaviour] OnPlayerJoined:Unnamed"));
        Assert.Equal(2, parser.CurrentPlayerCount);

        // OnPlayerLeft with changed display name still removes by matching UserId
        GameLogEventItem? legacyLeft = parser.ParseLine("2026.11.27 10:01:00 Debug      -  [Behaviour] OnPlayerLeft OldTimerRenamed (8JoV9XEdpo)");
        Assert.NotNull(legacyLeft);
        Assert.Equal(1, parser.CurrentPlayerCount);
        Assert.Single(parser.SnapshotCurrentPlayerDetails());
        Assert.Equal("Sakura (AFK)", parser.SnapshotCurrentPlayerDetails()[0].DisplayName);
    }

    [Fact]
    public void CommandValidator_AllowsRegionalAwsS3AndGoogleTranslateAndYouTubeHosts()
    {
        Assert.True(CommandValidator.IsAllowedVrcUrl("https://s3.us-west-2.amazonaws.com/bucket/file.png"));
        Assert.True(CommandValidator.IsAllowedVrcUrl("https://vrc-bucket.s3-ap-northeast-1.amazonaws.com/file.png"));
        Assert.True(CommandValidator.IsAllowedVrcUrl("https://www.googleapis.com/youtube/v3/videos?id=abc"));
        Assert.True(CommandValidator.IsAllowedVrcUrl("https://translation.googleapis.com/language/translate/v2"));
        Assert.False(CommandValidator.IsAllowedVrcUrl("https://evil-s3.amazonaws.com.attacker.test/file.png"));
        Assert.False(CommandValidator.IsAllowedVrcUrl("http://s3.us-west-2.amazonaws.com/bucket/file.png"));
    }

    [Fact]
    public async Task ScreenshotPipeline_ClassifiesPoisonPillAsPermanentFailureAndServerErrorAsTransient()
    {
        string tempDir = Path.Combine(Path.GetTempPath(), "vrcx-poison-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        string corruptPng = Path.Combine(tempDir, "corrupt.png");
        string validPng = Path.Combine(tempDir, "valid.png");
        try
        {
            await File.WriteAllBytesAsync(corruptPng, new byte[] { 0x00, 0x01, 0x02, 0x03, 0x04 });
            using (var img = new SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>(16, 16))
            {
                img.SaveAsPng(validPng);
            }

            var compressedCfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "secret",
                AutoUploadScreenshots = true,
                CompressScreenshots = true
            };

            // 1. Corrupt image fails ImageSharp decoding -> PermanentFailure (never blocks queue forever)
            using (var httpOk = new HttpClient(new StubHttpHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)))))
            {
                var pipeline = new ScreenshotPipeline(() => compressedCfg, httpOk);
                ScreenshotUploadOutcome corruptOutcome = await pipeline.UploadQueuedTaskWithOutcomeAsync(
                    new PendingScreenshotTask { LocalPath = corruptPng, TakenAtIso = "2026-11-24T15:00:00Z" },
                    CancellationToken.None);
                Assert.Equal(ScreenshotUploadOutcome.PermanentFailure, corruptOutcome);
            }

            // 2. HTTP 413 RequestEntityTooLarge -> PermanentFailure
            using (var http413 = new HttpClient(new StubHttpHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.RequestEntityTooLarge)))))
            {
                var pipeline = new ScreenshotPipeline(() => compressedCfg, http413);
                ScreenshotUploadOutcome tooLargeOutcome = await pipeline.UploadQueuedTaskWithOutcomeAsync(
                    new PendingScreenshotTask { LocalPath = validPng, TakenAtIso = "2026-11-24T15:00:00Z" },
                    CancellationToken.None);
                Assert.Equal(ScreenshotUploadOutcome.PermanentFailure, tooLargeOutcome);
            }

            // 3. HTTP 503 ServiceUnavailable & 429 TooManyRequests -> TransientFailure (retryable)
            foreach (HttpStatusCode retryableCode in new[] { HttpStatusCode.ServiceUnavailable, HttpStatusCode.TooManyRequests, HttpStatusCode.Unauthorized })
            {
                using var httpRetry = new HttpClient(new StubHttpHandler(_ => Task.FromResult(new HttpResponseMessage(retryableCode))));
                var pipeline = new ScreenshotPipeline(() => compressedCfg, httpRetry);
                ScreenshotUploadOutcome transientOutcome = await pipeline.UploadQueuedTaskWithOutcomeAsync(
                    new PendingScreenshotTask { LocalPath = validPng, TakenAtIso = "2026-11-24T15:00:00Z" },
                    CancellationToken.None);
                Assert.Equal(ScreenshotUploadOutcome.TransientFailure, transientOutcome);
            }
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public async Task Wave3_AgentFixes_CoverPartialLinesRotationQueueRecoveryPngIdAtomicPayloadBudgetHeaderClampAndVmessAuth()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-w3-agent-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);

        try
        {
            // 1. P1-24: Partial line without trailing newline is NOT dropped; completed on next poll
            string log1 = Path.Combine(logDir, "output_log_2026-11-25_01-00-00.txt");
            await File.WriteAllTextAsync(
                log1,
                "2026.11.25 01:00:01 Log        -  [Behaviour] Entering Room: HalfLine World\n" +
                "2026.11.25 01:00:01 Log        -  [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:100\n" +
                "2026.11.25 01:00:05 Log        -  [Behaviour] OnPlayerJoined Ali",
                Encoding.UTF8);

            var collector = new LogTailCollector(stateDir);
            Assert.Equal(1, collector.PollLogDirectory(logDir)); // Only Location parsed; partial join waits
            Assert.Equal(0, collector.SnapshotLiveRoomState().CurrentPlayerCount);

            // Finish writing the line with newline -> next poll parses complete player join cleanly
            await File.AppendAllTextAsync(
                log1,
                "ce (usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)\n",
                Encoding.UTF8);
            Assert.Equal(1, collector.PollLogDirectory(logDir));
            LogTailCollector.LiveRoomSnapshot snap1 = collector.SnapshotLiveRoomState();
            Assert.Equal(1, snap1.CurrentPlayerCount);
            // P1-25: SnapshotCurrentPlayers uses upstream VRCX v2 key `id`
            Assert.Equal("usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", snap1.PlayersForMetadata[0]["id"]);
            Assert.Equal("Alice", snap1.PlayersForMetadata[0]["displayName"]);

            // Log rotation drains old file tail and resets live room/player state for new file
            await File.AppendAllTextAsync(
                log1,
                "2026.11.25 01:05:00 Log        -  [Behaviour] OnPlayerJoined TailFriend (usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb)\n",
                Encoding.UTF8);
            string log2 = Path.Combine(logDir, "output_log_2026-11-25_02-00-00.txt");
            await File.WriteAllTextAsync(
                log2,
                "2026.11.25 02:00:01 Log        -  [Behaviour] Entering Room: Fresh Session World\n" +
                "2026.11.25 02:00:01 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:200\n",
                Encoding.UTF8);
            File.SetLastWriteTimeUtc(log1, new DateTime(2026, 11, 25, 1, 5, 0, DateTimeKind.Utc));
            File.SetLastWriteTimeUtc(log2, new DateTime(2026, 11, 25, 2, 0, 5, DateTimeKind.Utc));

            int rotatedParsed = collector.PollLogDirectory(logDir);
            Assert.Equal(2, rotatedParsed); // TailFriend from log1 + Fresh Session World from log2
            LogTailCollector.LiveRoomSnapshot snap2 = collector.SnapshotLiveRoomState();
            Assert.Equal("Fresh Session World", snap2.CurrentWorldName);
            Assert.Equal(0, snap2.CurrentPlayerCount); // Stale players from log1 cleared on rotation

            // 2. P1-24: Corrupted single line in offline-queue.jsonl does not wipe subsequent valid entries
            string queueFile = Path.Combine(stateDir, "offline-queue.jsonl");
            await File.WriteAllLinesAsync(queueFile, new[]
            {
                "{\"type\":\"Event\",\"created_at\":\"2026-11-25T01:00:00Z\",\"data\":\"first-ok\"}",
                "{corrupted-json-line",
                "{\"type\":\"Event\",\"created_at\":\"2026-11-25T01:01:00Z\",\"data\":\"second-ok\"}"
            });
            var recovered = new LogTailCollector(stateDir);
            Assert.Equal(2, recovered.OfflineQueueCount);

            // 3. P1-25: WriteVrcxPngMetadata atomically writes `id` + `displayName`, and BuildTaskFromExistingFile reads it back
            string pngPath = Path.Combine(tempRoot, "VRChat_2026-11-25_02-10-00.000_1920x1080.png");
            using (var img = new Image<Rgba32>(16, 16, new Rgba32(10, 20, 30, 255)))
            {
                img.SaveAsPng(pngPath);
            }
            bool embedded = ScreenshotPipeline.WriteVrcxPngMetadata(pngPath, new ScreenshotMetaPayload
            {
                WorldId = "wrld_meta_id",
                WorldName = "Meta World",
                InstanceId = "999",
                Players = new List<Dictionary<string, string>>
                {
                    new() { ["userId"] = "usr_legacy_key", ["displayName"] = "LegacyAlice" }
                }
            });
            Assert.True(embedded);
            PendingScreenshotTask rebuilt = ScreenshotPipeline.BuildTaskFromExistingFile(pngPath);
            Assert.Single(rebuilt.Players);
            Assert.Equal("usr_legacy_key", rebuilt.Players[0]["id"]);
            Assert.Equal("LegacyAlice", rebuilt.Players[0]["displayName"]);

            // 4. P1-26: FitEventsToPayloadBudget splits oversized batches & truncates giant single events; EncodeBoundedMetaHeader clamps large rooms
            var oversizedEvents = new List<GameLogEventItem>
            {
                new() { Type = "Event", CreatedAt = "2026-11-25T00:00:00Z", Data = new string('x', 120_000) },
                new() { Type = "Event", CreatedAt = "2026-11-25T00:00:01Z", Data = new string('y', 120_000) }
            };
            var (fitted, consumed) = HttpSyncClient.FitEventsToPayloadBudget(oversizedEvents, maxPayloadBytes: 150_000);
            Assert.Equal(1, consumed);
            Assert.Single(fitted);

            var giantSingle = new List<GameLogEventItem>
            {
                new() { Type = "Event", CreatedAt = "2026-11-25T00:00:02Z", Data = new string('z', 300_000) }
            };
            var (clampedList, clampedConsumed) = HttpSyncClient.FitEventsToPayloadBudget(giantSingle, maxPayloadBytes: 200_000);
            Assert.Equal(1, clampedConsumed);
            Assert.True(clampedList[0].Data!.Length <= 4096);

            var crowdedMeta = new ScreenshotMetaPayload
            {
                TakenAt = "2026-11-25T02:00:00Z",
                LocalFilename = "crowded.png",
                WorldId = "wrld_crowded",
                WorldName = "Crowded Event",
                Players = new List<Dictionary<string, string>>()
            };
            for (int i = 0; i < 200; i++)
            {
                crowdedMeta.Players.Add(new Dictionary<string, string>
                {
                    ["id"] = $"usr_{i:D8}-1111-2222-3333-444444444444",
                    ["displayName"] = $"VeryLongPlayerDisplayName_{i:D3}"
                });
            }
            string boundedHeader = ScreenshotPipeline.EncodeBoundedMetaHeader(crowdedMeta, maxBase64Length: 6144);
            Assert.True(boundedHeader.Length <= 6144);

            // 5. P1-23 & P2-11: Invalid vmess:// server does not throw UriFormatException in NormalizeAndValidateProxyUri;
            //    CreateHandler throws ArgumentException instead of silently falling back to direct/system proxy
            string badHostVmess = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(
                "{\"add\":\"bad host with spaces\",\"port\":443,\"id\":\"de305d54-75b4-431b-adb2-eb6b9e546014\",\"net\":\"tcp\"}"));
            var (badVmessOk, _, _) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri(badHostVmess);
            Assert.False(badVmessOk);
            Assert.Throws<ArgumentException>(() => ProxyHttpClientFactory.CreateHandler(proxyEnabled: true, badHostVmess));
            Assert.Throws<ArgumentException>(() => ProxyHttpClientFactory.CreateHandler(proxyEnabled: true, "ftp://127.0.0.1:21"));

            // 6. P1-27: Assembly version normalization strips +gitsha metadata cleanly
            Assert.Equal("1.11.0", AgentMetadata.NormalizeInformationalVersion("1.11.0+abcdef1234"));
            Assert.Equal(AgentMetadata.FallbackVersion, AgentMetadata.NormalizeInformationalVersion(""));

            // 7. P2-11: VMess AEAD stream strictly authenticates the 16-byte EOF tag (forged EOF tag throws CryptographicException)
            using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            byte[] uuidBytes = VmessConfig.TryParseUuidBigEndian("de305d54-75b4-431b-adb2-eb6b9e546014", out byte[] ub) ? ub : Array.Empty<byte>();
            byte[] cmdKey = VmessAeadClient.ComputeCmdKey(uuidBytes);
            string forgedVmessLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(
                $"{{\"v\":\"2\",\"add\":\"127.0.0.1\",\"port\":{port},\"id\":\"de305d54-75b4-431b-adb2-eb6b9e546014\",\"aid\":0,\"scy\":\"aes-128-gcm\",\"net\":\"tcp\",\"tls\":\"\"}}"));

            Task forgedServer = Task.Run(async () =>
            {
                using var tcp = await listener.AcceptTcpClientAsync();
                using var net = tcp.GetStream();
                static async Task<byte[]> ReadExact(Stream s, int n)
                {
                    byte[] b = new byte[n];
                    int t = 0;
                    while (t < n) { int r = await s.ReadAsync(b.AsMemory(t, n - t)); if (r == 0) throw new EndOfStreamException(); t += r; }
                    return b;
                }
                byte[] reqAuthId = await ReadExact(net, 16);
                byte[] encLen = await ReadExact(net, 18);
                byte[] reqNonce = await ReadExact(net, 8);
                byte[] lKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key_Length"), reqAuthId, reqNonce);
                byte[] lIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce_Length"), reqAuthId, reqNonce)[..12];
                ushort headerLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(VmessAeadClient.AesGcmOpen(lKey, lIv, encLen, reqAuthId));
                byte[] encHdr = await ReadExact(net, headerLen + 16);
                byte[] hKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key"), reqAuthId, reqNonce);
                byte[] hIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce"), reqAuthId, reqNonce)[..12];
                byte[] hdr = VmessAeadClient.AesGcmOpen(hKey, hIv, encHdr, reqAuthId);
                byte[] reqBodyIv = hdr[1..17];
                byte[] reqBodyKey = hdr[17..33];
                byte respAuthV = hdr[33];
                ushort firstLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(await ReadExact(net, 2));
                _ = await ReadExact(net, firstLen);

                byte[] respBodyKey = System.Security.Cryptography.SHA256.HashData(reqBodyKey)[..16];
                byte[] respBodyIv = System.Security.Cryptography.SHA256.HashData(reqBodyIv)[..16];
                byte[] rLenKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Len Key"));
                byte[] rLenIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header Len IV"))[..12];
                byte[] rHdrKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Key"));
                byte[] rHdrIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header IV"))[..12];
                await net.WriteAsync(VmessAeadClient.AesGcmSeal(rLenKey, rLenIv, new byte[] { 0x00, 0x04 }, ReadOnlySpan<byte>.Empty));
                await net.WriteAsync(VmessAeadClient.AesGcmSeal(rHdrKey, rHdrIv, new byte[] { respAuthV, 0x00, 0x00, 0x00 }, ReadOnlySpan<byte>.Empty));

                // Send forged 16-byte EOF tag (all zeros -> invalid GCM tag!)
                byte[] forgedEof = new byte[18];
                forgedEof[1] = 16;
                await net.WriteAsync(forgedEof);
                await net.FlushAsync();
            });

            Assert.True(VmessConfig.TryParse(forgedVmessLink, out VmessConfig? forgedCfg, out _));
            await using Stream vmessStream = await VmessAeadClient.ConnectAsync(forgedCfg!, "example.com", 80, CancellationToken.None);
            await vmessStream.WriteAsync(Encoding.ASCII.GetBytes("PING"));
            byte[] readBuf = new byte[32];
            await Assert.ThrowsAsync<System.Security.Cryptography.AuthenticationTagMismatchException>(() =>
                vmessStream.ReadAsync(readBuf, 0, readBuf.Length));
            await forgedServer;
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task Wave4RegressionFixes_VmessWsTlsCustomSni_DisposeNoDeadlock_VrcLogParser_AndPngMetadata()
    {
        // 1. P1-15: VMess WS+TLS sends exact custom SNI (different from connect IP and HTTP Host header)
        string uuid = "de305d54-75b4-431b-adb2-eb6b9e546014";
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var certReq = new System.Security.Cryptography.X509Certificates.CertificateRequest(
            "CN=custom-sni.example",
            rsa,
            System.Security.Cryptography.HashAlgorithmName.SHA256,
            System.Security.Cryptography.RSASignaturePadding.Pkcs1);
        certReq.CertificateExtensions.Add(new System.Security.Cryptography.X509Certificates.X509KeyUsageExtension(
            System.Security.Cryptography.X509Certificates.X509KeyUsageFlags.DigitalSignature |
            System.Security.Cryptography.X509Certificates.X509KeyUsageFlags.KeyEncipherment,
            critical: false));
        certReq.CertificateExtensions.Add(new System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension(
            new System.Security.Cryptography.OidCollection { new System.Security.Cryptography.Oid("1.3.6.1.5.5.7.3.1") },
            critical: false));
        var sanBuilder = new System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder();
        sanBuilder.AddDnsName("custom-sni.example");
        certReq.CertificateExtensions.Add(sanBuilder.Build());
        using var ephemeralCert = certReq.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        // Windows SChannel rejects ephemeral CNG keys from CreateSelfSigned() in AuthenticateAsServerAsync;
        // re-importing via PKCS#12 with UserKeySet materializes a SChannel-compatible private key.
        var keyFlags = OperatingSystem.IsWindows()
            ? System.Security.Cryptography.X509Certificates.X509KeyStorageFlags.UserKeySet |
              System.Security.Cryptography.X509Certificates.X509KeyStorageFlags.Exportable
            : System.Security.Cryptography.X509Certificates.X509KeyStorageFlags.DefaultKeySet;
        using var selfSigned = System.Security.Cryptography.X509Certificates.X509CertificateLoader.LoadPkcs12(
            ephemeralCert.Export(System.Security.Cryptography.X509Certificates.X509ContentType.Pfx),
            password: null,
            keyStorageFlags: keyFlags);

        using var wsListener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        wsListener.Start();
        int wsPort = ((IPEndPoint)wsListener.LocalEndpoint).Port;

        string? capturedSni = null;
        string? capturedUpgradeReq = null;
        Task wsServerTask = Task.Run(async () =>
        {
            using var tcp = await wsListener.AcceptTcpClientAsync();
            using var ssl = new System.Net.Security.SslStream(tcp.GetStream(), leaveInnerStreamOpen: false);
            await ssl.AuthenticateAsServerAsync(new System.Net.Security.SslServerAuthenticationOptions
            {
                ServerCertificateSelectionCallback = (_, hostName) =>
                {
                    capturedSni = hostName;
                    return selfSigned;
                },
                ClientCertificateRequired = false,
                EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls12 | System.Security.Authentication.SslProtocols.Tls13,
                ApplicationProtocols = new List<System.Net.Security.SslApplicationProtocol>
                {
                    System.Net.Security.SslApplicationProtocol.Http11
                }
            });
            byte[] buf = new byte[4096];
            int total = 0;
            while (total < buf.Length)
            {
                int n = await ssl.ReadAsync(buf.AsMemory(total, buf.Length - total));
                if (n == 0) break;
                total += n;
                if (Encoding.ASCII.GetString(buf, 0, total).Contains("\r\n\r\n", StringComparison.Ordinal)) break;
            }
            capturedUpgradeReq = Encoding.ASCII.GetString(buf, 0, total);
            string wsKey = string.Empty;
            foreach (string line in capturedUpgradeReq.Split("\r\n", StringSplitOptions.RemoveEmptyEntries))
            {
                if (line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                {
                    wsKey = line.Substring("Sec-WebSocket-Key:".Length).Trim();
                }
            }
            string accept = Convert.ToBase64String(
                System.Security.Cryptography.SHA1.HashData(
                    Encoding.ASCII.GetBytes(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            string resp = $"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n";
            await ssl.WriteAsync(Encoding.ASCII.GetBytes(resp));
            await ssl.FlushAsync();
            // Keep connection open briefly until client disposes
            try
            {
                await Task.Delay(500);
            }
            catch { }
        });

        string wsTlsJson = $"{{\"v\":\"2\",\"ps\":\"WsTlsCustomSni\",\"add\":\"127.0.0.1\",\"port\":{wsPort},\"id\":\"{uuid}\",\"aid\":0,\"scy\":\"aes-128-gcm\",\"net\":\"ws\",\"type\":\"none\",\"host\":\"cdn-host.example\",\"path\":\"/vws\",\"tls\":\"tls\",\"sni\":\"custom-sni.example\",\"allowInsecure\":true}}";
        string wsTlsLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(wsTlsJson));
        Assert.True(VmessConfig.TryParse(wsTlsLink, out VmessConfig? wsCfg, out _));
        Assert.Equal("custom-sni.example", wsCfg!.EffectiveSni);
        Assert.Equal("cdn-host.example", wsCfg.PrimaryHost);

        using (Stream vmessWsStream = await VmessAeadClient.ConnectAsync(wsCfg, "api.vrchat.cloud", 443, CancellationToken.None))
        {
            Assert.NotNull(vmessWsStream);
        }
        await wsServerTask;
        Assert.Equal("custom-sni.example", capturedSni);
        Assert.NotNull(capturedUpgradeReq);
        Assert.Contains("GET /vws HTTP/1.1", capturedUpgradeReq!);
        Assert.Contains("Host: cdn-host.example", capturedUpgradeReq!);

        // 2. P1-16: Concurrent Dispose() during an active WriteAsync completes immediately without deadlocking or throwing ODE on _writeLock
        using var stallListener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        stallListener.Start();
        int stallPort = ((IPEndPoint)stallListener.LocalEndpoint).Port;
        string stallLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(
            $"{{\"v\":\"2\",\"add\":\"127.0.0.1\",\"port\":{stallPort},\"id\":\"{uuid}\",\"aid\":0,\"scy\":\"aes-128-gcm\",\"net\":\"tcp\",\"tls\":\"\"}}"));
        Assert.True(VmessConfig.TryParse(stallLink, out VmessConfig? stallCfg, out _));
        Task<System.Net.Sockets.TcpClient> acceptTask = stallListener.AcceptTcpClientAsync();
        Stream stallStream = await VmessAeadClient.ConnectAsync(stallCfg!, "example.com", 80, CancellationToken.None);
        using System.Net.Sockets.TcpClient acceptedPeer = await acceptTask;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        stallStream.Dispose();
        await stallStream.DisposeAsync();
        sw.Stop();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2));

        // 3. P2-23: VrcLogParser clears stale world name on missing Entering Room & flushes superseded Joining event
        var parser = new VrcLogParser();
        Assert.Null(parser.ParseLine("2026.11.25 10:00:00 Log        -  [Behaviour] Entering Room: Old World"));
        var ev1 = parser.ParseLine("2026.11.25 10:00:01 Log        -  [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:100");
        Assert.NotNull(ev1);
        Assert.Equal("Old World", ev1!.WorldName);
        Assert.Equal("Old World", parser.CurrentWorldName);

        // Next Joining arrives without Entering Room -> CurrentWorldName cleared (no stale "Old World")
        Assert.Null(parser.ParseLine("2026.11.25 10:05:00 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:200"));
        Assert.Equal(string.Empty, parser.CurrentWorldName);

        // Consecutive Joining without Entering Room -> returns superseded wrld_2222... Location instead of dropping it
        var flushedPrev = parser.ParseLine("2026.11.25 10:05:10 Log        -  [Behaviour] Joining wrld_33333333-3333-3333-3333-333333333333:300");
        Assert.NotNull(flushedPrev);
        Assert.Equal("wrld_22222222-2222-2222-2222-222222222222:200", flushedPrev!.Location);
        var flushedLast = parser.FlushPendingLocation();
        Assert.NotNull(flushedLast);
        Assert.Equal("wrld_33333333-3333-3333-3333-333333333333:300", flushedLast!.Location);

        // 4. P1-20 & P2-24: PNGChunkTypeFilter bitmask, thread-safe CRC32, non-mutating IHDR, malformed iTXt, IsValid seek(0)
        Assert.False((VRCX.PNGChunkTypeFilter.IHDR | VRCX.PNGChunkTypeFilter.sRGB).HasFlag(VRCX.PNGChunkTypeFilter.iTXt));
        Assert.True((VRCX.PNGChunkTypeFilter.IHDR | VRCX.PNGChunkTypeFilter.iTXt).HasFlag(VRCX.PNGChunkTypeFilter.iTXt));

        var ihdrData = new byte[] { 0x00, 0x00, 0x07, 0x80, 0x00, 0x00, 0x04, 0x38, 8, 2, 0, 0, 0 }; // 1920x1080
        var ihdrChunk = new VRCX.PNGChunk
        {
            ChunkType = "IHDR",
            ChunkTypeEnum = VRCX.PNGChunkTypeFilter.IHDR,
            Length = ihdrData.Length,
            Data = ihdrData
        };
        var res1 = ihdrChunk.ReadIHDRChunkResolution();
        var res2 = ihdrChunk.ReadIHDRChunkResolution();
        Assert.Equal((1920, 1080), (res1.Item1, res1.Item2));
        Assert.Equal((1920, 1080), (res2.Item1, res2.Item2));

        var malformedItxt = new VRCX.PNGChunk
        {
            ChunkType = "iTXt",
            ChunkTypeEnum = VRCX.PNGChunkTypeFilter.iTXt,
            Length = 5,
            Data = new byte[] { (byte)'D', (byte)'e', 0, 0, 0 } // textOffset=7 > length=5
        };
        Assert.Null(malformedItxt.ReadITXtChunk());

        uint expectedCrc = ihdrChunk.CalculateCRC();
        var parallelCrcs = new System.Collections.Concurrent.ConcurrentBag<uint>();
        Parallel.For(0, 32, _ => parallelCrcs.Add(ihdrChunk.CalculateCRC()));
        Assert.All(parallelCrcs, c => Assert.Equal(expectedCrc, c));

        // 5. P2-21 & P1-18: Manual update balloon does not falsely claim automatic background download
        Assert.DoesNotContain("自动下载", AgentStrings.FormatBalloonUpdateAvailableManual("v1.10.7", "1.10.6"));
        Assert.False(string.IsNullOrWhiteSpace(AgentStrings.ConnectionTestTimeoutMessage));
        Assert.False(string.IsNullOrWhiteSpace(AgentStrings.FormatPortableUpdateNotice("v1.10.7", "1.10.6")));

        // 6. Wave 5 P1-1: HttpSyncClient.TestConnectionAsync propagates OperationCanceledException on caller cancellation/timeout
        using var slowHandler = new StubHttpHandler(async _ =>
        {
            await Task.Delay(TimeSpan.FromSeconds(10));
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        using var slowHttp = new HttpClient(slowHandler);
        var syncClient = new HttpSyncClient(slowHttp);
        using var callerCts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => syncClient.TestConnectionAsync(
            "https://vrcx-cloud.example.workers.dev",
            "secret",
            "dev-1",
            "",
            proxyEnabled: false,
            proxyAddress: "",
            callerCts.Token));

        // 7. Wave 5 P2-3: Duplicate Entering Room for current world does not poison next nameless Joining
        var parser2 = new VrcLogParser();
        Assert.Null(parser2.ParseLine("2026.11.25 11:00:00 Log        -  [Behaviour] Entering Room: Alpha"));
        var aEv = parser2.ParseLine("2026.11.25 11:00:01 Log        -  [Behaviour] Joining wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1");
        Assert.Equal("Alpha", aEv!.WorldName);
        Assert.Null(parser2.ParseLine("2026.11.25 11:00:02 Log        -  [Behaviour] Entering Room: Alpha"));
        Assert.Null(parser2.ParseLine("2026.11.25 11:00:05 Log        -  [Behaviour] Joining wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:2"));
        Assert.Equal(string.Empty, parser2.CurrentWorldName);
        var bEv = parser2.FlushPendingLocation();
        Assert.Equal(string.Empty, bEv!.WorldName);
    }

    [Fact]
    public async Task Wave6_ConvergenceFixes_SkipFailedShots_LeftRoomSever_Ipv6Host_Strings_PngAndLfs_Timeout()
    {
        // 1. P1-1: ScanUnsyncedScreenshots skips permanently failed normalized paths so older photos are never starved
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-w6-skip-" + Guid.NewGuid().ToString("N"));
        string photosDir = Path.Combine(tempRoot, "photos");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(photosDir);
        Directory.CreateDirectory(stateDir);
        try
        {
            string badNew = Path.Combine(photosDir, "VRChat_2026-11-25_12-00-00.000_1920x1080.png");
            string okOld = Path.Combine(photosDir, "VRChat_2026-11-20_12-00-00.000_1920x1080.png");
            using (var img = new Image<Rgba32>(16, 16, new Rgba32(10, 20, 30, 255)))
            {
                img.SaveAsPng(badNew);
                img.SaveAsPng(okOld);
            }
            var cfg = new AgentConfig { AutoUploadScreenshots = true };
            using var http = new HttpClient(new StubHttpHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK))));
            var pipeline = new ScreenshotPipeline(() => cfg, http, stateDir);
            var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                ScreenshotPipeline.NormalizeScreenshotPath(badNew)
            };
            List<PendingScreenshotTask> scanned = pipeline.ScanUnsyncedScreenshots(photosDir, maxResults: 1, skipNormalizedPaths: skip);
            Assert.Single(scanned);
            Assert.Equal(okOld, scanned[0].LocalPath);

            // 5. P2-7: PNGHelper.DeleteTextChunk removes ALL duplicate Description chunks
            using (var png = new VRCX.PNGFile(okOld, writeAccess: true))
            {
                Assert.True(png.WriteChunk(VRCX.PNGHelper.GenerateTextChunk("Description", "{\"v\":1}")));
                Assert.True(png.WriteChunk(VRCX.PNGHelper.GenerateTextChunk("Description", "{\"v\":2}")));
            }
            using (var png = new VRCX.PNGFile(okOld, writeAccess: true))
            {
                Assert.True(VRCX.PNGHelper.DeleteTextChunk("Description", png));
                Assert.Null(VRCX.PNGHelper.ReadTextChunk("Description", png));
            }
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }

        // 2. P2-5: OnLeftRoom severs pending nameless Joining so a later Entering Room cannot bind to the old room
        var parser = new VrcLogParser();
        Assert.Null(parser.ParseLine("2026.11.25 12:00:00 Log        -  [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:100"));
        var leftFlushed = parser.ParseLine("2026.11.25 12:00:02 Log        -  [Behaviour] OnLeftRoom");
        Assert.NotNull(leftFlushed);
        Assert.Equal("wrld_11111111-1111-1111-1111-111111111111:100", leftFlushed!.Location);
        Assert.Null(parser.ParseLine("2026.11.25 12:00:03 Log        -  [Behaviour] Entering Room: New Next World"));
        var nextEv = parser.ParseLine("2026.11.25 12:00:04 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:200");
        Assert.NotNull(nextEv);
        Assert.Equal("New Next World", nextEv!.WorldName);
        Assert.Equal("wrld_22222222-2222-2222-2222-222222222222:200", nextEv.Location);

        // Quick rejoin to the same world within 10s after OnLeftRoom preserves WorldName
        Assert.Null(parser.ParseLine("2026.11.25 12:00:05 Log        -  [Behaviour] OnLeftRoom"));
        Assert.Equal(string.Empty, parser.CurrentWorldName);
        Assert.Null(parser.ParseLine("2026.11.25 12:00:06 Log        -  [Behaviour] Entering Room: New Next World"));
        var rejoinEv = parser.ParseLine("2026.11.25 12:00:07 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:300");
        Assert.NotNull(rejoinEv);
        Assert.Equal("New Next World", rejoinEv!.WorldName);

        // 3. P2-6: VmessConfig strips IPv6 brackets in Server, brackets bare IPv6 literals for HTTP/WS Host headers,
        // and leaves valid hostname:port / ipv4:port values untouched
        string uuid = "de305d54-75b4-431b-adb2-eb6b9e546014";
        string ipv6Json = $"{{\"v\":\"2\",\"add\":\"[2001:db8::1]\",\"port\":443,\"id\":\"{uuid}\",\"aid\":0,\"scy\":\"auto\",\"net\":\"ws\",\"tls\":\"tls\"}}";
        string ipv6Link = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(ipv6Json));
        Assert.True(VmessConfig.TryParse(ipv6Link, out VmessConfig? ipv6Cfg, out _));
        Assert.Equal("2001:db8::1", ipv6Cfg!.Server);
        Assert.Equal("[2001:db8::1]", ipv6Cfg.EffectiveHttpHeaderHost);
        Assert.Equal("[2001:db8::2]", VmessConfig.FormatHostForHttpHeader("2001:db8::2"));
        Assert.Equal("cdn.example.com:8443", VmessConfig.FormatHostForHttpHeader("cdn.example.com:8443"));
        Assert.Equal("1.2.3.4:8080", VmessConfig.FormatHostForHttpHeader("1.2.3.4:8080"));

        // 4. P2-1: English non-WinForms balloon/dialog auto-update strings use single '&' instead of doubled '&&'
        string? prevLang = AgentStrings.LanguageOverride;
        try
        {
            AgentStrings.LanguageOverride = "en-US";
            Assert.DoesNotContain("&&", AgentStrings.FormatBalloonAutoInstallingUpdate("v1.10.7"));
            Assert.DoesNotContain("&&", AgentStrings.FormatDialogAutoDownloadingUpdate("v1.10.7"));
        }
        finally
        {
            AgentStrings.LanguageOverride = prevLang;
        }

        // 6. P2-4: HttpSyncClient.TestConnectionAsync returns localized timeout message on internal HttpClient/connect timeout
        using var timeoutHandler = new StubHttpHandler(_ => Task.FromException<HttpResponseMessage>(new TaskCanceledException("Simulated SocketsHttpHandler timeout")));
        using var timeoutHttp = new HttpClient(timeoutHandler);
        var syncClient = new HttpSyncClient(timeoutHttp);
        var (ok, message, _) = await syncClient.TestConnectionAsync(
            "https://vrcx-cloud.example.workers.dev",
            "secret",
            "dev-1",
            "",
            proxyEnabled: false,
            proxyAddress: "",
            CancellationToken.None);
        Assert.False(ok);
        Assert.Equal(AgentStrings.ConnectionTestTimeoutMessage, message);
    }

    [Fact]
    public async Task Wave7Fixes_CoverSocks5hNormalizationProbeOnlyQuitResetPendingJoiningRecoveryAndSingleCacheScope()
    {
        // 1. Agent P1-1: socks5h:// normalizes to socks5:// inside SocketsHttpHandler WebProxy
        using (var handler = ProxyHttpClientFactory.CreateHandler(proxyEnabled: true, proxyAddress: "socks5h://127.0.0.1:7891"))
        {
            var webProxy = Assert.IsType<WebProxy>(handler.Proxy);
            Assert.NotNull(webProxy.Address);
            Assert.Equal("socks5", webProxy.Address!.Scheme);
            Assert.Equal("127.0.0.1", webProxy.Address.Host);
            Assert.Equal(7891, webProxy.Address.Port);
        }

        // 2. Agent P1-2: TestConnectionAsync sends probeOnly=true so server does not claim pending commands
        string? capturedProbeBody = null;
        using (var probeHandler = new StubHttpHandler(async req =>
        {
            capturedProbeBody = req.Content != null ? await req.Content.ReadAsStringAsync() : null;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"ok\":true,\"data\":{\"deviceId\":\"dev-w7\",\"deviceName\":\"W7PC\",\"syncIntervalSeconds\":60,\"pendingCommands\":[]}}",
                    Encoding.UTF8,
                    "application/json")
            };
        }))
        using (var probeHttp = new HttpClient(probeHandler))
        {
            var syncClient = new HttpSyncClient(probeHttp);
            var (ok, _, _) = await syncClient.TestConnectionAsync(
                "https://vrcx-cloud.example.workers.dev",
                "vrcx_sync_w7",
                "dev-w7",
                "W7PC",
                proxyEnabled: false,
                proxyAddress: "",
                CancellationToken.None);
            Assert.True(ok);
            Assert.NotNull(capturedProbeBody);
            Assert.Contains("\"probeOnly\":true", capturedProbeBody);
        }

        // 3. Agent P2-1: VrcLogParser recognizes HandleApplicationQuit and clears room/player state
        var parser = new VrcLogParser();
        Assert.Null(parser.ParseLine("2026.11.25 13:00:00 Log        -  [Behaviour] Entering Room: Quit Test World"));
        var joinLoc = parser.ParseLine("2026.11.25 13:00:01 Log        -  [Behaviour] Joining wrld_33333333-3333-3333-3333-333333333333:300");
        Assert.NotNull(joinLoc);
        Assert.NotNull(parser.ParseLine("2026.11.25 13:00:02 Log        -  [Behaviour] OnPlayerJoined Alice (usr_11111111-1111-1111-1111-111111111111)"));
        Assert.Equal(1, parser.CurrentPlayerCount);
        var quitEv = parser.ParseLine("2026.11.25 13:00:05 Log        -  VRCApplication: HandleApplicationQuit");
        Assert.NotNull(quitEv);
        Assert.Equal("VRChat closed gracefully", quitEv!.Data);
        Assert.Equal(0, parser.CurrentPlayerCount);
        Assert.Equal(string.Empty, parser.CurrentLocation);
        Assert.Equal(string.Empty, parser.CurrentWorldId);
        Assert.Equal(string.Empty, parser.CurrentWorldName);

        // 4. Agent P2-2: Trailing standalone Joining line does not advance persisted cursor past itself; restart recovers it
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-w7-pending-join-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);
        try
        {
            string logFile = Path.Combine(logDir, "output_log_2026-11-25_13-10-00.txt");
            await File.WriteAllTextAsync(
                logFile,
                "2026.11.25 13:10:01 Log        -  [Behaviour] Joining wrld_44444444-4444-4444-4444-444444444444:400\n",
                Encoding.UTF8);

            long fileLen = new FileInfo(logFile).Length;
            var collector1 = new LogTailCollector(stateDir);
            Assert.Equal(0, collector1.PollLogDirectory(logDir));
            Assert.Equal(0, collector1.OfflineQueueCount);
            // Persisted cursor MUST stay strictly before the pending Joining line (after any 3-byte UTF-8 BOM, never at EOF)
            Assert.True(collector1.SnapshotCursor().ByteOffset < fileLen);

            // Simulate agent restart and subsequent timeout flush -> Location event is recovered cleanly
            var collector2 = new LogTailCollector(stateDir)
            {
                PendingLocationFlushDelay = TimeSpan.Zero
            };
            Assert.Equal(1, collector2.PollLogDirectory(logDir));
            var recovered = collector2.PeekBatch(10);
            Assert.Single(recovered);
            Assert.Equal("Location", recovered[0].Type);
            Assert.Equal("wrld_44444444-4444-4444-4444-444444444444:400", recovered[0].Location);
            Assert.Equal(fileLen, collector2.SnapshotCursor().ByteOffset);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }

        // 5. Cross-Layer P2-3 + Agent P1-1 + Agent P2-3: clear_cache validates scope/dot/variant, deletes security-variant SHA-256 folder, and respects config.json cache_directory
        Assert.False(CommandValidator.ValidateRemoteCommand("clear_cache", new Dictionary<string, object?> { ["scope"] = "single" }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("clear_cache", new Dictionary<string, object?> { ["scope"] = 123 }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("clear_cache", new Dictionary<string, object?> { ["scope"] = "single", ["id"] = "." }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("clear_cache", new Dictionary<string, object?> { ["scope"] = "single", ["id"] = "../escape" }).Ok);
        Assert.True(CommandValidator.ValidateRemoteCommand("clear_cache", new Dictionary<string, object?> { ["scope"] = "single", ["id"] = "file_single_target", ["variant"] = "security" }).Ok);

        string cacheRoot = Path.Combine(Path.GetTempPath(), "vrcx-w7-cache-" + Guid.NewGuid().ToString("N"));
        string keepDir = Path.Combine(cacheRoot, "KEEP_ME_DIR");
        string securityHashedDirName = CommandValidator.ComputeVrChatCacheFolderHash("file_single_target", "security");
        string targetDir = Path.Combine(cacheRoot, securityHashedDirName);
        Directory.CreateDirectory(keepDir);
        Directory.CreateDirectory(targetDir);
        try
        {
            var singleRes = CommandValidator.ClearVrChatCacheInDirectory("cmd_single_1", cacheRoot, "single", "file_single_target", "security");
            Assert.Equal("succeeded", singleRes.Status);
            Assert.False(Directory.Exists(targetDir));
            Assert.True(Directory.Exists(keepDir));

            // config.json custom cache_directory resolution
            string fakeAppData = Path.Combine(cacheRoot, "VrcAppData");
            string customBase = Path.Combine(cacheRoot, "CustomCacheBase");
            Directory.CreateDirectory(fakeAppData);
            Directory.CreateDirectory(customBase);
            await File.WriteAllTextAsync(
                Path.Combine(fakeAppData, "config.json"),
                Newtonsoft.Json.JsonConvert.SerializeObject(new { cache_directory = customBase }),
                Encoding.UTF8);
            Assert.Equal(Path.Combine(customBase, "Cache-WindowsPlayer"), CommandValidator.ResolveVrChatCacheDirectory(fakeAppData));
        }
        finally
        {
            if (Directory.Exists(cacheRoot)) Directory.Delete(cacheRoot, recursive: true);
        }

        // 6. Agent P1-2, P1-3, P2-1, P2-2: pending Joining flushes on timeout even during log noise, does NOT duplicate on file rotation,
        //    preserves pending Location before HandleApplicationQuit, and recovers cleanly on in-place file truncation
        string rotRoot = Path.Combine(Path.GetTempPath(), "vrcx-w7-rot-" + Guid.NewGuid().ToString("N"));
        string rotLogDir = Path.Combine(rotRoot, "logs");
        string rotStateDir = Path.Combine(rotRoot, "state");
        Directory.CreateDirectory(rotLogDir);
        Directory.CreateDirectory(rotStateDir);
        try
        {
            // (a) Noise lines arriving after timeout still flush pending Joining
            string noiseFile = Path.Combine(rotLogDir, "output_log_2026-11-25_14-00-00.txt");
            await File.WriteAllTextAsync(
                noiseFile,
                "2026.11.25 14:00:01 Log        -  [Behaviour] Joining wrld_55555555-5555-5555-5555-555555555555:500\n",
                new UTF8Encoding(false));
            var noiseCollector = new LogTailCollector(rotStateDir)
            {
                PendingLocationFlushDelay = TimeSpan.FromMilliseconds(20)
            };
            Assert.Equal(0, noiseCollector.PollLogDirectory(rotLogDir));
            await Task.Delay(40);
            await File.AppendAllTextAsync(
                noiseFile,
                "2026.11.25 14:00:15 Log        -  Some noisy unity debug line\n",
                new UTF8Encoding(false));
            Assert.Equal(1, noiseCollector.PollLogDirectory(rotLogDir));
            Assert.Equal(new FileInfo(noiseFile).Length, noiseCollector.SnapshotCursor().ByteOffset);

            // (b) Rotation while Joining is pending + trailing Entering Room emits strictly ONE named Location (no duplicates!)
            await File.AppendAllTextAsync(
                noiseFile,
                "2026.11.25 14:01:01 Log        -  [Behaviour] Joining wrld_66666666-6666-6666-6666-666666666666:600\n",
                new UTF8Encoding(false));
            noiseCollector.PendingLocationFlushDelay = TimeSpan.FromSeconds(30);
            Assert.Equal(0, noiseCollector.PollLogDirectory(rotLogDir));
            await File.AppendAllTextAsync(
                noiseFile,
                "2026.11.25 14:01:02 Log        -  [Behaviour] Entering Room: Rotated World\n",
                new UTF8Encoding(false));
            string nextFile = Path.Combine(rotLogDir, "output_log_2026-11-25_14-02-00.txt");
            await File.WriteAllTextAsync(
                nextFile,
                "2026.11.25 14:02:01 Log        -  [Behaviour] Joining wrld_77777777-7777-7777-7777-777777777777:700\n" +
                "2026.11.25 14:02:02 Log        -  VRCApplication: HandleApplicationQuit\n",
                new UTF8Encoding(false));
            noiseCollector.PollLogDirectory(rotLogDir);
            var allEvents = noiseCollector.PeekBatch(20);
            var rotatedMatches = allEvents.FindAll(e => e.Location == "wrld_66666666-6666-6666-6666-666666666666:600");
            Assert.Single(rotatedMatches);
            Assert.Equal("Rotated World", rotatedMatches[0].WorldName);
            // Pending Joining followed immediately by HandleApplicationQuit preserves BOTH the Location and the quit Event
            Assert.Contains(allEvents, e => e.Type == "Location" && e.Location == "wrld_77777777-7777-7777-7777-777777777777:700");
            Assert.Contains(allEvents, e => e.Type == "Event" && e.Data == "VRChat closed gracefully");
        }
        finally
        {
            if (Directory.Exists(rotRoot)) Directory.Delete(rotRoot, recursive: true);
        }
    }

    [Fact]
    public async Task Wave8_AgentFixes_SnapshotCapture_IncompletePngGuard_OvrEndpoint_ParserCompat_MonotonicGate_LogOrderAndChunkBackfill_VmessObfsAndHost_Truncate()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-w8-agent-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        string photoDir = Path.Combine(tempRoot, "photos");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);
        Directory.CreateDirectory(photoDir);

        try
        {
            // 1. CapturedRoomSnapshot preserves room & players at screenshot moment even if OnLeftRoom follows in same poll
            string snapLog = Path.Combine(logDir, "output_log_2026-11-25_15-00-00.txt");
            await File.WriteAllTextAsync(
                snapLog,
                "2026.11.25 15:00:01 Log        -  [Behaviour] Entering Room: Photo Shrine\n" +
                "2026.11.25 15:00:01 Log        -  [Behaviour] Joining wrld_88888888-8888-8888-8888-888888888888:808\n" +
                "2026.11.25 15:00:02 Log        -  [Behaviour] OnPlayerJoined Sakura (usr_1234567890)\n" +
                "2026.11.25 15:00:03 Log        -  [VRC Camera] Took screenshot to: C:\\Pictures\\VRChat\\shot_snap.png\n" +
                "2026.11.25 15:00:04 Log        -  [Behaviour] OnLeftRoom\n",
                new UTF8Encoding(false));

            var snapCollector = new LogTailCollector(stateDir);
            GameLogEventItem? capturedShotEv = null;
            snapCollector.ScreenshotCaptured += ev => capturedShotEv = ev;
            snapCollector.PollLogDirectory(logDir);
            Assert.NotNull(capturedShotEv);
            Assert.NotNull(capturedShotEv!.CapturedRoomSnapshot);
            Assert.Equal("Photo Shrine", capturedShotEv.CapturedRoomSnapshot!.CurrentWorldName);
            Assert.Equal("wrld_88888888-8888-8888-8888-888888888888", capturedShotEv.CapturedRoomSnapshot.CurrentWorldId);
            Assert.Single(capturedShotEv.CapturedRoomSnapshot.PlayersForMetadata);
            Assert.Equal("usr_1234567890", capturedShotEv.CapturedRoomSnapshot.PlayersForMetadata[0]["id"]);
            // Live state after poll reflects OnLeftRoom, proving screenshot snapshot was frozen before leaving
            Assert.Equal(string.Empty, snapCollector.SnapshotLiveRoomState().CurrentLocation);

            // 2. Partial PNG (valid PNG magic header, missing IEND footer) returns TransientFailure while recent (<30s) and is skipped by ScanUnsyncedScreenshots
            string partialPng = Path.Combine(photoDir, "VRChat_2026-11-25_15-05-00.000_1920x1080.png");
            byte[] partialBytes = new byte[128];
            new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }.CopyTo(partialBytes, 0);
            await File.WriteAllBytesAsync(partialPng, partialBytes);
            Assert.True(ScreenshotPipeline.HasValidImageMagicPrefix(partialPng, partialBytes));
            Assert.False(ScreenshotPipeline.IsImageFileComplete(partialPng, partialBytes));

            var uploadCfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "secret",
                AutoUploadScreenshots = true,
                CompressScreenshots = false
            };
            int uploadHits = 0;
            using (var http = new HttpClient(new StubHttpHandler(_ =>
            {
                Interlocked.Increment(ref uploadHits);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
            })))
            {
                var pipeline = new ScreenshotPipeline(() => uploadCfg, http);
                Assert.Empty(pipeline.ScanUnsyncedScreenshots(photoDir, maxResults: 10));
                ScreenshotUploadOutcome partialOutcome = await pipeline.UploadQueuedTaskWithOutcomeAsync(
                    new PendingScreenshotTask { LocalPath = partialPng, TakenAtIso = "2026-11-25T15:05:00Z" },
                    CancellationToken.None);
                Assert.Equal(ScreenshotUploadOutcome.TransientFailure, partialOutcome);
                Assert.Equal(0, uploadHits);
            }

            // 3. VrNotificationSender default OVRToolkit endpoint includes /api, strips HTTPS URL icons, and sends body-only wrist payload
            Assert.Equal("ws://127.0.0.1:11450/api", VrNotificationSender.DefaultOvrToolkitEndpoint);
            Assert.Null(VrNotificationSender.NormalizeValidBase64Icon("https://api.vrchat.cloud/api/1/file/file_123/1/file"));
            Assert.Equal("iVBORw==", VrNotificationSender.NormalizeValidBase64Icon("data:image/png;base64,iVBORw=="));
            List<string> packets = VrNotificationSender.BuildOvrToolkitPackets("Title", "Body", hudNotification: true, wristNotification: true, iconBase64: "iVBORw==");
            Assert.Equal(2, packets.Count);
            Assert.Contains("SendNotification", packets[0]);
            Assert.Contains("iVBORw==", packets[0]);
            Assert.Contains("SendWristNotification", packets[1]);
            Assert.Contains("Title - Body", packets[1]);
            Assert.DoesNotContain("iVBORw==", packets[1]);
            List<string> urlIconPackets = VrNotificationSender.BuildOvrToolkitPackets("Title", "Body", hudNotification: true, wristNotification: false, iconBase64: "https://api.vrchat.cloud/api/1/file/file_123/1/file");
            Assert.DoesNotContain("https://api.vrchat.cloud", urlIconPackets[0]);

            // 3b. Read-only attribute PNG uploads cleanly via read-only WaitForFileReadyAsync
            string roPng = Path.Combine(photoDir, "VRChat_2026-11-25_15-06-00.000_1920x1080.png");
            using (var img = new Image<Rgba32>(8, 8, new Rgba32(100, 120, 140, 255)))
            {
                img.SaveAsPng(roPng);
            }
            File.SetAttributes(roPng, File.GetAttributes(roPng) | FileAttributes.ReadOnly);
            try
            {
                int roUploads = 0;
                using var roHttp = new HttpClient(new StubHttpHandler(_ =>
                {
                    Interlocked.Increment(ref roUploads);
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
                }));
                var roPipeline = new ScreenshotPipeline(() => uploadCfg, roHttp);
                var roOutcome = await roPipeline.UploadQueuedTaskWithOutcomeAsync(
                    new PendingScreenshotTask { LocalPath = roPng, TakenAtIso = "2026-11-25T15:06:00Z" },
                    CancellationToken.None);
                Assert.Equal(ScreenshotUploadOutcome.Uploaded, roOutcome);
                Assert.Equal(1, roUploads);
            }
            finally
            {
                File.SetAttributes(roPng, File.GetAttributes(roPng) & ~FileAttributes.ReadOnly);
            }

            // 4. VrcLogParser supports legacy wld_ world prefix, 10-char usr_ IDs, AVPro Resolving URL, and real VRChat Portal format
            var parser = new VrcLogParser();
            var legacyJoin = parser.ParseLine("2026.11.25 15:10:00 Log        -  [Behaviour] Joining wld_11111111-1111-1111-1111-111111111111:123");
            Assert.Null(legacyJoin); // waits for Entering Room
            var legacyEnter = parser.ParseLine("2026.11.25 15:10:01 Log        -  [Behaviour] Entering Room: Legacy World");
            Assert.NotNull(legacyEnter);
            Assert.Equal("wld_11111111-1111-1111-1111-111111111111", legacyEnter!.WorldId);

            var legacyPlayer = parser.ParseLine("2026.11.25 15:10:02 Log        -  [Behaviour] OnPlayerJoined LegacyUser (usr_1a2b3c4d5e)");
            Assert.NotNull(legacyPlayer);
            Assert.Equal("usr_1a2b3c4d5e", legacyPlayer!.UserId);

            var avproEv = parser.ParseLine("2026.11.25 15:10:03 Log        -  [Video Playback] Resolving URL 'rtmp://stream.example.com/live/vr'");
            Assert.NotNull(avproEv);
            Assert.Equal("VideoPlay", avproEv!.Type);
            Assert.Equal("rtmp://stream.example.com/live/vr", avproEv.VideoUrl);

            var portalEv = parser.ParseLine("2026.11.25 15:10:04 Log        -  [Behaviour] Instantiated a (Clone [42] Portals/PortalInternalDynamic)");
            Assert.NotNull(portalEv);
            Assert.Equal("PortalSpawn", portalEv!.Type);

            // 5. SyncScheduleGate monotonic clock resists system wall-clock rollbacks
            var gate = new SyncScheduleGate(60);
            DateTimeOffset t0 = new(2026, 11, 25, 15, 0, 0, TimeSpan.Zero);
            gate.ApplyServerSchedule(new AgentSyncResponse { SyncIntervalSeconds = 120 }, t0, nowMonoMs: 1_000_000);
            Assert.False(gate.IsDueMonotonic(1_060_000));
            Assert.True(gate.IsDueMonotonic(1_120_000));

            // 6. LogTailCollector sorts by filename timestamp (ignoring stale mtime on older file) and chunks large historical logs (>1000 events)
            string chunkDir = Path.Combine(tempRoot, "chunk-logs");
            string chunkState = Path.Combine(tempRoot, "chunk-state");
            Directory.CreateDirectory(chunkDir);
            Directory.CreateDirectory(chunkState);
            string olderLog = Path.Combine(chunkDir, "output_log_2026-11-25_10-00-00.txt");
            string newerLog = Path.Combine(chunkDir, "output_log_2026-11-25_16-00-00.txt");
            var sb = new StringBuilder();
            for (int i = 0; i < 1250; i++)
            {
                sb.Append("2026.11.25 10:00:01 Log        -  [Video Playback] Attempting to resolve URL 'https://example.com/v/")
                  .Append(i)
                  .AppendLine("'");
            }
            await File.WriteAllTextAsync(olderLog, sb.ToString(), new UTF8Encoding(false));
            await File.WriteAllTextAsync(
                newerLog,
                "2026.11.25 16:00:01 Log        -  [Behaviour] Entering Room: Newer Active World\n" +
                "2026.11.25 16:00:01 Log        -  [Behaviour] Joining wrld_99999999-9999-9999-9999-999999999999:909\n",
                new UTF8Encoding(false));
            // Give the OLDER filename a NEWER mtime and mix a non-timestamped fallback file to verify strict total order (no List.Sort cycle)
            string fallbackLog = Path.Combine(chunkDir, "output_log_manual_backup.txt");
            await File.WriteAllTextAsync(fallbackLog, "", new UTF8Encoding(false));
            File.SetLastWriteTimeUtc(olderLog, DateTime.UtcNow.AddMinutes(10));
            File.SetLastWriteTimeUtc(fallbackLog, DateTime.UtcNow.AddMinutes(5));
            Assert.True(LogTailCollector.CompareLogFilesChronologically(fallbackLog, olderLog) < 0);
            Assert.True(LogTailCollector.CompareLogFilesChronologically(fallbackLog, newerLog) < 0);
            Assert.True(LogTailCollector.CompareLogFilesChronologically(olderLog, newerLog) < 0);
            File.Delete(fallbackLog);

            var chunkCollector = new LogTailCollector(chunkState);
            int pass1 = chunkCollector.PollLogDirectory(chunkDir);
            // Active file MUST stay newerLog; pass 1 caps historical backfill at 1000 (+ 1 live Location = 1001)
            Assert.Equal(Path.GetFileName(newerLog), chunkCollector.SnapshotCursor().FileName);
            Assert.Equal(1001, pass1);
            int pass2 = chunkCollector.PollLogDirectory(chunkDir);
            Assert.Equal(250, pass2);
            Assert.Equal(1251, chunkCollector.OfflineQueueCount);

            // 7. VmessConfig parses Shadowrocket JSON obfsParam, computes EffectiveWsHostHeader (SNI for preferred-IP TLS), and rejects whitespace Path
            string srCore = Convert.ToBase64String(Encoding.UTF8.GetBytes("auto:11111111-1111-1111-1111-111111111111@104.16.1.1:443"));
            string obfsJson = Uri.EscapeDataString("{\"Host\":\"cdn.example.com\",\"Path\":\"/vmess-ws\"}");
            Assert.True(VmessConfig.TryParse($"vmess://{srCore}?obfs=websocket&obfsParam={obfsJson}&tls=1", out VmessConfig? srCfg, out string srErr), srErr);
            Assert.Equal("cdn.example.com", srCfg!.Host);
            Assert.Equal("/vmess-ws", srCfg.Path);
            Assert.Equal("cdn.example.com", srCfg.EffectiveWsHostHeader);

            // Preferred-IP WS+TLS node without explicit Host falls back to SNI for Host header
            string sniOnlyJson = Convert.ToBase64String(Encoding.UTF8.GetBytes(
                "{\"add\":\"104.16.1.2\",\"port\":\"443\",\"id\":\"11111111-1111-1111-1111-111111111111\",\"net\":\"ws\",\"tls\":\"tls\",\"sni\":\"edge.example.com\",\"path\":\"/ws\"}"));
            Assert.True(VmessConfig.TryParse($"vmess://{sniOnlyJson}", out VmessConfig? sniCfg, out _));
            Assert.Equal("edge.example.com", sniCfg!.EffectiveWsHostHeader);

            // Path with whitespace/control chars rejected
            string badPathJson = Convert.ToBase64String(Encoding.UTF8.GetBytes(
                "{\"add\":\"example.com\",\"port\":\"443\",\"id\":\"11111111-1111-1111-1111-111111111111\",\"net\":\"ws\",\"path\":\"/bad path\"}"));
            Assert.False(VmessConfig.TryParse($"vmess://{badPathJson}", out _, out _));

            // 8. HttpSyncClient.TruncateOversizedEvent honors custom 512-char clamp for 413 retry
            var bigEv = new GameLogEventItem { Type = "Event", CreatedAt = "2026-11-25T15:00:00Z", Data = new string('Z', 3000) };
            GameLogEventItem clamped = HttpSyncClient.TruncateOversizedEvent(bigEv, maxDataChars: 512);
            Assert.Equal(512, clamped.Data!.Length);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task Wave9_Fixes_OversizedLineNoLivelock_QueueHeadSeq_IssBom_MetadataGuard_VmessCrlf_AndUpdaterHtml()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-w9-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);
        try
        {
            // 1. Live log single line exceeding 8 MiB chunk cap advances past line without livelocking and parses subsequent events
            string liveLog = Path.Combine(logDir, "output_log_2026-11-25_18-00-00.txt");
            using (var fs = new FileStream(liveLog, FileMode.Create, FileAccess.Write, FileShare.Read))
            {
                byte[] filler = new byte[1024 * 1024];
                Array.Fill(filler, (byte)'A');
                for (int i = 0; i < 9; i++)
                {
                    await fs.WriteAsync(filler);
                }
                byte[] tailLine = Encoding.UTF8.GetBytes(
                    "\n2026.11.25 18:01:00 Log        -  [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:9090\n" +
                    "2026.11.25 18:01:01 Log        -  [Behaviour] Entering Room: Post-Oversize World\n");
                await fs.WriteAsync(tailLine);
            }
            var collector = new LogTailCollector(stateDir);
            int parsed = collector.PollLogDirectory(logDir);
            Assert.Equal(1, parsed);
            Assert.Equal("Post-Oversize World", collector.Parser.CurrentWorldName);
            Assert.True(collector.SnapshotCursor().ByteOffset > 9 * 1024 * 1024);

            // 2. Sequence-guarded AcknowledgeBatch refuses to drop newer events after 20k queue head trim
            var seqState = Path.Combine(tempRoot, "seq-state");
            var seqLogs = Path.Combine(tempRoot, "seq-logs");
            Directory.CreateDirectory(seqState);
            Directory.CreateDirectory(seqLogs);
            var seqCollector = new LogTailCollector(seqState);
            string bulkLog = Path.Combine(seqLogs, "output_log_2026-11-25_18-05-00.txt");
            var bulkSb = new StringBuilder();
            for (int i = 0; i < 20_050; i++)
            {
                bulkSb.Append("2026.11.25 18:05:00 Log        -  [Video Playback] Attempting to resolve URL 'https://example.com/q/")
                      .Append(i)
                      .AppendLine("'");
            }
            await File.WriteAllTextAsync(bulkLog, bulkSb.ToString(), new UTF8Encoding(false));
            // Seed initial small batch and capture headSeq before overflow trim
            string seedLog = Path.Combine(seqLogs, "output_log_2026-11-25_18-04-00.txt");
            await File.WriteAllTextAsync(
                seedLog,
                "2026.11.25 18:04:00 Log        -  [Video Playback] Attempting to resolve URL 'https://example.com/seed/0'\n",
                new UTF8Encoding(false));
            var seqCollector2 = new LogTailCollector(Path.Combine(tempRoot, "seq-state-2"));
            File.Delete(bulkLog);
            seqCollector2.PollLogDirectory(seqLogs);
            var (initialBatch, staleSeq) = seqCollector2.PeekBatchWithSeq(1);
            Assert.Single(initialBatch);

            // Trigger >20k queue overflow which trims old head and advances _queueHeadSeq
            await File.WriteAllTextAsync(bulkLog, bulkSb.ToString(), new UTF8Encoding(false));
            seqCollector2.PollLogDirectory(seqLogs);
            int countBeforeStaleAck = seqCollector2.OfflineQueueCount;
            Assert.Equal(20_000, countBeforeStaleAck);
            seqCollector2.AcknowledgeBatch(1, staleSeq);
            // Stale headSeq must NOT remove any surviving newer item
            Assert.Equal(countBeforeStaleAck, seqCollector2.OfflineQueueCount);

            // 3. Installer .iss carries UTF-8 BOM so Inno Setup compiles Chinese/Japanese text without mojibake
            string? dir = AppContext.BaseDirectory;
            string? issPath = null;
            for (int i = 0; i < 8 && dir != null; i++)
            {
                string candidate = Path.Combine(dir, "VRCX-Agent", "Installer", "VRCX-Agent.iss");
                if (File.Exists(candidate))
                {
                    issPath = candidate;
                    break;
                }
                dir = Directory.GetParent(dir)?.FullName;
            }
            Assert.NotNull(issPath);
            byte[] issHead = File.ReadAllBytes(issPath!)[..3];
            Assert.Equal(new byte[] { 0xEF, 0xBB, 0xBF }, issHead);

            // 4. ScreenshotPipeline: rejects non-PNG metadata write, rejects riffPayloadLen<12 WebP, and does NOT persist ledger when r2Stored=false
            string fakeJpg = Path.Combine(tempRoot, "not_a_png.jpg");
            await File.WriteAllBytesAsync(fakeJpg, new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0xFF, 0xD9 });
            Assert.False(ScreenshotPipeline.WriteVrcxPngMetadata(fakeJpg, new ScreenshotMetaPayload { WorldName = "Nope" }));

            string badWebp = Path.Combine(tempRoot, "malformed.webp");
            byte[] badWebpBytes = new byte[12];
            Encoding.ASCII.GetBytes("RIFF").CopyTo(badWebpBytes, 0);
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(badWebpBytes.AsSpan(4, 4), 4u);
            Encoding.ASCII.GetBytes("WEBP").CopyTo(badWebpBytes, 8);
            await File.WriteAllBytesAsync(badWebp, badWebpBytes);
            Assert.False(ScreenshotPipeline.IsImageFileComplete(badWebp, badWebpBytes));

            string validPng = Path.Combine(tempRoot, "VRChat_2026-11-25_18-10-00.000_64x64.png");
            using (var img = new Image<Rgba32>(16, 16, new Rgba32(10, 120, 200, 255)))
            {
                img.SaveAsPng(validPng);
            }
            var r2Cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "vrcx_sync_w9_secret",
                AutoUploadScreenshots = true,
                CompressScreenshots = false
            };
            using var r2FalseHttp = new HttpClient(new StubHttpHandler(_ => Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"ok\":true,\"data\":{\"duplicate\":false,\"r2Stored\":false}}", Encoding.UTF8, "application/json")
                })));
            var r2Pipeline = new ScreenshotPipeline(() => r2Cfg, r2FalseHttp, Path.Combine(tempRoot, "r2-state"));
            bool r2Uploaded = await r2Pipeline.UploadQueuedTaskAsync(
                new PendingScreenshotTask { LocalPath = validPng, TakenAtIso = "2026-11-25T18:10:00.000Z" },
                CancellationToken.None);
            Assert.False(r2Uploaded);
            Assert.False(r2Pipeline.HasAlreadyUploaded(validPng));

            // 5. VmessConfig: rejects CRLF/whitespace in Host/SNI/ALPN, falls back from blank peer= to sni=, accepts comma+space paths
            string crlfHostJson = Convert.ToBase64String(Encoding.UTF8.GetBytes(
                "{\"add\":\"example.com\",\"port\":\"443\",\"id\":\"11111111-1111-1111-1111-111111111111\",\"net\":\"ws\",\"host\":\"evil.com\\r\\nX-Inject: 1\",\"path\":\"/ws\"}"));
            Assert.False(VmessConfig.TryParse($"vmess://{crlfHostJson}", out _, out _));

            string srCore2 = Convert.ToBase64String(Encoding.UTF8.GetBytes("auto:11111111-1111-1111-1111-111111111111@104.16.1.1:443"));
            Assert.True(VmessConfig.TryParse($"vmess://{srCore2}?tls=1&peer=&sni=fallback-sni.example.com&obfs=websocket&path=/a,%20/b", out VmessConfig? srCfg2, out string srErr2), srErr2);
            Assert.Equal("fallback-sni.example.com", srCfg2!.Sni);
            Assert.Equal("/a", srCfg2.EffectiveWsPath);

            // 6. AgentUpdater HTML fallback extracts tag terminated by closing quote in href attribute
            using var updaterHttp = new HttpClient(new StubHttpHandler(req =>
            {
                if (req.RequestUri!.AbsoluteUri.Contains("api.github.com"))
                {
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
                }
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "<html><body><a href=\"https://github.com/nuomew/VRCX-Worker/releases/tag/v1.10.9\">v1.10.9</a></body></html>",
                        Encoding.UTF8,
                        "text/html")
                });
            }));
            var updater = new AgentUpdater(updaterHttp);
            AgentReleaseInfo rel = await updater.CheckForUpdateAsync("1.10.6", CancellationToken.None);
            Assert.True(rel.UsedFallbackRedirect);
            Assert.Equal("v1.10.9", rel.TagName);
            Assert.True(rel.IsUpdateAvailable);

            // 7. AgentConfig.Clone() isolates config snapshot from subsequent mutation; EmbedLocalMetadataOnlyAsync tolerates read-only PNG without throwing
            var origCfg = new AgentConfig { CloudUrl = "https://a.example", SyncSecret = "s1" };
            AgentConfig clonedCfg = origCfg.Clone();
            origCfg.CloudUrl = "https://b.example";
            Assert.Equal("https://a.example", clonedCfg.CloudUrl);

            string roPng2 = Path.Combine(tempRoot, "readonly_embed_guard.png");
            using (var roImg = new Image<Rgba32>(8, 8, new Rgba32(50, 60, 70, 255)))
            {
                roImg.SaveAsPng(roPng2);
            }
            File.SetAttributes(roPng2, File.GetAttributes(roPng2) | FileAttributes.ReadOnly);
            try
            {
                await r2Pipeline.EmbedLocalMetadataOnlyAsync(
                    new PendingScreenshotTask { LocalPath = roPng2, WorldName = "ReadOnlyWorld" },
                    CancellationToken.None);
            }
            finally
            {
                File.SetAttributes(roPng2, File.GetAttributes(roPng2) & ~FileAttributes.ReadOnly);
            }
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task CloudUrlNormalizationAndSyncSecretValidation_StripHashRouterAndRejectInvalidHeaders()
    {
        // 1. TryNormalizeCloudUrl strips Vue hash-router #/settings and ?query while preserving base path
        Assert.True(HttpSyncClient.TryNormalizeCloudUrl("https://vrcx.example.workers.dev/#/settings", out string norm1));
        Assert.Equal("https://vrcx.example.workers.dev", norm1);

        Assert.True(HttpSyncClient.TryNormalizeCloudUrl("https://example.com:443/vrcx/?tab=cloud#/settings", out string norm2));
        Assert.Equal("https://example.com/vrcx", norm2);

        Assert.False(HttpSyncClient.TryNormalizeCloudUrl("ftp://example.com", out _));
        Assert.False(HttpSyncClient.TryNormalizeCloudUrl("not-a-url", out _));
        // Reject embedded credentials including empty-user ':pass@' which would otherwise throw UriFormatException in UriBuilder
        Assert.False(HttpSyncClient.TryNormalizeCloudUrl("https://:pass@vrcx.example.workers.dev", out _));
        Assert.False(HttpSyncClient.TryNormalizeCloudUrl("https://user:pass@vrcx.example.workers.dev", out _));

        // Deterministic ASCII-safe DeviceId fallback without mutating caller's AgentConfig in ApplySyncAuthHeaders
        var legacyCfg = new AgentConfig { DeviceId = "设备-中文 1" };
        using var req1 = new HttpRequestMessage(HttpMethod.Post, "https://vrcx.example.workers.dev/api/agent/sync");
        using var req2 = new HttpRequestMessage(HttpMethod.Post, "https://vrcx.example.workers.dev/api/agent/sync");
        HmacSigner.ApplySyncAuthHeaders(req1, legacyCfg);
        HmacSigner.ApplySyncAuthHeaders(req2, legacyCfg);
        string h1 = Assert.Single(req1.Headers.GetValues("X-Device-Id"));
        string h2 = Assert.Single(req2.Headers.GetValues("X-Device-Id"));
        Assert.Equal(h1, h2);
        Assert.True(HmacSigner.IsValidSyncSecret(h1));
        Assert.Equal("设备-中文 1", legacyCfg.DeviceId);
        Assert.Equal(h1, legacyCfg.EnsureDeviceId());

        // 2. IsValidSyncSecret allows empty or printable ASCII without whitespace; rejects CJK, zero-width space, internal spaces, CRLF
        Assert.True(HmacSigner.IsValidSyncSecret(""));
        Assert.True(HmacSigner.IsValidSyncSecret("  vrcx_sync-Key.123!  "));
        Assert.False(HmacSigner.IsValidSyncSecret("密钥_abc"));
        Assert.False(HmacSigner.IsValidSyncSecret("abc\u200Bdef"));
        Assert.False(HmacSigner.IsValidSyncSecret("abc def"));
        Assert.False(HmacSigner.IsValidSyncSecret("abc\r\ndef"));

        // 3. TestConnectionAsync rejects non-ASCII SyncSecret BEFORE issuing HTTP calls, and sends normalized URL without #/settings
        int httpCalls = 0;
        Uri? sentUri = null;
        using var stubHttp = new HttpClient(new StubHttpHandler(req =>
        {
            httpCalls++;
            sentUri = req.RequestUri;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"ok\":true,\"data\":{\"deviceId\":\"win-1\",\"deviceName\":\"TestPC\",\"syncIntervalSeconds\":60}}",
                    Encoding.UTF8,
                    "application/json")
            });
        }));
        var client = new HttpSyncClient(stubHttp);

        var (badOk, badMsg, _) = await client.TestConnectionAsync(
            "https://vrcx.example.workers.dev/#/settings",
            "bad\u200Bsecret",
            "win-1",
            "TestPC",
            false,
            "",
            CancellationToken.None);
        Assert.False(badOk);
        Assert.Equal(AgentStrings.InvalidSyncSecretMessage, badMsg);
        Assert.Equal(0, httpCalls);

        var (goodOk, _, goodRes) = await client.TestConnectionAsync(
            "https://vrcx.example.workers.dev/#/settings",
            "valid_key_123",
            "win-1",
            "TestPC",
            false,
            "",
            CancellationToken.None);
        Assert.True(goodOk);
        Assert.NotNull(goodRes);
        Assert.Equal(1, httpCalls);
        Assert.Equal("https://vrcx.example.workers.dev/api/agent/sync", sentUri?.AbsoluteUri);
    }

    [Fact]
    public async Task DesktopLegacyMigrator_ScansReadOnlyFiltersSecretsAndStreamsSelectedCategories()
    {
        // 1. CommandValidator allows valid migration actions and rejects invalid categories/prefixes/jobIds
        Assert.True(CommandValidator.ValidateRemoteCommand("desktop_scan", null).Ok);
        Assert.True(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
        {
            ["jobId"] = "mig_1234abcd",
            ["accountPrefix"] = "usr11112222333344445555666677778888",
            ["categories"] = new[] { "memos_notes", "gamelog", "settings" }
        }).Ok);
        Assert.True(CommandValidator.ValidateRemoteCommand("desktop_migrate_cancel", new Dictionary<string, object?>
        {
            ["jobId"] = "mig_1234abcd"
        }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
        {
            ["jobId"] = "mig_1234abcd",
            ["categories"] = Array.Empty<string>()
        }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
        {
            ["jobId"] = "mig_1234abcd",
            ["categories"] = new[] { "drop_table_evil" }
        }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
        {
            ["jobId"] = "mig_1234abcd",
            ["accountPrefix"] = "../evil;DROP TABLE",
            ["categories"] = new[] { "gamelog" }
        }).Ok);

        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx_legacy_mig_test_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempRoot);
        try
        {
            string appDataDir = Path.Combine(tempRoot, "AppDataVrcx");
            string customDbDir = Path.Combine(tempRoot, "CustomStorage");
            Directory.CreateDirectory(appDataDir);
            Directory.CreateDirectory(customDbDir);
            string dbPath = Path.Combine(customDbDir, "VRCX.sqlite3");

            // Write VRCX.json pointing VRCX_DatabaseLocation to customDbDir\VRCX.sqlite3
            File.WriteAllText(
                Path.Combine(appDataDir, "VRCX.json"),
                JsonConvert.SerializeObject(new { VRCX_DatabaseLocation = dbPath }),
                Encoding.UTF8);

            // Create a realistic upstream desktop VRCX SQLite database
            const string acctPrefix = "usr11112222333344445555666677778888";
            using (var conn = new SqliteConnection($"Data Source={dbPath};Pooling=False"))
            {
                conn.Open();
                using var cmd = conn.CreateCommand();
                cmd.CommandText = $@"
CREATE TABLE memos (user_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT);
CREATE TABLE favorite_friend (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, user_id TEXT, group_name TEXT);
CREATE TABLE gamelog_location (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, location TEXT, world_id TEXT, world_name TEXT, time INTEGER, group_name TEXT);
CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE {acctPrefix}_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, display_name TEXT, note TEXT, created_at TEXT);
CREATE TABLE {acctPrefix}_feed_gps (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, user_id TEXT, display_name TEXT, location TEXT, world_name TEXT, previous_location TEXT, time INTEGER, group_name TEXT);
CREATE TABLE {acctPrefix}_friend_log_history (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number INTEGER);
INSERT INTO memos VALUES ('usr_friend_1', '2025-01-01T00:00:00Z', 'Old desktop memo');
INSERT INTO favorite_friend (created_at, user_id, group_name) VALUES ('2025-01-02T00:00:00Z', 'usr_friend_1', 'Besties');
INSERT INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES ('2025-01-03T10:00:00Z', 'wrld_old1:100', 'wrld_old1', '桜の集会所', 3600, '');
INSERT INTO configs VALUES ('VRCX_themeMode', 'midnight');
INSERT INTO configs VALUES ('VRCX_savedCredentials', 'SECRET_PASS_MUST_NEVER_LEAVE');
INSERT INTO configs VALUES ('VRCX_proxy', 'http://127.0.0.1:7890');
INSERT INTO configs VALUES ('VRCX_authToken', 'authcookie_secret_xyz');
INSERT INTO {acctPrefix}_notes (user_id, display_name, note, created_at) VALUES ('usr_friend_1', 'Sakura', 'Met in JP shrine', '2025-01-04T00:00:00Z');
INSERT INTO {acctPrefix}_feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES ('2025-01-05T08:00:00Z', 'usr_friend_1', 'Sakura', 'wrld_old1:100', '桜の集会所', '', 1200, '');
INSERT INTO {acctPrefix}_friend_log_history (created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number) VALUES ('2025-01-06T09:00:00Z', 'Friend', 'usr_friend_1', 'Sakura', '', 'Trusted User', '', 12);
";
                cmd.ExecuteNonQuery();
            }

            // 2. ResolveDesktopVrcxDatabasePath honors VRCX.json custom path
            Assert.Equal(dbPath, DesktopLegacyMigrator.ResolveDesktopVrcxDatabasePath(appDataDir));

            // 3. Read-only scan discovers shared tables, account prefix label, filters secrets in settings, and estimates DB bytes
            LegacyDesktopInventoryReport inv = DesktopLegacyMigrator.ScanDatabase(dbPath, "Win-Desktop");
            Assert.True(inv.DbFound);
            Assert.Equal("VRCX.sqlite3", inv.DbFileName);
            Assert.True(inv.DbFileBytes > 0);

            LegacyCategoryInventory? settingsCat = inv.SharedCategories.FirstOrDefault(c => c.Key == "settings");
            Assert.NotNull(settingsCat);
            Assert.Equal(1, settingsCat!.RowCount); // Only VRCX_themeMode survives secret/proxy filter
            Assert.True(settingsCat.EstimatedDbBytes >= 4096);

            LegacyAccountInventory acc = Assert.Single(inv.Accounts);
            Assert.Equal(acctPrefix, acc.Prefix);
            Assert.Equal("usr_11112222-3333-4444-5555-666677778888", acc.Label);
            Assert.Equal(1, acc.Categories.First(c => c.Key == "memos_notes").RowCount);
            Assert.Equal(1, acc.Categories.First(c => c.Key == "feed").RowCount);
            Assert.Equal(1, acc.Categories.First(c => c.Key == "friend_log").RowCount);

            // 4. RunMigrationAsync streams ONLY selected categories and never leaks sensitive config keys
            var uploadedPayloads = new List<JObject>();
            using var stubHttp = new HttpClient(new StubHttpHandler(async req =>
            {
                string body = req.Content != null ? await req.Content.ReadAsStringAsync() : "{}";
                uploadedPayloads.Add(JObject.Parse(body));
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"ok\":true,\"data\":{\"inserted\":1,\"skipped\":0,\"legacyDbBytes\":65536,\"shouldStop\":false}}",
                        Encoding.UTF8,
                        "application/json")
                };
            }));
            var syncClient = new HttpSyncClient(stubHttp);
            var cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "vrcx_sync_test_key",
                DeviceId = "dev_legacy_test"
            };

            var (completed, batchesSent, _) = await DesktopLegacyMigrator.RunMigrationAsync(
                cfg,
                dbPath,
                "mig_run_001",
                acctPrefix,
                new[] { "memos_notes", "settings" },
                syncClient,
                CancellationToken.None);

            Assert.True(completed);
            Assert.Equal(3, batchesSent); // memos + notes + configs (1 per logical table with table-level cursorUpdate)
            Assert.Contains(uploadedPayloads, p =>
                p["cursorUpdate"]?["table"]?.Value<string>() == "memos" &&
                p["cursorUpdate"]?["completed"]?.Value<bool>() == true);
            Assert.Contains(uploadedPayloads, p =>
                p["cursorUpdate"]?["table"]?.Value<string>() == "notes" &&
                p["cursorUpdate"]?["completed"]?.Value<bool>() == true);
            Assert.Contains(uploadedPayloads, p =>
                p["cursorUpdate"]?["table"]?.Value<string>() == "configs" &&
                p["cursorUpdate"]?["completed"]?.Value<bool>() == true);
            string allSentJson = string.Join("\n", uploadedPayloads.Select(p => p.ToString(Formatting.None)));
            Assert.Contains("Old desktop memo", allSentJson);
            Assert.Contains("Met in JP shrine", allSentJson);
            Assert.Contains("VRCX_themeMode", allSentJson);
            // Unselected categories and sensitive configs must NEVER leave the PC
            Assert.DoesNotContain("Besties", allSentJson);
            Assert.DoesNotContain("桜の集会所", allSentJson);
            Assert.DoesNotContain("SECRET_PASS_MUST_NEVER_LEAVE", allSentJson);
            Assert.DoesNotContain("authcookie_secret_xyz", allSentJson);
            Assert.DoesNotContain("127.0.0.1:7890", allSentJson);

            // 5. Oversized (>256 KiB) single row in configs is clamped below 180 KiB payload ceiling instead of causing HTTP 413
            using (var connBig = new SqliteConnection($"Data Source={dbPath};Pooling=False"))
            {
                connBig.Open();
                using var cmdBig = connBig.CreateCommand();
                cmdBig.CommandText = "INSERT INTO configs VALUES ('VRCX_hugeLegacyJson', $val)";
                cmdBig.Parameters.AddWithValue("$val", new string('A', 320 * 1024));
                cmdBig.ExecuteNonQuery();
            }

            int maxBatchBytes = 0;
            using var bigHttp = new HttpClient(new StubHttpHandler(async req =>
            {
                string body = req.Content != null ? await req.Content.ReadAsStringAsync() : "{}";
                maxBatchBytes = Math.Max(maxBatchBytes, Encoding.UTF8.GetByteCount(body));
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"ok\":true,\"data\":{\"inserted\":1,\"skipped\":0,\"legacyDbBytes\":65536,\"shouldStop\":false}}",
                        Encoding.UTF8,
                        "application/json")
                };
            }));
            var (completedBig, _, _) = await DesktopLegacyMigrator.RunMigrationAsync(
                cfg,
                dbPath,
                "mig_big_003",
                acctPrefix,
                new[] { "settings" },
                new HttpSyncClient(bigHttp),
                CancellationToken.None);
            Assert.True(completedBig);
            Assert.True(maxBatchBytes > 0 && maxBatchBytes <= 180 * 1024, $"Expected clamped batch <= 180 KiB, got {maxBatchBytes}");

            // 6. CommandValidator validates cloud-controlled concurrency (1..8) and rejects out-of-range values
            Assert.True(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
            {
                ["jobId"] = "mig_valid_001",
                ["categories"] = new[] { "settings" },
                ["concurrency"] = 4
            }).Ok);
            Assert.False(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
            {
                ["jobId"] = "mig_valid_001",
                ["categories"] = new[] { "settings" },
                ["concurrency"] = 0
            }).Ok);
            Assert.False(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
            {
                ["jobId"] = "mig_valid_001",
                ["categories"] = new[] { "settings" },
                ["concurrency"] = 9
            }).Ok);

            // 7. Concurrent migration (concurrency=4) packs Feed up to 1000 rows/batch, uploads in parallel, retries transient 503 once, and finalizes categoryDone after drain
            using (var connBulk = new SqliteConnection($"Data Source={dbPath};Pooling=False"))
            {
                connBulk.Open();
                using var tx = connBulk.BeginTransaction();
                using var cmdIns = connBulk.CreateCommand();
                cmdIns.CommandText = $"INSERT INTO \"{acctPrefix}_feed_gps\" (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES ($ts, $uid, 'Pal', 'wrld_x:1', 'WorldX', '', 60, '')";
                var pTs = cmdIns.Parameters.Add("$ts", SqliteType.Text);
                var pUid = cmdIns.Parameters.Add("$uid", SqliteType.Text);
                for (int i = 0; i < 2500; i++)
                {
                    int hour = i / 3600;
                    int min = (i / 60) % 60;
                    int sec = i % 60;
                    pTs.Value = $"2024-04-01T{hour:D2}:{min:D2}:{sec:D2}Z";
                    pUid.Value = $"usr_bulk_{i}";
                    cmdIns.ExecuteNonQuery();
                }
                tx.Commit();
            }

            int inFlight = 0;
            int maxInFlight = 0;
            int transientInjected = 0;
            int categoryDoneCount = 0;
            int totalConcurrentItems = 0;
            using var concHttp = new HttpClient(new StubHttpHandler(async req =>
            {
                string body = req.Content != null ? await req.Content.ReadAsStringAsync() : "{}";
                JObject jo = JObject.Parse(body);
                bool isCatDone = jo["categoryDone"]?.Value<bool>() == true;
                bool isAllDone = jo["allDone"]?.Value<bool>() == true;
                int itemCount = (jo["items"] as JArray)?.Count ?? 0;

                if (!isCatDone && !isAllDone && itemCount > 0)
                {
                    if (Interlocked.Exchange(ref transientInjected, 1) == 0)
                    {
                        return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                        {
                            Content = new StringContent("{\"ok\":false,\"error\":{\"message\":\"Temporary 503\"}}", Encoding.UTF8, "application/json")
                        };
                    }
                    int cur = Interlocked.Increment(ref inFlight);
                    int prevMax;
                    do
                    {
                        prevMax = Volatile.Read(ref maxInFlight);
                    } while (cur > prevMax && Interlocked.CompareExchange(ref maxInFlight, cur, prevMax) != prevMax);

                    await Task.Delay(60);
                    Interlocked.Add(ref totalConcurrentItems, itemCount);
                    Interlocked.Decrement(ref inFlight);
                }
                else if (isCatDone)
                {
                    Interlocked.Increment(ref categoryDoneCount);
                    Assert.Equal(0, Volatile.Read(ref inFlight)); // categoryDone must run strictly after all workers drain
                }

                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"ok\":true,\"data\":{\"inserted\":1,\"skipped\":0,\"legacyDbBytes\":65536,\"shouldStop\":false}}",
                        Encoding.UTF8,
                        "application/json")
                };
            }));

            var (completedConc, concBatches, _) = await DesktopLegacyMigrator.RunMigrationAsync(
                cfg,
                dbPath,
                "mig_conc_004",
                acctPrefix,
                new[] { "feed" },
                new HttpSyncClient(concHttp),
                CancellationToken.None,
                concurrency: 4);
            Assert.True(completedConc);
            Assert.Equal(3, concBatches); // 2501 rows packed at 1000 rows/batch = 3 batches (1000 + 1000 + 501)
            Assert.True(maxInFlight >= 2, $"Expected parallel in-flight batches >= 2, observed {maxInFlight}");
            Assert.Equal(1, categoryDoneCount);
            Assert.Equal(2501, totalConcurrentItems);

            // 8. Server shouldStop=true halts migration immediately without sending remaining categories
            int stopCalls = 0;
            using var stopHttp = new HttpClient(new StubHttpHandler(_ =>
            {
                stopCalls++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"ok\":true,\"data\":{\"inserted\":0,\"skipped\":1,\"legacyDbBytes\":504000000,\"shouldStop\":true,\"reason\":\"LEGACY_DB_QUOTA_NEAR_LIMIT\"}}",
                        Encoding.UTF8,
                        "application/json")
                });
            }));
            var (completedStop, _, _) = await DesktopLegacyMigrator.RunMigrationAsync(
                cfg,
                dbPath,
                "mig_stop_002",
                acctPrefix,
                new[] { "memos_notes", "gamelog", "feed" },
                new HttpSyncClient(stopHttp),
                CancellationToken.None);
            Assert.False(completedStop);
            Assert.Equal(1, stopCalls);

            // 9. Table-level cursor resume skips completed tables, resumes feed_gps strictly past (createdAt, rowId), and seals completed watermark
            Assert.True(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
            {
                ["jobId"] = "mig_resume_005",
                ["categories"] = new[] { "memos_notes", "feed" },
                ["cursors"] = new Dictionary<string, object?>
                {
                    ["memos"] = new Dictionary<string, object?> { ["completed"] = true, ["rowId"] = 1, ["rowsDone"] = 1 },
                    ["feed_gps"] = new Dictionary<string, object?> { ["createdAt"] = "2024-04-01T05:00Z", ["rowId"] = 300, ["completed"] = false, ["rowsDone"] = 301 }
                }
            }).Ok);
            Assert.False(CommandValidator.ValidateRemoteCommand("desktop_migrate", new Dictionary<string, object?>
            {
                ["jobId"] = "mig_resume_bad",
                ["categories"] = new[] { "feed" },
                ["cursors"] = new Dictionary<string, object?> { ["bad;DROP TABLE"] = new Dictionary<string, object?>() }
            }).Ok);

            // Look up the exact 250th newest row in feed_gps as our resume checkpoint
            string resumeTs = string.Empty;
            long resumeRowId = 0;
            using (var connCur = new SqliteConnection($"Data Source={dbPath};Mode=ReadOnly;Pooling=False"))
            {
                connCur.Open();
                using var curCmd = connCur.CreateCommand();
                curCmd.CommandText = $"SELECT rowid, created_at FROM \"{acctPrefix}_feed_gps\" ORDER BY COALESCE(created_at, '') DESC, rowid DESC LIMIT 1 OFFSET 249";
                using var rCur = curCmd.ExecuteReader();
                Assert.True(rCur.Read());
                resumeRowId = rCur.GetInt64(0);
                resumeTs = rCur.GetString(1);
            }

            var resumePayloads = new System.Collections.Concurrent.ConcurrentBag<JObject>();
            var resumedFeedItems = new System.Collections.Concurrent.ConcurrentBag<string>();
            using var resumeHttp = new HttpClient(new StubHttpHandler(async req =>
            {
                string body = req.Content != null ? await req.Content.ReadAsStringAsync() : "{}";
                JObject jo = JObject.Parse(body);
                resumePayloads.Add(jo);
                if (jo["category"]?.Value<string>() == "feed" && jo["items"] is JArray arr)
                {
                    foreach (JToken item in arr)
                    {
                        resumedFeedItems.Add(item["created_at"]?.Value<string>() ?? string.Empty);
                    }
                }
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"ok\":true,\"data\":{\"inserted\":1,\"skipped\":0,\"legacyDbBytes\":65536,\"shouldStop\":false}}",
                        Encoding.UTF8,
                        "application/json")
                };
            }));

            var resumeCursors = new Dictionary<string, LegacyTableCursor>
            {
                ["memos"] = new LegacyTableCursor { Completed = true, RowId = 1, RowsDone = 1 },
                ["feed_gps"] = new LegacyTableCursor { CreatedAt = resumeTs, RowId = resumeRowId, Completed = false, RowsDone = 250 }
            };

            var (completedResume, _, _) = await DesktopLegacyMigrator.RunMigrationAsync(
                cfg,
                dbPath,
                "mig_resume_005",
                acctPrefix,
                new[] { "memos_notes", "feed" },
                new HttpSyncClient(resumeHttp),
                CancellationToken.None,
                concurrency: 4,
                resumeCursors: resumeCursors);

            Assert.True(completedResume);
            string resumeAllJson = string.Join("\n", resumePayloads.Select(p => p.ToString(Formatting.None)));
            // Completed `memos` table must be skipped; unfinished `notes` still uploads
            Assert.DoesNotContain("Old desktop memo", resumeAllJson);
            Assert.Contains("Met in JP shrine", resumeAllJson);
            // Total feed_gps rows = 2501; resuming after the 250th newest row must upload strictly the remaining 2251 rows
            Assert.Equal(2251, resumedFeedItems.Count);
            Assert.DoesNotContain("2025-01-05T08:00:00Z", resumedFeedItems);
            // Final feed_gps cursorUpdate seals completed=true with accumulated rowsDone = 2501
            Assert.Contains(resumePayloads, p =>
                p["cursorUpdate"]?["table"]?.Value<string>() == "feed_gps" &&
                p["cursorUpdate"]?["completed"]?.Value<bool>() == true &&
                p["cursorUpdate"]?["rowsDone"]?.Value<long>() == 2501);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task CloudDataExporter_BuildsUpstreamDesktopSqliteDirectlyFromPaginatedApi()
    {
        // Verify streamlined Chinese UI labels requested by user ("导出数据" / "保存")
        string? prevLang = AgentStrings.LanguageOverride;
        try
        {
            AgentStrings.LanguageOverride = "zh-CN";
            Assert.Equal("导出数据", AgentStrings.MenuExportCloudData);
            Assert.Equal("导出数据", AgentStrings.ExportCloudDataButton);
            Assert.Equal("保存", AgentStrings.TestAndSaveButton);
        }
        finally
        {
            AgentStrings.LanguageOverride = prevLang;
        }

        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx_cloud_export_test_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempRoot);
        try
        {
            const string expectedPrefix = "usr11112222333344445555666677778888";

            // 1. Verify prefix normalization & local desktop DB read-only auto-detection fallback
            Assert.Equal(expectedPrefix, CloudDataExporter.NormalizeExportUserPrefix("usr_11112222-3333-4444-5555-666677778888"));
            string probeDbPath = Path.Combine(tempRoot, "probe_desktop.sqlite3");
            using (var probeConn = new SqliteConnection($"Data Source={probeDbPath};Pooling=False"))
            {
                probeConn.Open();
                using var probeCmd = probeConn.CreateCommand();
                probeCmd.CommandText = $"CREATE TABLE {expectedPrefix}_feed_gps (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT);";
                probeCmd.ExecuteNonQuery();
            }
            Assert.Equal(expectedPrefix, CloudDataExporter.NormalizeExportUserPrefix("", probeDbPath));

            // 2. Mock paginated /api/agent/migration/export API (active + legacy conflict + 2-page gamelog_location)
            using var stubHttp = new HttpClient(new StubHttpHandler(req =>
            {
                string query = req.RequestUri?.Query ?? string.Empty;
                string payload;
                if (query.Contains("scope=summary", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            exportedAt = "2026-11-26T02:30:00.000Z",
                            userId = "usr_11112222-3333-4444-5555-666677778888",
                            userPrefix = expectedPrefix,
                            legacyDbBound = true,
                            hasLegacyData = true,
                            totalActiveRows = 5,
                            totalLegacyRows = 2,
                            tables = new object[]
                            {
                                new { name = "configs", activeCount = 1, legacyCount = 1 },
                                new { name = "memos", activeCount = 1, legacyCount = 2 },
                                new { name = "notes", activeCount = 1, legacyCount = 0 },
                                new { name = "gamelog_location", activeCount = 2, legacyCount = 0 },
                                new { name = "feed_gps", activeCount = 1, legacyCount = 0 },
                                new { name = "notifications_v2", activeCount = 1, legacyCount = 0 }
                            }
                        }
                    });
                }
                else if (query.Contains("table=configs", StringComparison.Ordinal) && query.Contains("source=active", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "configs",
                            source = "active",
                            rows = new[] { new { key = "config:vrcx_thememode", value = "midnight" } },
                            nextAfterRowId = 1,
                            hasMore = false
                        }
                    });
                }
                else if (query.Contains("table=configs", StringComparison.Ordinal) && query.Contains("source=legacy", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "configs",
                            source = "legacy",
                            rows = new[]
                            {
                                new { key = "config:vrcx_thememode", value = "light" },
                                new { key = "config:vrcx_fontsize", value = "15" }
                            },
                            nextAfterRowId = 2,
                            hasMore = false
                        }
                    });
                }
                else if (query.Contains("table=memos", StringComparison.Ordinal) && query.Contains("source=active", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "memos",
                            source = "active",
                            rows = new[] { new { user_id = "usr_conflict", edited_at = "2026-11-26T00:00:00Z", memo = "Cloud Winner" } },
                            nextAfterRowId = 1,
                            hasMore = false
                        }
                    });
                }
                else if (query.Contains("table=memos", StringComparison.Ordinal) && query.Contains("source=legacy", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "memos",
                            source = "legacy",
                            rows = new[]
                            {
                                new { user_id = "usr_conflict", edited_at = "2024-01-01T00:00:00Z", memo = "Old Loser" },
                                new { user_id = "usr_old_only", edited_at = "2024-01-02T00:00:00Z", memo = "Legacy Only" }
                            },
                            nextAfterRowId = 2,
                            hasMore = false
                        }
                    });
                }
                else if (query.Contains("table=notes", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "notes",
                            source = "active",
                            rows = new[] { new { user_id = "usr_old_only", display_name = "Sakura", note = "Met at JP Shrine", created_at = "2026-11-25T00:00:00Z" } },
                            nextAfterRowId = 1,
                            hasMore = false
                        }
                    });
                }
                else if (query.Contains("table=gamelog_location", StringComparison.Ordinal) && query.Contains("afterRowId=0", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "gamelog_location",
                            source = "active",
                            rows = new[]
                            {
                                new { created_at = "2026-11-25T10:00:00Z", location = "wrld_jp1:100", world_id = "wrld_jp1", world_name = "桜の神社", time = 1800, group_name = "" }
                            },
                            nextAfterRowId = 11,
                            hasMore = true
                        }
                    });
                }
                else if (query.Contains("table=gamelog_location", StringComparison.Ordinal) && query.Contains("afterRowId=11", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "gamelog_location",
                            source = "active",
                            rows = new[]
                            {
                                new { created_at = "2026-11-25T11:00:00Z", location = "wrld_jp2:200", world_id = "wrld_jp2", world_name = "月見茶屋", time = 900, group_name = "" }
                            },
                            nextAfterRowId = 22,
                            hasMore = false
                        }
                    });
                }
                else if (query.Contains("table=feed_gps", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "feed_gps",
                            source = "active",
                            rows = new[]
                            {
                                new { created_at = "2026-11-25T10:05:00Z", user_id = "usr_old_only", display_name = "Sakura", location = "wrld_jp1:100", world_name = "桜の神社", previous_location = "", time = 600, group_name = "" }
                            },
                            nextAfterRowId = 1,
                            hasMore = false
                        }
                    });
                }
                else if (query.Contains("table=notifications_v2", StringComparison.Ordinal))
                {
                    payload = JsonConvert.SerializeObject(new
                    {
                        ok = true,
                        data = new
                        {
                            table = "notifications_v2",
                            source = "active",
                            rows = new[]
                            {
                                new
                                {
                                    id = "not_v2_exp_1",
                                    created_at = "2026-11-25T12:00:00Z",
                                    updated_at = "2026-11-25T12:00:00Z",
                                    expires_at = "2026-12-25T12:00:00Z",
                                    type = "boop",
                                    link = "",
                                    link_text = "",
                                    message = "Boop!",
                                    title = "",
                                    image_url = "",
                                    seen = 1,
                                    sender_user_id = "usr_old_only",
                                    sender_username = "Sakura",
                                    data = "{}",
                                    responses = "[]",
                                    details = "{}"
                                }
                            },
                            nextAfterRowId = 1,
                            hasMore = false
                        }
                    });
                }
                else
                {
                    payload = "{\"ok\":true,\"data\":{\"rows\":[],\"nextAfterRowId\":0,\"hasMore\":false}}";
                }

                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(payload, Encoding.UTF8, "application/json")
                });
            }));

            var syncClient = new HttpSyncClient(stubHttp);
            var cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "vrcx_sync_export_key",
                DeviceId = "dev_export_test"
            };
            string outSqlitePath = Path.Combine(tempRoot, "VRCX.sqlite3");

            CloudExportResult result = await CloudDataExporter.ExportToSqliteAsync(
                cfg,
                syncClient,
                outSqlitePath,
                includeLegacy: true,
                ct: CancellationToken.None);

            Assert.True(File.Exists(outSqlitePath));
            Assert.False(File.Exists(outSqlitePath + ".part"));
            Assert.True(result.FileBytes > 0);
            Assert.Equal(outSqlitePath, result.OutputSqlitePath);
            Assert.Equal(expectedPrefix, result.UserPrefix);
            Assert.Equal(9, result.TotalRows); // 2 configs + 2 memos + 1 note + 2 locations + 1 feed_gps + 1 noty_v2

            // 3. Open generated VRCX.sqlite3 directly with Microsoft.Data.Sqlite (no ZIP wrapper)
            using (var conn = new SqliteConnection($"Data Source={outSqlitePath};Mode=ReadOnly;Pooling=False"))
            {
                conn.Open();

                // configs: active midnight wins over legacy light; legacy fontsize preserved
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = "SELECT `value` FROM configs WHERE `key` = 'config:vrcx_thememode'";
                    Assert.Equal("midnight", cmd.ExecuteScalar()?.ToString());
                }
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = "SELECT `value` FROM configs WHERE `key` = 'config:vrcx_fontsize'";
                    Assert.Equal("15", cmd.ExecuteScalar()?.ToString());
                }

                // memos: active Cloud Winner overrides legacy Old Loser; Legacy Only kept
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = "SELECT memo FROM memos WHERE user_id = 'usr_conflict'";
                    Assert.Equal("Cloud Winner", cmd.ExecuteScalar()?.ToString());
                }
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = "SELECT memo FROM memos WHERE user_id = 'usr_old_only'";
                    Assert.Equal("Legacy Only", cmd.ExecuteScalar()?.ToString());
                }

                // gamelog_location: both paginated CJK worlds present
                var worlds = new List<string>();
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = "SELECT world_name FROM gamelog_location ORDER BY created_at ASC";
                    using SqliteDataReader r = cmd.ExecuteReader();
                    while (r.Read()) worlds.Add(r.GetString(0));
                }
                Assert.Equal(new[] { "桜の神社", "月見茶屋" }, worlds);

                // Account-prefixed upstream tables created & populated
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = $"SELECT note FROM {expectedPrefix}_notes WHERE user_id = 'usr_old_only'";
                    Assert.Equal("Met at JP Shrine", cmd.ExecuteScalar()?.ToString());
                }
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = $"SELECT world_name FROM {expectedPrefix}_feed_gps WHERE user_id = 'usr_old_only'";
                    Assert.Equal("桜の神社", cmd.ExecuteScalar()?.ToString());
                }
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = $"SELECT message FROM {expectedPrefix}_notifications_v2 WHERE id = 'not_v2_exp_1'";
                    Assert.Equal("Boop!", cmd.ExecuteScalar()?.ToString());
                }
            }
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task OscProtocol_And_Bridge_ValidateCommandsEncodeDecodeAndRelayLoopback()
    {
        // 1. OSC 1.0 /chatbox/input encode + decode roundtrip with UTF-8 CJK + emoji and 4-byte alignment
        byte[] inputPacket = OscProtocol.BuildChatboxInputPacket("你好 VRChat 😀", immediate: true, playSfx: false);
        Assert.Equal(0, inputPacket.Length % 4);
        Assert.True(OscProtocol.TryExtractChatboxInput(inputPacket, out string decodedText, out bool immediate, out bool playSfx));
        Assert.Equal("你好 VRChat 😀", decodedText);
        Assert.True(immediate);
        Assert.False(playSfx);

        // 2. OSC /chatbox/typing encode + decode roundtrip
        byte[] typingPacket = OscProtocol.BuildChatboxTypingPacket(true);
        Assert.Equal(0, typingPacket.Length % 4);
        Assert.True(OscProtocol.TryParseMessage(typingPacket, out ParsedOscMessage? parsedTyping));
        Assert.Equal("/chatbox/typing", parsedTyping!.Address);
        Assert.Equal(",T", parsedTyping.TypeTags);
        Assert.Single(parsedTyping.Arguments);
        Assert.Equal(true, parsedTyping.Arguments[0]);

        // 3. VRChat 144-rune and 9-line sanitization
        string longEmoji = string.Concat(Enumerable.Repeat("🌸", 160));
        string sanitizedEmoji = OscProtocol.SanitizeChatboxMessage(longEmoji);
        Assert.Equal(144, sanitizedEmoji.EnumerateRunes().Count());

        string twelveLines = string.Join("\n", Enumerable.Range(1, 12).Select(i => $"Line{i}"));
        string sanitizedLines = OscProtocol.SanitizeChatboxMessage(twelveLines);
        Assert.Equal(9, sanitizedLines.Split('\n').Length);

        // 4. CommandValidator allowlist & anti-SSRF host rejection for OSC actions
        Assert.True(CommandValidator.ValidateRemoteCommand("send_osc_chatbox", new Dictionary<string, object?>
        {
            ["message"] = "Hello VRChat",
            ["immediate"] = true,
            ["playSfx"] = true,
            ["oscPort"] = 9000
        }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("send_osc_chatbox", new Dictionary<string, object?>
        {
            ["message"] = "Hello",
            ["oscHost"] = "169.254.169.254"
        }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("send_osc_chatbox", new Dictionary<string, object?>
        {
            ["message"] = "   "
        }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("send_osc_chatbox", new Dictionary<string, object?>
        {
            ["message"] = "Hello",
            ["oscPort"] = 80
        }).Ok);
        Assert.True(CommandValidator.ValidateRemoteCommand("send_osc_typing", new Dictionary<string, object?>
        {
            ["typing"] = true,
            ["oscPort"] = 9000
        }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("send_osc_typing", new Dictionary<string, object?>
        {
            ["typing"] = "yes"
        }).Ok);

        // 5. OscChatBridge rejects self-loop configuration and relays loopback packets cleanly
        using var bridge = new OscChatBridge();
        Assert.False(bridge.Reconfigure(enabled: true, listenPort: 9000, forwardSendPort: 9000, forwardToVrchat: true));

        using var receiver = new System.Net.Sockets.UdpClient(new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, 0));
        int targetPort = ((System.Net.IPEndPoint)receiver.Client.LocalEndPoint!).Port;
        using var probeSocket = new System.Net.Sockets.UdpClient(new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, 0));
        int relayPort = ((System.Net.IPEndPoint)probeSocket.Client.LocalEndPoint!).Port;
        probeSocket.Dispose();

        Assert.True(bridge.Reconfigure(enabled: true, listenPort: relayPort, forwardSendPort: targetPort, forwardToVrchat: true));
        var (sentOk, _) = await OscProtocol.SendChatboxInputAsync("Relay test 消息", immediate: true, playSfx: true, port: relayPort);
        Assert.True(sentOk);

        using var recvCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var forwarded = await receiver.ReceiveAsync(recvCts.Token);
        Assert.True(OscProtocol.TryExtractChatboxInput(forwarded.Buffer, out string fwdText, out bool fwdImm, out bool fwdSfx));
        Assert.Equal("Relay test 消息", fwdText);
        Assert.True(fwdImm);
        Assert.True(fwdSfx);

        List<OscChatMessageUpload> buffered = bridge.PeekBatch(10);
        Assert.Single(buffered);
        Assert.Equal("Relay test 消息", buffered[0].SourceText);
        bridge.AcknowledgeBatch(1);
        Assert.Equal(0, bridge.PendingCount);

        // 6. HttpSyncClient.SyncChatOscAsync posts messages + oscState and parses pendingCommands
        string? capturedBody = null;
        using var stubHttp = new HttpClient(new StubHttpHandler(async req =>
        {
            Assert.Equal("/api/agent/chat/sync", req.RequestUri!.AbsolutePath);
            capturedBody = await req.Content!.ReadAsStringAsync();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"ok\":true,\"data\":{\"deviceId\":\"win-1\",\"syncedAt\":\"2026-11-26T10:00:00Z\",\"ingested\":1,\"chatSessionActive\":true,\"pendingCommands\":[{\"cmdId\":\"cmd_osc_1\",\"action\":\"send_osc_chatbox\",\"params\":{\"message\":\"Hi\"}}]}}",
                    Encoding.UTF8,
                    "application/json")
            };
        }));
        var syncClient = new HttpSyncClient(stubHttp);
        var cfg = new AgentConfig
        {
            CloudUrl = "https://vrcx.example.workers.dev",
            SyncSecret = "vrcx_sync_test_secret",
            OscChatSyncEnabled = true,
            OscSendPort = 9000,
            OscListenEnabled = true,
            OscListenPort = 9002
        };
        AgentChatSyncResponse chatResp = await syncClient.SyncChatOscAsync(
            cfg,
            new[] { new OscChatMessageUpload { Id = "osc_1", SourceText = "Hi", SentText = "Hi" } },
            vrcRunning: true,
            CancellationToken.None);
        Assert.True(chatResp.ChatSessionActive);
        Assert.Single(chatResp.PendingCommands);
        Assert.Equal("send_osc_chatbox", chatResp.PendingCommands[0].Action);
        Assert.Contains("\"oscState\"", capturedBody);

        // 7. OscChatRealtimeClient URI builder & strict OSC-only isolation (never executes sync_now / log / screenshot actions)
        Assert.True(OscChatRealtimeClient.TryBuildChatAgentWebSocketUri("https://vrcx.example.workers.dev/#/tools/chat-translator", out Uri? wssUri));
        Assert.Equal("wss://vrcx.example.workers.dev/ws/chat-agent", wssUri!.AbsoluteUri);
        Assert.True(OscChatRealtimeClient.TryBuildChatAgentWebSocketUri("http://127.0.0.1:8787/", out Uri? wsUri));
        Assert.Equal("ws://127.0.0.1:8787/ws/chat-agent", wsUri!.AbsoluteUri);

        string? receivedChatMsg = null;
        int receivedPort = 0;
        bool? receivedTyping = null;
        using var rtBridge = new OscChatBridge();
        using var rtClient = new OscChatRealtimeClient(
            () => cfg,
            () => stubHttp,
            () => true,
            () => true,
            rtBridge,
            (msg, imm, sfx, port, _) =>
            {
                receivedChatMsg = msg;
                receivedPort = port;
                return Task.FromResult((true, "ok"));
            },
            (typing, port, _) =>
            {
                receivedTyping = typing;
                receivedPort = port;
                return Task.FromResult((true, "ok"));
            });

        // Must reject sync_now / launch_vrc / clear_cache on isolated OSC chat channel
        Assert.False((await rtClient.ExecuteOscOnlyActionAsync("sync_now", new Dictionary<string, object?>(), CancellationToken.None)).Ok);
        Assert.False((await rtClient.ExecuteOscOnlyActionAsync("launch_vrc", new Dictionary<string, object?>(), CancellationToken.None)).Ok);
        Assert.False((await rtClient.ExecuteOscOnlyActionAsync("clear_cache", new Dictionary<string, object?>(), CancellationToken.None)).Ok);

        // Must dispatch valid chat.osc_send frames immediately to loopback OSC
        await rtClient.HandleInboundEnvelopeAsync(
            null,
            "{\"type\":\"chat.osc_send\",\"id\":\"osc_1\",\"payload\":{\"cmdId\":\"osc_1\",\"chatMsgId\":\"chat_1\",\"action\":\"send_osc_chatbox\",\"params\":{\"message\":\"即时到游戏\",\"immediate\":true,\"playSfx\":true,\"oscPort\":9005}}}",
            CancellationToken.None);
        Assert.Equal("即时到游戏", receivedChatMsg);
        Assert.Equal(9005, receivedPort);

        await rtClient.HandleInboundEnvelopeAsync(
            null,
            "{\"type\":\"chat.osc_send\",\"id\":\"osc_2\",\"payload\":{\"cmdId\":\"osc_2\",\"action\":\"send_osc_typing\",\"params\":{\"typing\":true,\"oscPort\":9000}}}",
            CancellationToken.None);
        Assert.Equal(true, receivedTyping);
        Assert.Equal(9000, receivedPort);

        // 8. Cloud-pushed `chat.osc_config` dynamically reconfigures local OscChatBridge with zero local settings
        using var dynamicProbe = new System.Net.Sockets.UdpClient(new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, 0));
        int dynamicListenPort = ((System.Net.IPEndPoint)dynamicProbe.Client.LocalEndPoint!).Port;
        dynamicProbe.Dispose();

        await rtClient.HandleInboundEnvelopeAsync(
            null,
            $"{{\"type\":\"chat.osc_config\",\"payload\":{{\"enabled\":true,\"sendPort\":{targetPort},\"listenEnabled\":true,\"listenPort\":{dynamicListenPort},\"forwardToVrchat\":true}}}}",
            CancellationToken.None);
        CloudOscRuntimeConfig applied = rtClient.GetRuntimeConfigSnapshot();
        Assert.True(applied.Enabled);
        Assert.True(applied.ListenEnabled);
        Assert.Equal(dynamicListenPort, applied.ListenPort);
        Assert.True(rtBridge.IsListening);
        Assert.Equal(string.Empty, rtBridge.LastBindError);

        // Self-loop port conflict records LastBindError clearly
        await rtClient.HandleInboundEnvelopeAsync(
            null,
            $"{{\"type\":\"chat.osc_config\",\"payload\":{{\"enabled\":true,\"sendPort\":{targetPort},\"listenEnabled\":true,\"listenPort\":{targetPort},\"forwardToVrchat\":true}}}}",
            CancellationToken.None);
        Assert.False(rtBridge.IsListening);
        Assert.False(string.IsNullOrEmpty(rtBridge.LastBindError));

        // Cloud disabling OSC immediately pauses outbound OSC dispatch
        await rtClient.HandleInboundEnvelopeAsync(
            null,
            "{\"type\":\"chat.osc_config\",\"payload\":{\"enabled\":false,\"sendPort\":9000,\"listenEnabled\":false,\"listenPort\":9002,\"forwardToVrchat\":true}}",
            CancellationToken.None);
        var (disabledOk, disabledMsg) = await rtClient.ExecuteOscOnlyActionAsync(
            "send_osc_chatbox",
            new Dictionary<string, object?> { ["message"] = "blocked while paused" },
            CancellationToken.None);
        Assert.False(disabledOk);
        Assert.Contains("disabled", disabledMsg, StringComparison.OrdinalIgnoreCase);

        // 9. Shared UDP sender reuses socket across sends and self-heals cleanly after DisposeSharedSender()
        var (send1Ok, _) = await OscProtocol.SendChatboxInputAsync("Reusable socket #1", true, true, targetPort);
        Assert.True(send1Ok);
        OscProtocol.DisposeSharedSender();
        var (send2Ok, _) = await OscProtocol.SendChatboxInputAsync("Reusable socket #2", true, true, targetPort);
        Assert.True(send2Ok);
    }

    private sealed class StubHttpHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _responder;
        public StubHttpHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> responder) => _responder = responder;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            _responder(request);
    }
}
