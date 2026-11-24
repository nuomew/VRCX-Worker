using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using VRCX.Agent.Core;
using Xunit;

namespace VRCX.Agent.Tests;

public sealed class AgentCoreTests
{
    [Fact]
    public void HmacSigner_MatchesCloudflareWorkerCanonicalVector()
    {
        // Known deterministic vector matching cloud/src/auth/auth.ts:
        // canonical = `${ts}\n${METHOD}\n${pathname}\n${sha256Hex(rawBody)}`
        string body = "{\"events\":[]}";
        string sig = HmacSigner.SignCanonical(
            hmacSecret: "test-secret-key",
            unixTimestampSeconds: 1700000000,
            httpMethod: "post",
            pathname: "/api/agent/ingest/gamelog",
            rawBodyText: body);

        Assert.Equal(64, sig.Length);
        Assert.Equal(sig, sig.ToLowerInvariant());

        // Recomputing with uppercase method yields identical signature
        string sigUpper = HmacSigner.SignCanonical(
            "test-secret-key", 1700000000, "POST", "/api/agent/ingest/gamelog", body);
        Assert.Equal(sig, sigUpper);

        // Tampered body produces a different signature
        string sigTampered = HmacSigner.SignCanonical(
            "test-secret-key", 1700000000, "POST", "/api/agent/ingest/gamelog", "{\"events\":[1]}");
        Assert.NotEqual(sig, sigTampered);
    }

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
    public async Task LogTailCollector_PersistsCursorOfflineQueueAndFlushesWithHmac()
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
                DeviceId = "win-test01",
                DeviceToken = "tok-abc",
                HmacSecret = "sec-xyz"
            };

            string? capturedAuth = null;
            string? capturedSig = null;
            string? capturedBody = null;

            using var handler = new StubHttpHandler(async (req) =>
            {
                capturedAuth = req.Headers.Authorization?.ToString();
                capturedSig = string.Join("", req.Headers.GetValues("X-Signature"));
                capturedBody = await req.Content!.ReadAsStringAsync();
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"ok\":true,\"data\":{\"inserted\":1}}", Encoding.UTF8, "application/json")
                };
            });
            using var http = new HttpClient(handler);

            var collector = new LogTailCollector(stateDir, () => cfg, http);
            int parsed = collector.PollLogDirectory(logDir);
            Assert.Equal(1, parsed);
            Assert.Equal(1, collector.OfflineQueueCount);

            // Second poll without new lines reads 0 bytes
            Assert.Equal(0, collector.PollLogDirectory(logDir));

            // Flush succeeds and empties offline queue
            bool flushed = await collector.FlushAsync(force: true, CancellationToken.None);
            Assert.True(flushed);
            Assert.Equal(0, collector.OfflineQueueCount);
            Assert.Equal("Bearer tok-abc", capturedAuth);
            Assert.NotNull(capturedSig);
            Assert.Equal(64, capturedSig!.Length);
            Assert.Contains("Test Shrine", capturedBody);
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

    private sealed class StubHttpHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _responder;
        public StubHttpHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> responder) => _responder = responder;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            _responder(request);
    }
}
