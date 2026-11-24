<template>
    <!-- 1. Cloud Access / Passcode Unlock Overlay (only when ADMIN_PASSCODE is set and unauthenticated) -->
    <div
        v-if="isWeb && cloudState.initialized && !cloudState.authenticated"
        class="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 backdrop-blur-sm p-4">
        <div class="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl space-y-4">
            <div class="space-y-1">
                <h2 class="text-lg font-semibold text-foreground">VRCX Cloud Unlock</h2>
                <p class="text-xs text-muted-foreground">
                    <template v-if="cloudState.authMode === 'cloudflare_access'">
                        Protected by Cloudflare Access. Please sign in through your Access portal and reload.
                    </template>
                    <template v-else>
                        Enter your private cloud passcode{{ cloudState.requiresTotp ? ' and 6-digit TOTP code' : '' }}.
                    </template>
                </p>
            </div>

            <form v-if="cloudState.authMode !== 'cloudflare_access'" class="space-y-3" @submit.prevent="submitUnlock">
                <input
                    v-model="passcode"
                    type="password"
                    autocomplete="current-password"
                    placeholder="Cloud Passcode"
                    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    required />
                <input
                    v-if="cloudState.requiresTotp"
                    v-model="totpCode"
                    type="text"
                    inputmode="numeric"
                    maxlength="6"
                    placeholder="6-digit TOTP Code"
                    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    required />
                <p v-if="unlockError" class="text-xs text-destructive">{{ unlockError }}</p>
                <button
                    type="submit"
                    :disabled="unlocking"
                    class="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    {{ unlocking ? 'Verifying...' : 'Unlock VRCX Cloud' }}
                </button>
            </form>
        </div>
    </div>

    <!-- 2. VRCX Cloud Hub Modal (Device Pairing, Remote Commands, R2 Gallery, Free-Tier Quota & WAF Probe) -->
    <div
        v-if="isWeb && cloudState.hubDialogOpen"
        class="fixed inset-0 z-[9990] flex items-center justify-center bg-black/60 backdrop-blur-xs p-3"
        @click.self="cloudState.hubDialogOpen = false">
        <div
            class="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl">
            <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
                <div class="flex items-center gap-2.5">
                    <span
                        class="inline-block size-2.5 rounded-full"
                        :class="
                            cloudState.agentsOnline.length > 0 || recentSyncedCount > 0
                                ? 'bg-status-online'
                                : 'bg-status-offline-alt'
                        " />
                    <h2 class="text-sm font-semibold">VRCX Cloud Hub</h2>
                    <span class="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        <template v-if="cloudState.agentsOnline.length > 0">
                            Win Agent Online ({{ cloudState.agentsOnline.length }})
                        </template>
                        <template v-else-if="recentSyncedCount > 0">
                            Win Agent Synced ({{ recentSyncedCount }})
                        </template>
                        <template v-else>Win Agent Idle</template>
                    </span>
                </div>
                <button
                    type="button"
                    class="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    @click="cloudState.hubDialogOpen = false">
                    Close
                </button>
            </div>

            <!-- Tabs -->
            <div class="flex gap-1 border-b border-border px-4 pt-2 text-xs">
                <button
                    v-for="tab in tabs"
                    :key="tab.id"
                    type="button"
                    class="rounded-t-md px-3 py-2 font-medium transition-colors"
                    :class="
                        activeTab === tab.id
                            ? 'border-b-2 border-primary text-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                    "
                    @click="selectTab(tab.id)">
                    {{ tab.label }}
                </button>
            </div>

            <div class="flex-1 overflow-y-auto p-5 text-xs space-y-4">
                <!-- Tab 1: Windows Agent Periodic HTTP Sync (URL + Sync Secret) -->
                <div v-if="activeTab === 'devices'" class="space-y-4">
                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-3">
                        <div>
                            <div class="font-medium text-foreground">Windows Companion HTTP Sync (VRCX.Agent)</div>
                            <div class="text-muted-foreground">
                                Paste the Cloud URL and a Sync Secret into VRCX.Agent on Windows. The agent will periodically
                                upload local VRChat logs, state, and screenshots over HTTPS (no persistent WebSocket needed).
                            </div>
                        </div>

                        <div class="space-y-1">
                            <div class="text-[11px] font-medium text-muted-foreground">Cloud URL</div>
                            <div class="flex items-center gap-2">
                                <input
                                    :value="cloudOriginUrl"
                                    type="text"
                                    readonly
                                    class="flex-1 rounded-md border border-input bg-muted/40 px-3 py-1.5 font-mono text-xs text-foreground" />
                                <button
                                    type="button"
                                    class="rounded-md border border-border px-3 py-1.5 font-medium hover:bg-accent"
                                    @click="copyText(cloudOriginUrl, 'url')">
                                    {{ copiedField === 'url' ? 'Copied' : 'Copy URL' }}
                                </button>
                            </div>
                        </div>

                        <div class="space-y-1.5 pt-1">
                            <div class="text-[11px] font-medium text-muted-foreground">Create Sync Secret</div>
                            <div class="flex flex-wrap items-center gap-2">
                                <input
                                    v-model="newDeviceName"
                                    type="text"
                                    maxlength="64"
                                    placeholder="Device Name (e.g. Gaming-PC)"
                                    class="min-w-[180px] flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground" />
                                <button
                                    type="button"
                                    class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                                    @click="createSyncSecret">
                                    Create Sync Secret
                                </button>
                            </div>
                        </div>

                        <div v-if="createdSyncKey" class="space-y-1.5 rounded-md border border-primary/30 bg-muted/60 p-3">
                            <div class="flex items-center justify-between gap-2">
                                <span class="font-medium text-foreground">
                                    Sync Secret for {{ createdDeviceName }} (shown once):
                                </span>
                                <button
                                    type="button"
                                    class="rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground"
                                    @click="copyText(createdSyncKey, 'secret')">
                                    {{ copiedField === 'secret' ? 'Copied' : 'Copy Secret' }}
                                </button>
                            </div>
                            <div class="break-all rounded bg-background/80 px-2.5 py-1.5 font-mono text-[11px] text-primary">
                                {{ createdSyncKey }}
                            </div>
                        </div>

                        <div class="text-[11px] text-muted-foreground">
                            Tip: You can also configure a static <code class="font-mono">AGENT_SYNC_KEY</code> in Cloudflare
                            Worker Secrets instead of generating per-device keys here.
                        </div>
                    </div>

                    <div class="space-y-2">
                        <div class="font-medium text-foreground">Configured Sync Devices ({{ devices.length }})</div>
                        <div
                            v-if="devices.length === 0"
                            class="rounded-lg border border-dashed border-border p-4 text-muted-foreground">
                            No Windows sync device configured yet. Create a Sync Secret above, install VRCX.Agent on Windows,
                            and enter the Cloud URL and Secret.
                        </div>
                        <div
                            v-for="dev in devices"
                            :key="dev.device_id"
                            class="flex items-center justify-between rounded-lg border border-border p-3">
                            <div class="space-y-0.5">
                                <div class="flex items-center gap-2 font-medium">
                                    <span
                                        class="inline-block size-2 rounded-full"
                                        :class="isRecentlySynced(dev.last_seen_at) ? 'bg-status-online' : 'bg-status-offline-alt'" />
                                    <span>{{ dev.device_name }}</span>
                                    <span class="font-mono text-[11px] text-muted-foreground">{{ dev.device_id }}</span>
                                </div>
                                <div class="text-muted-foreground">
                                    v{{ dev.agent_version || '1.1.0' }} · Last sync:
                                    {{ dev.last_seen_at || 'Never synced yet' }}
                                </div>
                            </div>
                            <button
                                type="button"
                                class="rounded border border-destructive/40 px-2.5 py-1 text-destructive hover:bg-destructive/10"
                                @click="revokeDevice(dev.device_id)">
                                Revoke
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Tab 2: Remote Commands -->
                <div v-if="activeTab === 'commands'" class="space-y-4">
                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-3">
                        <div class="font-medium text-foreground">Launch VRChat Instance on Windows PC</div>
                        <div class="flex flex-wrap gap-2">
                            <input
                                v-model="launchUrlInput"
                                type="text"
                                placeholder="vrchat://launch?id=wrld_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:12345"
                                class="min-w-[240px] flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs" />
                            <button
                                type="button"
                                class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                                @click="sendCommand('launch_vrc', { launchUrl: launchUrlInput })">
                                Launch Instance
                            </button>
                        </div>
                        <div class="flex flex-wrap gap-2 pt-1">
                            <button
                                type="button"
                                class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"
                                @click="sendCommand('clear_cache', { scope: 'all' })">
                                Clear VRChat Cache
                            </button>
                            <button
                                type="button"
                                class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"
                                @click="sendCommand('send_vr_notify', { target: 'xsoverlay', title: 'VRCX Cloud', content: 'Test notification from Web' })">
                                Test VR Notification
                            </button>
                            <button
                                type="button"
                                class="rounded-md border border-destructive/40 px-3 py-1.5 text-destructive hover:bg-destructive/10"
                                @click="sendCommand('quit_vrc', {})">
                                Quit VRChat
                            </button>
                        </div>
                        <p v-if="commandNotice" class="text-muted-foreground">{{ commandNotice }}</p>
                    </div>

                    <div class="space-y-1.5">
                        <div class="font-medium text-foreground">Command Audit History</div>
                        <div
                            v-for="cmd in commandHistory"
                            :key="cmd.cmd_id"
                            class="flex items-center justify-between rounded border border-border px-3 py-2">
                            <div>
                                <span class="font-mono font-semibold">{{ cmd.action }}</span>
                                <span class="ml-2 text-muted-foreground">{{ cmd.created_at }}</span>
                            </div>
                            <span class="rounded bg-muted px-2 py-0.5 font-mono uppercase">{{ cmd.status }}</span>
                        </div>
                    </div>
                </div>

                <!-- Tab 3: R2 Cloud Screenshot Gallery -->
                <div v-if="activeTab === 'gallery'" class="space-y-3">
                    <div class="flex items-center justify-between">
                        <span class="text-muted-foreground">
                            R2 Storage: {{ cloudState.r2Enabled ? 'Enabled (Private Bucket)' : 'Not bound yet (Metadata-only mode)' }}
                        </span>
                        <button
                            type="button"
                            class="rounded border border-border px-2.5 py-1 hover:bg-accent"
                            @click="loadScreenshots">
                            Refresh
                        </button>
                    </div>
                    <div v-if="screenshots.length === 0" class="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">
                        No cloud screenshots synced yet. Take a screenshot in VRChat while VRCX.Agent is running.
                    </div>
                    <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <div
                            v-for="shot in screenshots"
                            :key="shot.id"
                            class="overflow-hidden rounded-lg border border-border bg-background/60">
                            <img
                                v-if="shot.r2_thumb_key && cloudState.r2Enabled"
                                :src="`/api/media/screenshots/${encodeURIComponent(shot.id)}`"
                                :alt="shot.world_name || shot.local_filename"
                                loading="lazy"
                                class="aspect-video w-full object-cover bg-muted" />
                            <div class="p-2 space-y-0.5">
                                <div class="truncate font-medium">{{ shot.world_name || shot.local_filename }}</div>
                                <div class="text-[11px] text-muted-foreground">{{ shot.taken_at }}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Tab 4: Free-Tier Quota & VRChat WAF Diagnostics -->
                <div v-if="activeTab === 'quota'" class="space-y-4">
                    <div v-if="quotaInfo" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div
                            v-for="(info, key) in quotaInfo.databases"
                            :key="key"
                            class="rounded-lg border border-border p-3 space-y-1">
                            <div class="font-mono font-semibold uppercase">DB_{{ key }}</div>
                            <div class="text-sm font-bold">{{ formatBytes(info.bytes) }} / 500 MB</div>
                            <div class="h-1.5 w-full overflow-hidden rounded bg-muted">
                                <div
                                    class="h-full bg-primary"
                                    :style="{ width: Math.min(100, info.percentOfFreeLimit) + '%' }" />
                            </div>
                            <div class="text-[11px] text-muted-foreground">{{ info.percentOfFreeLimit }}% of Free shard</div>
                        </div>
                    </div>

                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-2">
                        <div class="flex items-center justify-between">
                            <div>
                                <div class="font-medium text-foreground">VRChat API Edge Egress Probe</div>
                                <div class="text-muted-foreground">
                                    Tests direct Worker -> api.vrchat.cloud reachability (Current VRC route:
                                    <span class="font-mono">{{ cloudState.lastVrcRoute || 'idle' }}</span>)
                                </div>
                            </div>
                            <button
                                type="button"
                                class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                                @click="runWafProbe">
                                Run Probe
                            </button>
                        </div>
                        <pre v-if="wafProbeResult" class="overflow-x-auto rounded bg-muted/60 p-2.5 font-mono text-[11px]">{{
                            wafProbeResult
                        }}</pre>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { cloudFetch, connectCloudHubWs } from '../../ipc-web/apiClient';
    import { loadBootstrap } from '../../ipc-web/bootstrapCache';
    import { cloudState } from '../../ipc-web/cloudState';

    const isWeb = typeof WEB !== 'undefined' && WEB;
    const cloudOriginUrl = typeof window !== 'undefined' ? window.location.origin : '';

    const passcode = ref('');
    const totpCode = ref('');
    const unlockError = ref('');
    const unlocking = ref(false);

    const tabs = [
        { id: 'devices', label: 'Win Agent (HTTP Sync)' },
        { id: 'commands', label: 'Remote Control' },
        { id: 'gallery', label: 'Cloud Gallery (R2)' },
        { id: 'quota', label: 'Free-Tier Quota & WAF' }
    ];
    const activeTab = ref('devices');

    const newDeviceName = ref('Windows PC');
    const createdSyncKey = ref('');
    const createdDeviceName = ref('');
    const copiedField = ref('');
    const devices = ref([]);
    const launchUrlInput = ref('');
    const commandNotice = ref('');
    const commandHistory = ref([]);
    const screenshots = ref([]);
    const quotaInfo = ref(null);
    const wafProbeResult = ref('');

    const recentSyncedCount = computed(() => devices.value.filter((d) => isRecentlySynced(d.last_seen_at)).length);

    function isRecentlySynced(lastSeenIso) {
        if (!lastSeenIso) return false;
        const ts = Date.parse(lastSeenIso);
        return Number.isFinite(ts) && Date.now() - ts <= 5 * 60 * 1000;
    }

    async function copyText(text, field) {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            copiedField.value = field;
            setTimeout(() => {
                if (copiedField.value === field) copiedField.value = '';
            }, 2000);
        } catch {
            // Clipboard permission unavailable
        }
    }

    async function submitUnlock() {
        unlockError.value = '';
        unlocking.value = true;
        try {
            await cloudFetch('/api/auth/login', {
                method: 'POST',
                json: { passcode: passcode.value, totp: totpCode.value || undefined }
            });
            cloudState.authenticated = true;
            await loadBootstrap();
            connectCloudHubWs();
            window.location.reload();
        } catch (err) {
            unlockError.value = err?.message || 'Unlock failed';
        } finally {
            unlocking.value = false;
        }
    }

    function formatBytes(bytes) {
        const n = Number(bytes || 0);
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    }

    async function loadDevices() {
        devices.value = await cloudFetch('/api/agent/devices').catch(() => []);
    }

    async function createSyncSecret() {
        const name = (newDeviceName.value || '').trim() || 'Windows PC';
        const data = await cloudFetch('/api/agent/sync-key', {
            method: 'POST',
            json: { deviceName: name }
        });
        createdSyncKey.value = data.syncKey;
        createdDeviceName.value = data.deviceName || name;
        await loadDevices();
    }

    async function revokeDevice(deviceId) {
        await cloudFetch(`/api/agent/devices?deviceId=${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
        await loadDevices();
    }

    async function loadCommands() {
        commandHistory.value = await cloudFetch('/api/commands?limit=25').catch(() => []);
    }

    async function sendCommand(action, params) {
        commandNotice.value = `Sending ${action}...`;
        try {
            const res = await cloudFetch('/api/commands', {
                method: 'POST',
                json: { action, params }
            });
            commandNotice.value =
                res.status === 'queued'
                    ? `Queued ${action} for next Agent HTTP sync (${res.cmdId})`
                    : `Dispatched ${action} (${res.cmdId})`;
        } catch (err) {
            commandNotice.value = `Failed: ${err?.message || 'Unknown error'}`;
        }
        await loadCommands();
    }

    async function loadScreenshots() {
        screenshots.value = await cloudFetch('/api/screenshots?limit=60').catch(() => []);
    }

    async function loadQuota() {
        quotaInfo.value = await cloudFetch('/api/admin/quota').catch(() => null);
    }

    async function runWafProbe() {
        wafProbeResult.value = 'Probing https://api.vrchat.cloud/api/1/config ...';
        try {
            const res = await cloudFetch('/poc/vrc-probe');
            wafProbeResult.value = JSON.stringify(res, null, 2);
        } catch (err) {
            wafProbeResult.value = `Error: ${err?.message || err}`;
        }
    }

    function selectTab(id) {
        activeTab.value = id;
        if (id === 'devices') loadDevices();
        else if (id === 'commands') loadCommands();
        else if (id === 'gallery') loadScreenshots();
        else if (id === 'quota') loadQuota();
    }

    watch(
        () => cloudState.hubDialogOpen,
        (open) => {
            if (open) {
                selectTab(activeTab.value);
            }
        }
    );
</script>
