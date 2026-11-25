using System;
using System.Text;
using System.Threading;
using DiscordRPC;
using NLog;

namespace VRCX
{
    public class Discord
    {
        private readonly Logger _logger = LogManager.GetCurrentClassLogger();
        public static readonly Discord Instance;
        private readonly ReaderWriterLockSlim _lock;
        private readonly RichPresence _presence;
        private DiscordRpcClient _client;
        private readonly Timer _timer;
        private volatile bool _active;
        private volatile bool _exited;
        private string _discordAppId;
        private const string VrcxUrl = "https://vrcx.app";

        static Discord()
        {
            Instance = new Discord();
        }

        public Discord()
        {
            _lock = new ReaderWriterLockSlim();
            _presence = new RichPresence();
            _timer = new Timer(TimerCallback, null, -1, -1);
        }

        public void Init()
        {
            lock (this)
            {
                _exited = false;
                _timer.Change(0, 3000);
            }
        }

        public void Exit()
        {
            lock (this)
            {
                _exited = true;
                _active = false;
                _timer.Change(-1, -1);
                _client?.Dispose();
                _client = null;
            }
        }

        private void TimerCallback(object state)
        {
            lock (this)
            {
                try
                {
                    Update();
                }
                catch (Exception ex)
                {
                    _logger.Error(ex, "Error updating Discord Rich Presence {Error}", ex.Message);
                }
            }
        }

        private void Update()
        {
            if (_exited)
                return;

            if (_client == null && _active && !string.IsNullOrWhiteSpace(_discordAppId))
            {
                _client = new DiscordRpcClient(_discordAppId);
                _client.OnReady += (sender, e) =>
                {
                    _logger.Info("Discord Rich Presence connected: {User}", e.User.DisplayName);
                };
                _client.OnError += (sender, e) =>
                {
                    _logger.Error("Discord Rich Presence error: {Error}", e.Message);
                };
                _client.OnConnectionFailed += (sender, e) =>
                {
                    _logger.Error("Discord Rich Presence connection failed: {Error}", e.Type);
                };
                _client.OnConnectionEstablished += (sender, e) =>
                {
                    _logger.Info("Discord Rich Presence connection established");
                };
                if (!_client.Initialize())
                {
                    _client.Dispose();
                    _client = null;
                }
            }

            if (_client != null && !_active)
            {
                _client.Dispose();
                _client = null;
            }

            if (_client != null && !_lock.IsWriteLockHeld)
            {
                _lock.EnterReadLock();
                try
                {
                    _client.SetPresence(_presence);
                }
                finally
                {
                    _lock.ExitReadLock();
                }
                _client.Invoke();
            }
        }

        public bool SetActive(bool active)
        {
            _active = active;
            return _active;
        }

        internal static string LimitByteLength(string str, int maxBytesLength)
        {
            if (string.IsNullOrEmpty(str) || maxBytesLength <= 0)
                return string.Empty;
            if (Encoding.UTF8.GetByteCount(str) <= maxBytesLength)
                return str;

            var sb = new StringBuilder(str.Length);
            int usedBytes = 0;
            int i = 0;
            while (i < str.Length)
            {
                int charLen = char.IsSurrogatePair(str, i) ? 2 : 1;
                int chunkBytes = Encoding.UTF8.GetByteCount(str, i, charLen);
                if (usedBytes + chunkBytes > maxBytesLength)
                    break;
                sb.Append(str, i, charLen);
                usedBytes += chunkBytes;
                i += charLen;
            }
            return sb.ToString();
        }

        public void SetAssets(
            string details,
            string state,
            string detailsUrl,

            string largeKey,
            string largeText,

            string smallKey,
            string smallText,

            double startUnixMilliseconds,
            double endUnixMilliseconds,

            string partyId,
            int partySize,
            int partyMax,
            string buttonText,
            string buttonUrl,
            string appId,
            int activityType,
            int statusDisplayType)
        {
            bool appIdChanged = false;
            string effectiveAppId = string.IsNullOrEmpty(appId) ? (_discordAppId ?? "883308884863901717") : appId;
            _lock.EnterWriteLock();
            try
            {
                appIdChanged = _discordAppId != effectiveAppId;
                _presence.Details = LimitByteLength(details, 127);
                _presence.DetailsUrl = !string.IsNullOrEmpty(detailsUrl) ? detailsUrl : null;
                // _presence.StateUrl
                _presence.State = LimitByteLength(state, 127);

                if (string.IsNullOrEmpty(largeKey) &&
                    string.IsNullOrEmpty(smallKey))
                {
                    _presence.Assets = null;
                    _presence.Party = null;
                    _presence.Timestamps = null;
                }
                else
                {
                    _presence.Assets ??= new Assets();

                    _presence.Assets.LargeImageKey = largeKey;
                    _presence.Assets.LargeImageText = LimitByteLength(largeText, 127);
                    _presence.Assets.LargeImageUrl = VrcxUrl;

                    _presence.Assets.SmallImageKey = smallKey;
                    _presence.Assets.SmallImageText = LimitByteLength(smallText, 127);
                    // m_Presence.Assets.SmallImageUrl

                    if (startUnixMilliseconds == 0)
                    {
                        _presence.Timestamps = null;
                    }
                    else
                    {
                        _presence.Timestamps ??= new Timestamps();
                        _presence.Timestamps.StartUnixMilliseconds = (ulong)startUnixMilliseconds;
                        if (endUnixMilliseconds == 0)
                            _presence.Timestamps.End = null;
                        else
                            _presence.Timestamps.EndUnixMilliseconds = (ulong)endUnixMilliseconds;
                    }

                    if (partyMax == 0)
                    {
                        _presence.Party = null;
                    }
                    else
                    {
                        _presence.Party ??= new Party();
                        _presence.Party.ID = partyId;
                        _presence.Party.Size = partySize;
                        _presence.Party.Max = partyMax;
                    }
                }

                _presence.Type = (ActivityType)activityType;
                _presence.StatusDisplay = (StatusDisplayType)statusDisplayType;

                Button[] buttons = [];
                if (!string.IsNullOrEmpty(buttonUrl) && !string.IsNullOrWhiteSpace(buttonText))
                {
                    string safeLabel = LimitByteLength(buttonText, 32);
                    if (!string.IsNullOrWhiteSpace(safeLabel))
                    {
                        buttons =
                        [
                            new Button { Label = safeLabel, Url = buttonUrl }
                        ];
                    }
                }
                _presence.Buttons = buttons;
            }
            catch (Exception ex)
            {
                _logger.Error(ex, "Error setting Discord Rich Presence assets: {Error}", ex.Message);
            }
            finally
            {
                _lock.ExitWriteLock();
            }

            if (appIdChanged)
            {
                // Always acquire `lock (this)` outside `_lock` (matching TimerCallback/Exit lock order)
                // so _client disposal/recreation never races with the 3-second presence timer.
                lock (this)
                {
                    if (_discordAppId != effectiveAppId)
                    {
                        _discordAppId = effectiveAppId;
                        if (_client != null)
                        {
                            _client.Dispose();
                            _client = null;
                        }
                        Update();
                    }
                }
            }
        }
    }
}
