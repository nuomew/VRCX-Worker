<template>
    <!-- 1. Cloud Access / Passcode / 2FA Unlock Overlay -->
    <Teleport to="body">
        <div
            v-if="isWeb && cloudState.initialized && !cloudState.authenticated"
            class="fixed inset-0 z-[20000] flex items-center justify-center bg-background/95 backdrop-blur-sm p-4">
        <div class="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl space-y-4">
            <div class="space-y-1">
                <h2 class="text-lg font-semibold text-foreground">
                    {{
                        isCombinedSecurityGate
                            ? t('cloud_hub.unlock.combined_gate_title')
                            : isStandaloneStaticPasscodeGate
                              ? t('cloud_hub.unlock.static_passcode_only_title')
                              : isStandalone2faGate
                                ? t('cloud_hub.unlock.totp_only_title')
                                : t('cloud_hub.unlock.title')
                    }}
                </h2>
                <p class="text-xs text-muted-foreground">
                    <template v-if="cloudState.authCheckFailed">
                        {{ t('cloud_hub.unlock.check_failed_desc') }}
                    </template>
                    <template v-else-if="cloudState.authMode === 'cloudflare_access' && !cloudState.primaryAuthenticated">
                        {{ t('cloud_hub.unlock.cf_access_desc') }}
                    </template>
                    <template v-else-if="isCombinedSecurityGate">
                        {{ t('cloud_hub.unlock.combined_gate_desc') }}
                    </template>
                    <template v-else-if="isStandaloneStaticPasscodeGate">
                        {{ t('cloud_hub.unlock.static_passcode_only_desc') }}
                    </template>
                    <template v-else-if="isStandalone2faGate">
                        {{ t('cloud_hub.unlock.totp_only_desc') }}
                    </template>
                    <template v-else-if="cloudState.requiresTotp">
                        {{ t('cloud_hub.unlock.passcode_totp_desc') }}
                    </template>
                    <template v-else>
                        {{ t('cloud_hub.unlock.passcode_desc') }}
                    </template>
                </p>
            </div>

            <div v-if="cloudState.authCheckFailed" class="space-y-3">
                <p v-if="cloudState.authCheckError" class="text-xs text-destructive break-words">
                    {{ cloudState.authCheckError }}
                </p>
                <button
                    type="button"
                    :disabled="retryingAuthCheck"
                    class="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    @click="retryAuthCheck">
                    {{ retryingAuthCheck ? t('cloud_hub.unlock.retrying') : t('cloud_hub.unlock.retry_check') }}
                </button>
            </div>

            <div
                v-else-if="cloudState.authMode === 'cloudflare_access' && !cloudState.primaryAuthenticated"
                class="space-y-3">
                <button
                    type="button"
                    class="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                    @click="reloadForCloudflareAccess">
                    {{ t('cloud_hub.unlock.cf_access_reload') }}
                </button>
            </div>

            <form v-else class="space-y-3" @submit.prevent="submitUnlock">
                <input
                    v-if="!isStandaloneSecurityGate"
                    v-model="passcode"
                    type="password"
                    autocomplete="current-password"
                    :placeholder="t('cloud_hub.unlock.passcode_placeholder')"
                    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    required />
                <input
                    v-if="needsStaticPasscodeInput"
                    v-model="staticPassphraseInput"
                    type="password"
                    autocomplete="current-password"
                    :placeholder="t('cloud_hub.unlock.static_passcode_placeholder')"
                    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    required />
                <input
                    v-if="needsTotpInput"
                    v-model="totpCode"
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="6"
                    :placeholder="t('cloud_hub.unlock.totp_placeholder')"
                    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono tracking-widest text-foreground"
                    :class="isStandalone2faGate && !needsStaticPasscodeInput ? 'text-center text-base' : ''"
                    required />

                <div v-if="showTrustDurationPicker" class="space-y-1.5 pt-0.5">
                    <label class="block text-[11px] font-medium text-muted-foreground">
                        {{ t('cloud_hub.unlock.trust_duration_label') }}
                    </label>
                    <select
                        v-model="trustPresetSelection"
                        class="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground dark:[color-scheme:dark]">
                        <option class="bg-card text-foreground" value="0">{{ t('cloud_hub.two_factor.trust_session') }}</option>
                        <option class="bg-card text-foreground" value="3600">{{ t('cloud_hub.two_factor.trust_1h') }}</option>
                        <option class="bg-card text-foreground" value="43200">{{ t('cloud_hub.two_factor.trust_12h') }}</option>
                        <option class="bg-card text-foreground" value="86400">{{ t('cloud_hub.two_factor.trust_1d') }}</option>
                        <option class="bg-card text-foreground" value="259200">{{ t('cloud_hub.two_factor.trust_3d') }}</option>
                        <option class="bg-card text-foreground" value="604800">{{ t('cloud_hub.two_factor.trust_7d') }}</option>
                        <option class="bg-card text-foreground" value="1209600">{{ t('cloud_hub.two_factor.trust_14d') }}</option>
                        <option class="bg-card text-foreground" value="2592000">{{ t('cloud_hub.two_factor.trust_30d') }}</option>
                        <option class="bg-card text-foreground" value="custom">{{ t('cloud_hub.two_factor.trust_custom') }}</option>
                    </select>
                    <div v-if="trustPresetSelection === 'custom'" class="flex items-center gap-2">
                        <input
                            v-model.number="customTrustDays"
                            type="number"
                            min="1"
                            max="30"
                            step="1"
                            class="w-24 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs text-foreground" />
                        <span class="text-xs text-muted-foreground">{{ t('cloud_hub.two_factor.custom_days_unit') }}</span>
                    </div>
                    <p class="text-[11px] text-muted-foreground leading-relaxed">
                        {{ t('cloud_hub.unlock.trust_cache_hint') }}
                    </p>
                </div>

                <p v-if="unlockError" class="text-xs text-destructive">{{ unlockError }}</p>
                <button
                    type="submit"
                    :disabled="unlocking"
                    class="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    {{
                        unlocking
                            ? t('cloud_hub.unlock.verifying')
                            : isStandaloneSecurityGate
                              ? t('cloud_hub.unlock.totp_submit')
                              : t('cloud_hub.unlock.submit')
                    }}
                </button>
            </form>
        </div>
        </div>
    </Teleport>

    <!-- 2. VRCX Cloud Hub Modal (HTTP Sync, Remote Commands, Free-Tier Quota & WAF Probe) -->
    <Teleport to="body">
        <div
            v-if="isWeb && cloudState.hubDialogOpen"
            class="fixed inset-0 z-[19990] flex items-center justify-center bg-black/60 backdrop-blur-xs p-3">
        <div
            class="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl">
            <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
                <div class="flex items-center gap-2.5">
                    <span
                        class="inline-block size-2.5 rounded-full"
                        :class="
                            liveOnlineAgentsCount > 0 || recentSyncedCount > 0
                                ? 'bg-status-online'
                                : 'bg-status-offline-alt'
                        " />
                    <h2 class="text-sm font-semibold">{{ t('cloud_hub.title') }}</h2>
                    <span class="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        <template v-if="liveOnlineAgentsCount > 0">
                            {{ t('cloud_hub.agent_online', { count: liveOnlineAgentsCount }) }}
                        </template>
                        <template v-else-if="recentSyncedCount > 0">
                            {{ t('cloud_hub.agent_synced', { count: recentSyncedCount }) }}
                        </template>
                        <template v-else>{{ t('cloud_hub.agent_idle') }}</template>
                    </span>
                </div>
                <button
                    type="button"
                    class="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    @click="cloudState.hubDialogOpen = false">
                    {{ t('cloud_hub.close') }}
                </button>
            </div>

            <!-- Tabs -->
            <div class="flex gap-1 overflow-x-auto border-b border-border px-4 pt-2 text-xs">
                <button
                    v-for="tab in tabs"
                    :key="tab.id"
                    type="button"
                    class="whitespace-nowrap shrink-0 rounded-t-md px-3 py-2 font-medium transition-colors"
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
                        <div class="space-y-2">
                            <div>
                                <div class="font-medium text-foreground">{{ t('cloud_hub.devices.heading') }}</div>
                                <div class="text-muted-foreground">
                                    {{ t('cloud_hub.devices.desc') }}
                                </div>
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <a
                                    :href="links.agentDownload"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="inline-flex items-center rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90">
                                    {{ t('cloud_hub.devices.download_release_btn') }}
                                </a>
                                <a
                                    :href="links.agentGuide"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="inline-flex items-center rounded-md border border-border px-3 py-1.5 font-medium text-foreground hover:bg-accent">
                                    {{ t('cloud_hub.devices.download_guide_btn') }}
                                </a>
                            </div>
                        </div>

                        <div class="space-y-1">
                            <div class="text-[11px] font-medium text-muted-foreground">
                                {{ t('cloud_hub.devices.cloud_url') }}
                            </div>
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
                                    {{
                                        copiedField === 'url'
                                            ? t('cloud_hub.devices.copied')
                                            : t('cloud_hub.devices.copy_url')
                                    }}
                                </button>
                            </div>
                        </div>

                        <div class="space-y-1.5 pt-1">
                            <div class="text-[11px] font-medium text-muted-foreground">
                                {{ t('cloud_hub.devices.create_secret_label') }}
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <input
                                    v-model="newDeviceName"
                                    type="text"
                                    maxlength="64"
                                    :placeholder="t('cloud_hub.devices.device_name_placeholder')"
                                    class="min-w-[180px] flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground" />
                                <button
                                    type="button"
                                    class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-50"
                                    :disabled="creatingSyncSecret"
                                    @click="createSyncSecret">
                                    {{ t('cloud_hub.devices.create_secret_btn') }}
                                </button>
                            </div>
                            <p v-if="deviceActionError" class="text-[11px] text-destructive">
                                {{ deviceActionError }}
                            </p>
                        </div>

                        <div
                            v-if="createdSyncKey"
                            class="space-y-1.5 rounded-md border border-primary/30 bg-muted/60 p-3">
                            <div class="flex items-center justify-between gap-2">
                                <span class="font-medium text-foreground">
                                    {{ t('cloud_hub.devices.secret_created_for', { deviceName: createdDeviceName }) }}
                                </span>
                                <button
                                    type="button"
                                    class="rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground"
                                    @click="copyText(createdSyncKey, 'secret')">
                                    {{
                                        copiedField === 'secret'
                                            ? t('cloud_hub.devices.copied')
                                            : t('cloud_hub.devices.copy_secret')
                                    }}
                                </button>
                            </div>
                            <div
                                class="break-all rounded bg-background/80 px-2.5 py-1.5 font-mono text-[11px] text-primary">
                                {{ createdSyncKey }}
                            </div>
                        </div>

                        <div class="space-y-1.5 pt-1">
                            <div class="text-[11px] font-medium text-muted-foreground">
                                {{ t('cloud_hub.devices.sync_interval_label') }}
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <input
                                    v-model.number="syncIntervalInput"
                                    type="number"
                                    min="30"
                                    max="3600"
                                    step="30"
                                    class="w-28 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs text-foreground" />
                                <button
                                    type="button"
                                    class="rounded-md border border-border px-3 py-1.5 font-medium hover:bg-accent"
                                    :disabled="savingSyncInterval"
                                    @click="saveSyncInterval">
                                    {{
                                        savingSyncInterval
                                            ? t('cloud_hub.devices.saving')
                                            : t('cloud_hub.devices.save_interval')
                                    }}
                                </button>
                                <span v-if="syncIntervalNotice" class="text-[11px] text-primary">
                                    {{ syncIntervalNotice }}
                                </span>
                                <span v-else class="text-[11px] text-muted-foreground">
                                    {{ t('cloud_hub.devices.sync_interval_hint') }}
                                </span>
                            </div>
                        </div>

                        <div class="text-[11px] text-muted-foreground">
                            {{ t('cloud_hub.devices.static_secret_tip_prefix')
                            }}<code class="font-mono">AGENT_SYNC_KEY</code
                            >{{ t('cloud_hub.devices.static_secret_tip_suffix') }}
                        </div>
                    </div>
                </div>

                <!-- Tab 2: Synced Devices -->
                <div v-if="activeTab === 'synced_devices'" class="space-y-4">
                    <div class="space-y-2">
                        <div class="font-medium text-foreground">
                            {{ t('cloud_hub.devices.configured_list', { count: devices.length }) }}
                        </div>
                        <p v-if="deviceActionError" class="text-[11px] text-destructive">
                            {{ deviceActionError }}
                        </p>
                        <div
                            v-if="devices.length === 0"
                            class="rounded-lg border border-dashed border-border p-4 text-muted-foreground">
                            {{ t('cloud_hub.devices.empty_devices') }}
                        </div>
                        <div
                            v-for="dev in devices"
                            :key="dev.device_id"
                            class="flex items-center justify-between rounded-lg border border-border p-3">
                            <div class="space-y-0.5">
                                <div class="flex items-center gap-2 font-medium">
                                    <span
                                        class="inline-block size-2 rounded-full"
                                        :class="
                                            isRecentlySynced(dev.last_seen_at)
                                                ? 'bg-status-online'
                                                : 'bg-status-offline-alt'
                                        " />
                                    <span>{{ dev.device_name }}</span>
                                    <span class="font-mono text-[11px] text-muted-foreground">{{ dev.device_id }}</span>
                                </div>
                                <div class="text-muted-foreground">
                                    v{{ dev.agent_version || '1.10.8' }} ·
                                    {{
                                        t('cloud_hub.devices.last_sync', {
                                            time: dev.last_seen_at || t('cloud_hub.devices.never_synced')
                                        })
                                    }}
                                </div>
                            </div>
                            <button
                                type="button"
                                class="rounded border border-destructive/40 px-2.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                                :disabled="revokingDeviceId === dev.device_id"
                                @click="revokeDevice(dev.device_id)">
                                {{ t('cloud_hub.devices.revoke') }}
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Tab 2: Remote Commands -->
                <div v-if="activeTab === 'commands'" class="space-y-4">
                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-3">
                        <div class="font-medium text-foreground">{{ t('cloud_hub.commands.launch_heading') }}</div>
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
                                {{ t('cloud_hub.commands.launch_btn') }}
                            </button>
                        </div>
                        <div class="flex flex-wrap gap-2 pt-1">
                            <button
                                type="button"
                                class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"
                                @click="sendCommand('clear_cache', { scope: 'all' })">
                                {{ t('cloud_hub.commands.clear_cache') }}
                            </button>
                            <button
                                type="button"
                                class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"
                                @click="
                                    sendCommand('send_vr_notify', {
                                        target: 'xsoverlay',
                                        title: t('cloud_hub.mobile_title'),
                                        content: t('cloud_hub.commands.test_vr_notify_content')
                                    })
                                ">
                                {{ t('cloud_hub.commands.test_vr_notify') }}
                            </button>
                            <button
                                type="button"
                                class="rounded-md border border-destructive/40 px-3 py-1.5 text-destructive hover:bg-destructive/10"
                                @click="sendCommand('quit_vrc', {})">
                                {{ t('cloud_hub.commands.quit_vrc') }}
                            </button>
                        </div>
                        <p v-if="commandNotice" class="text-muted-foreground">{{ commandNotice }}</p>
                    </div>

                    <div class="space-y-1.5">
                        <div class="font-medium text-foreground">{{ t('cloud_hub.commands.history_heading') }}</div>
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

                <!-- Tab 3: Free-Tier Quota & VRChat WAF Diagnostics -->
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
                            <div class="text-[11px] text-muted-foreground">
                                {{ t('cloud_hub.quota.shard_percent', { percent: info.percentOfFreeLimit }) }}
                            </div>
                        </div>
                    </div>

                    <!-- Database Age-Based Cleanup (Direct Delete or Backup to R2 + Delete) -->
                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-3">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div class="font-medium text-foreground">{{ t('cloud_hub.quota.cleanup_heading') }}</div>
                            <button
                                type="button"
                                class="rounded-md border border-border px-2.5 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
                                :disabled="loadingCleanupPreview || cleaningDb"
                                @click="loadCleanupPreview">
                                {{
                                    loadingCleanupPreview
                                        ? t('cloud_hub.quota.cleanup_loading')
                                        : t('cloud_hub.quota.cleanup_refresh')
                                }}
                            </button>
                        </div>

                        <div class="flex flex-wrap items-center gap-2.5">
                            <label class="text-[11px] font-medium text-muted-foreground">
                                {{ t('cloud_hub.quota.cleanup_months_label') }}
                            </label>
                            <select
                                v-model="cleanupMonthsPreset"
                                :disabled="cleaningDb"
                                class="rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground dark:[color-scheme:dark]">
                                <option class="bg-card text-foreground" value="1">
                                    {{ t('cloud_hub.quota.cleanup_months_opt', { months: 1 }) }}
                                </option>
                                <option class="bg-card text-foreground" value="3">
                                    {{ t('cloud_hub.quota.cleanup_months_opt', { months: 3 }) }}
                                </option>
                                <option class="bg-card text-foreground" value="6">
                                    {{ t('cloud_hub.quota.cleanup_months_opt', { months: 6 }) }}
                                </option>
                                <option class="bg-card text-foreground" value="12">
                                    {{ t('cloud_hub.quota.cleanup_months_opt', { months: 12 }) }}
                                </option>
                                <option class="bg-card text-foreground" value="24">
                                    {{ t('cloud_hub.quota.cleanup_months_opt', { months: 24 }) }}
                                </option>
                                <option class="bg-card text-foreground" value="custom">
                                    {{ t('cloud_hub.quota.cleanup_months_custom') }}
                                </option>
                            </select>
                            <div v-if="cleanupMonthsPreset === 'custom'" class="flex items-center gap-1.5">
                                <input
                                    v-model.number="cleanupCustomMonths"
                                    type="number"
                                    min="1"
                                    max="120"
                                    step="1"
                                    :disabled="cleaningDb"
                                    class="w-20 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground" />
                                <span class="text-[11px] text-muted-foreground">
                                    {{ t('cloud_hub.quota.cleanup_months_unit') }}
                                </span>
                            </div>
                            <label
                                v-if="quotaInfo?.legacyDbDedicated"
                                class="inline-flex items-center gap-1.5 text-[11px] text-foreground select-none cursor-pointer">
                                <input
                                    v-model="cleanupIncludeLegacy"
                                    type="checkbox"
                                    class="rounded border-input"
                                    :disabled="cleaningDb" />
                                <span>{{ t('cloud_hub.quota.cleanup_include_legacy') }}</span>
                            </label>
                        </div>

                        <div
                            v-if="cleanupPreview"
                            class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[11px] space-y-1">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <span class="text-muted-foreground">
                                    {{
                                        t('cloud_hub.quota.cleanup_cutoff_label', {
                                            date: cleanupPreview.cutoffIso.slice(0, 10)
                                        })
                                    }}
                                </span>
                                <span class="font-mono font-medium text-foreground">
                                    {{
                                        cleanupPreview.totalRows > 0
                                            ? t('cloud_hub.quota.cleanup_preview_count', {
                                                  rows: cleanupPreview.totalRows.toLocaleString()
                                              })
                                            : t('cloud_hub.quota.cleanup_nothing_to_clean')
                                    }}
                                </span>
                            </div>
                            <div
                                v-if="cleanupPreview.totalRows > 0"
                                class="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                                <span v-if="cleanupPreview.shards.gamelog > 0">
                                    DB_GAMELOG: {{ cleanupPreview.shards.gamelog.toLocaleString() }}
                                </span>
                                <span v-if="cleanupPreview.shards.feed > 0">
                                    DB_FEED: {{ cleanupPreview.shards.feed.toLocaleString() }}
                                </span>
                                <span v-if="cleanupPreview.shards.core > 0">
                                    DB_CORE: {{ cleanupPreview.shards.core.toLocaleString() }}
                                </span>
                                <span v-if="cleanupPreview.shards.legacy > 0">
                                    DB_LEGACY: {{ cleanupPreview.shards.legacy.toLocaleString() }}
                                </span>
                            </div>
                        </div>

                        <div class="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                class="rounded-md border border-destructive/40 px-3 py-1.5 font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                                :disabled="cleaningDb || !cleanupPreview || cleanupPreview.totalRows === 0"
                                @click="requestCleanupConfirm('delete')">
                                {{ t('cloud_hub.quota.cleanup_direct_btn') }}
                            </button>
                            <button
                                type="button"
                                class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                :disabled="
                                    cleaningDb ||
                                    !quotaInfo?.r2Enabled ||
                                    !cleanupPreview ||
                                    cleanupPreview.totalRows === 0
                                "
                                @click="requestCleanupConfirm('backup_and_delete')">
                                {{ t('cloud_hub.quota.cleanup_backup_r2_btn') }}
                            </button>
                            <span v-if="quotaInfo && !quotaInfo.r2Enabled" class="text-[11px] text-muted-foreground">
                                {{ t('cloud_hub.quota.cleanup_r2_unbound') }}
                            </span>
                        </div>

                        <div
                            v-if="pendingCleanupMode"
                            class="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                            <div class="text-[11px] font-medium text-foreground">
                                {{
                                    pendingCleanupMode === 'backup_and_delete'
                                        ? t('cloud_hub.quota.cleanup_confirm_backup_desc', {
                                              months: resolvedCleanupMonths,
                                              rows: (cleanupPreview?.totalRows ?? 0).toLocaleString()
                                          })
                                        : t('cloud_hub.quota.cleanup_confirm_direct_desc', {
                                              months: resolvedCleanupMonths,
                                              rows: (cleanupPreview?.totalRows ?? 0).toLocaleString()
                                          })
                                }}
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    class="rounded-md px-3 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                                    :class="
                                        pendingCleanupMode === 'backup_and_delete'
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-destructive'
                                    "
                                    :disabled="cleaningDb"
                                    @click="executeCleanup">
                                    {{
                                        cleaningDb
                                            ? t('cloud_hub.quota.cleanup_running')
                                            : t('cloud_hub.quota.cleanup_confirm_btn')
                                    }}
                                </button>
                                <button
                                    type="button"
                                    class="rounded-md border border-border px-3 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
                                    :disabled="cleaningDb"
                                    @click="pendingCleanupMode = ''">
                                    {{ t('cloud_hub.quota.cleanup_cancel_btn') }}
                                </button>
                            </div>
                        </div>

                        <p v-if="cleanupNotice" class="text-[11px] text-primary">{{ cleanupNotice }}</p>
                        <p v-if="cleanupError" class="text-[11px] text-destructive">{{ cleanupError }}</p>

                        <div v-if="quotaInfo?.r2Enabled && cleanupBackups.length > 0" class="space-y-1.5 pt-1">
                            <div class="text-[11px] font-medium text-muted-foreground">
                                {{ t('cloud_hub.quota.cleanup_r2_backups_heading', { count: cleanupBackups.length }) }}
                            </div>
                            <div
                                v-for="item in cleanupBackups"
                                :key="item.key"
                                class="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-2.5 py-1.5 text-[11px]">
                                <div class="min-w-0 truncate">
                                    <span class="font-mono text-foreground">{{ item.fileName }}</span>
                                    <span class="ml-2 text-muted-foreground">
                                        {{ formatBytes(item.bytes) }}
                                        <template v-if="item.totalRows > 0">
                                            · {{ item.totalRows.toLocaleString() }}
                                        </template>
                                    </span>
                                </div>
                                <a
                                    :href="`/api/admin/cleanup/backups/download?key=${encodeURIComponent(item.key)}`"
                                    class="shrink-0 rounded border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent">
                                    {{ t('cloud_hub.quota.cleanup_download_backup') }}
                                </a>
                            </div>
                        </div>
                    </div>

                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-2">
                        <div class="flex items-center justify-between">
                            <div>
                                <div class="font-medium text-foreground">{{ t('cloud_hub.quota.probe_heading') }}</div>
                                <div class="text-muted-foreground">
                                    {{ t('cloud_hub.quota.probe_desc_prefix')
                                    }}<span class="font-mono">{{
                                        cloudState.lastVrcRoute || t('cloud_hub.quota.route_idle')
                                    }}</span
                                    >{{ t('cloud_hub.quota.probe_desc_suffix') }}
                                </div>
                            </div>
                            <button
                                type="button"
                                class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                                @click="runWafProbe">
                                {{ t('cloud_hub.quota.run_probe') }}
                            </button>
                        </div>
                        <pre
                            v-if="wafProbeResult"
                            class="overflow-x-auto rounded bg-muted/60 p-2.5 font-mono text-[11px]"
                            >{{ wafProbeResult }}</pre>
                    </div>
                </div>
            </div>
        </div>
        </div>
    </Teleport>
</template>

<script setup>
    import { computed, onBeforeUnmount, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { cloudFetch } from '../../ipc-web/apiClient';
    import { saveCloudSyncIntervalSeconds } from '../../ipc-web/bootstrapCache';
    import { refreshCloudAuthAndBootstrap } from '../../ipc-web/index';
    import {
        applyCloudPresenceUpdate,
        clamp2faTrustSeconds,
        CLOUD_2FA_TRUST_PRESETS,
        cloudState,
        getAgentOnlineWindowMs,
        getOnlineAgentIds,
        MAX_CLOUD_2FA_TRUST_DAYS
    } from '../../ipc-web/cloudState';
    import { links } from '../../shared/constants/link';
    import { applyThemeColor, changeAppThemeStyle, changeHtmlLangAttribute } from '../../shared/utils/base/ui';
    import { loadLocalizedStrings } from '../../plugins/i18n';

    const { t, locale } = useI18n();
    const isWeb = typeof WEB !== 'undefined' && WEB;
    const cloudOriginUrl = typeof window !== 'undefined' ? window.location.origin : '';

    // Keep the unlock/2FA gate synced to server-configured appearance both on first mount
    // (before async appearanceSettings hydration completes) and if `/api/auth/me` succeeds on retry.
    watch(
        () => [
            cloudState.uiPreferences.themeMode,
            cloudState.uiPreferences.themeColor,
            cloudState.uiPreferences.appLanguage
        ],
        async ([themeMode, themeColor, appLanguage]) => {
            if (!isWeb || cloudState.authenticated || typeof document === 'undefined') return;
            if (themeMode) {
                const expectedDataTheme =
                    themeMode === 'system'
                        ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
                            ? 'dark'
                            : 'light'
                        : themeMode;
                if (document.documentElement.getAttribute('data-theme') !== expectedDataTheme) {
                    changeAppThemeStyle(themeMode);
                }
            }
            if (themeColor && document.documentElement.getAttribute('data-theme-color') !== themeColor) {
                await applyThemeColor(themeColor, { persist: false });
            }
            if (appLanguage && locale.value !== appLanguage) {
                await loadLocalizedStrings(appLanguage);
                locale.value = appLanguage;
                changeHtmlLangAttribute(appLanguage);
            }
        },
        { immediate: true }
    );

    const passcode = ref('');
    const staticPassphraseInput = ref('');
    const totpCode = ref('');
    const unlockError = ref('');
    const unlocking = ref(false);
    const retryingAuthCheck = ref(false);
    const trustPresetSelection = ref('604800');
    const customTrustDays = ref(7);

    const needsStandalone2faGate = computed(() =>
        Boolean(cloudState.primaryAuthenticated && cloudState.totpGateEnabled && !cloudState.totpVerified)
    );
    const needsStandaloneStaticPasscodeGate = computed(() =>
        Boolean(
            cloudState.primaryAuthenticated &&
                cloudState.staticPasscodeGateEnabled &&
                !cloudState.staticPasscodeVerified
        )
    );
    const isCombinedSecurityGate = computed(
        () => needsStandalone2faGate.value && needsStandaloneStaticPasscodeGate.value
    );
    const isStandaloneStaticPasscodeGate = computed(
        () => needsStandaloneStaticPasscodeGate.value && !needsStandalone2faGate.value
    );
    const isStandalone2faGate = computed(
        () => needsStandalone2faGate.value && !needsStandaloneStaticPasscodeGate.value
    );
    const isStandaloneSecurityGate = computed(
        () => needsStandalone2faGate.value || needsStandaloneStaticPasscodeGate.value
    );
    const needsStaticPasscodeInput = computed(() => needsStandaloneStaticPasscodeGate.value);
    const needsTotpInput = computed(() =>
        Boolean(
            needsStandalone2faGate.value ||
                (!isStandaloneSecurityGate.value && cloudState.requiresTotp)
        )
    );
    const showTrustDurationPicker = computed(() =>
        Boolean(
            isStandaloneSecurityGate.value ||
                (cloudState.totpGateEnabled && !cloudState.envTotpConfigured && cloudState.authMode === 'passcode_session')
        )
    );

    function syncTrustSelectionFromSeconds(seconds) {
        const clamped = clamp2faTrustSeconds(seconds);
        if (CLOUD_2FA_TRUST_PRESETS.includes(clamped)) {
            trustPresetSelection.value = String(clamped);
        } else {
            trustPresetSelection.value = 'custom';
            customTrustDays.value = Math.min(Math.max(Math.round(clamped / 86400), 1), MAX_CLOUD_2FA_TRUST_DAYS);
        }
    }

    function resolveSelectedTrustSeconds() {
        if (trustPresetSelection.value === 'custom') {
            const clampedDays = Math.min(Math.max(Math.floor(Number(customTrustDays.value) || 1), 1), MAX_CLOUD_2FA_TRUST_DAYS);
            return clamp2faTrustSeconds(clampedDays * 86400);
        }
        return clamp2faTrustSeconds(Number(trustPresetSelection.value));
    }

    watch(
        () =>
            isStandaloneStaticPasscodeGate.value
                ? cloudState.staticPasscodeDefaultTrustSeconds
                : cloudState.default2faTrustSeconds,
        (val) => {
            syncTrustSelectionFromSeconds(val);
        },
        { immediate: true }
    );

    const tabs = computed(() => [
        { id: 'devices', label: t('cloud_hub.tabs.devices') },
        { id: 'synced_devices', label: t('cloud_hub.tabs.synced_devices') },
        { id: 'commands', label: t('cloud_hub.tabs.commands') },
        { id: 'quota', label: t('cloud_hub.tabs.quota') }
    ]);
    const activeTab = ref('devices');

    const newDeviceName = ref('');
    const createdSyncKey = ref('');
    const createdDeviceName = ref('');
    const creatingSyncSecret = ref(false);
    const revokingDeviceId = ref('');
    const deviceActionError = ref('');
    const nowTick = ref(Date.now());
    let presenceTickTimer = null;
    const copiedField = ref('');
    const syncIntervalInput = ref(cloudState.syncIntervalSeconds || 60);
    const savingSyncInterval = ref(false);
    const syncIntervalNotice = ref('');
    const devices = ref([]);
    const launchUrlInput = ref('');
    const commandNotice = ref('');
    const commandHistory = ref([]);
    const quotaInfo = ref(null);
    const wafProbeResult = ref('');
    const cleanupMonthsPreset = ref('6');
    const cleanupCustomMonths = ref(6);
    const cleanupIncludeLegacy = ref(false);
    const cleanupPreview = ref(null);
    const loadingCleanupPreview = ref(false);
    const pendingCleanupMode = ref('');
    const cleaningDb = ref(false);
    const cleanupNotice = ref('');
    const cleanupError = ref('');
    const cleanupBackups = ref([]);

    const resolvedCleanupMonths = computed(() => {
        const raw =
            cleanupMonthsPreset.value === 'custom'
                ? Number(cleanupCustomMonths.value)
                : Number(cleanupMonthsPreset.value);
        if (!Number.isFinite(raw)) return 6;
        return Math.min(Math.max(Math.floor(raw), 1), 120);
    });

    watch(
        () => cloudState.syncIntervalSeconds,
        (val) => {
            syncIntervalInput.value = val || 60;
        }
    );

    async function saveSyncInterval() {
        savingSyncInterval.value = true;
        syncIntervalNotice.value = '';
        try {
            const saved = await saveCloudSyncIntervalSeconds(syncIntervalInput.value);
            syncIntervalInput.value = saved;
            syncIntervalNotice.value = t('cloud_hub.devices.saved_interval', { seconds: saved });
            setTimeout(() => {
                syncIntervalNotice.value = '';
            }, 3000);
        } catch (err) {
            syncIntervalNotice.value = t('cloud_hub.devices.save_failed', { error: err?.message || err });
        } finally {
            savingSyncInterval.value = false;
        }
    }

    const liveOnlineAgentsCount = computed(() => getOnlineAgentIds(nowTick.value).length);
    const recentSyncedCount = computed(() => devices.value.filter((d) => isRecentlySynced(d.last_seen_at)).length);

    function isRecentlySynced(lastSeenIso) {
        if (!lastSeenIso) return false;
        const ts = Date.parse(lastSeenIso);
        return Number.isFinite(ts) && nowTick.value - ts <= getAgentOnlineWindowMs();
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

    async function retryAuthCheck() {
        if (retryingAuthCheck.value) return;
        retryingAuthCheck.value = true;
        try {
            await refreshCloudAuthAndBootstrap();
            if (cloudState.authenticated) {
                window.location.reload();
            }
        } finally {
            retryingAuthCheck.value = false;
        }
    }

    function reloadForCloudflareAccess() {
        window.location.reload();
    }

    async function submitUnlock() {
        unlockError.value = '';
        unlocking.value = true;
        try {
            const cleanTotp = (totpCode.value || '').replace(/\s+/g, '');
            if (needsStandaloneStaticPasscodeGate.value) {
                const payload = {
                    passphrase: staticPassphraseInput.value,
                    trustSeconds: resolveSelectedTrustSeconds()
                };
                if (needsStandalone2faGate.value) {
                    payload.code = cleanTotp;
                }
                const res = await cloudFetch('/api/auth/static-passcode/verify', {
                    method: 'POST',
                    json: payload
                });
                cloudState.staticPasscodeVerified = true;
                cloudState.staticPasscodeTrustExpiresAt =
                    typeof res?.trustExpiresAt === 'string' ? res.trustExpiresAt : '';
                if (res?.totpVerified) {
                    cloudState.totpVerified = true;
                    cloudState.totpTrustExpiresAt =
                        typeof res?.totpTrustExpiresAt === 'string' ? res.totpTrustExpiresAt : '';
                }
                if (res?.authenticated === false) {
                    staticPassphraseInput.value = '';
                    totpCode.value = '';
                    await refreshCloudAuthAndBootstrap();
                    return;
                }
                cloudState.authenticated = true;
                window.location.reload();
                return;
            }
            if (needsStandalone2faGate.value) {
                const res = await cloudFetch('/api/auth/2fa/verify', {
                    method: 'POST',
                    json: {
                        code: cleanTotp,
                        trustSeconds: resolveSelectedTrustSeconds()
                    }
                });
                cloudState.totpVerified = true;
                cloudState.totpTrustExpiresAt = typeof res?.trustExpiresAt === 'string' ? res.trustExpiresAt : '';
                if (res?.authenticated === false) {
                    totpCode.value = '';
                    await refreshCloudAuthAndBootstrap();
                    return;
                }
                cloudState.authenticated = true;
                window.location.reload();
                return;
            }
            const loginPayload = {
                passcode: passcode.value,
                totp: cleanTotp || undefined
            };
            if (showTrustDurationPicker.value) {
                loginPayload.trustSeconds = resolveSelectedTrustSeconds();
            }
            const res = await cloudFetch('/api/auth/login', {
                method: 'POST',
                json: loginPayload
            });
            if (res?.authenticated === false) {
                passcode.value = '';
                staticPassphraseInput.value = '';
                totpCode.value = '';
                await refreshCloudAuthAndBootstrap();
                return;
            }
            cloudState.authenticated = true;
            window.location.reload();
        } catch (err) {
            cloudState.authenticated = false;
            unlockError.value = err?.message || t('cloud_hub.unlock.failed');
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
        try {
            const [list, hubStatus] = await Promise.all([
                cloudFetch('/api/agent/devices'),
                cloudFetch('/api/agent/status').catch(() => null)
            ]);
            if (!Array.isArray(list)) return;
            devices.value = list;
            const deviceLastSeen = {};
            for (const dev of list) {
                if (dev?.device_id && dev?.last_seen_at) {
                    const ts = Date.parse(dev.last_seen_at);
                    if (Number.isFinite(ts)) {
                        deviceLastSeen[dev.device_id] = ts;
                    }
                }
            }
            applyCloudPresenceUpdate({
                deviceLastSeen,
                wsAgentsOnline: Array.isArray(hubStatus?.agentsOnline) ? hubStatus.agentsOnline : undefined,
                deviceStates:
                    hubStatus?.deviceStates && typeof hubStatus.deviceStates === 'object'
                        ? hubStatus.deviceStates
                        : undefined,
                replaceDeviceMap: true
            });
        } catch (err) {
            console.warn('[cloud] Failed to load paired devices:', err);
        }
    }

    async function createSyncSecret() {
        if (creatingSyncSecret.value) return;
        creatingSyncSecret.value = true;
        deviceActionError.value = '';
        try {
            const name = (newDeviceName.value || '').trim() || t('cloud_hub.devices.default_device_name');
            const data = await cloudFetch('/api/agent/sync-key', {
                method: 'POST',
                json: { deviceName: name }
            });
            createdSyncKey.value = data.syncKey;
            createdDeviceName.value = data.deviceName || name;
            await loadDevices();
        } catch (err) {
            deviceActionError.value = err?.message || String(err);
        } finally {
            creatingSyncSecret.value = false;
        }
    }

    async function revokeDevice(deviceId) {
        if (!deviceId || revokingDeviceId.value) return;
        revokingDeviceId.value = deviceId;
        deviceActionError.value = '';
        try {
            await cloudFetch(`/api/agent/devices?deviceId=${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
            delete cloudState.deviceStates[deviceId];
            delete cloudState.deviceLastSeen[deviceId];
            cloudState.wsAgentsOnline = cloudState.wsAgentsOnline.filter((id) => id !== deviceId);
            await loadDevices();
        } catch (err) {
            deviceActionError.value = err?.message || String(err);
        } finally {
            revokingDeviceId.value = '';
        }
    }

    async function loadCommands() {
        commandHistory.value = await cloudFetch('/api/commands?limit=25').catch(() => []);
    }

    async function sendCommand(action, params) {
        commandNotice.value = t('cloud_hub.commands.sending', { action });
        try {
            const res = await cloudFetch('/api/commands', {
                method: 'POST',
                json: { action, params }
            });
            commandNotice.value =
                res.status === 'queued'
                    ? t('cloud_hub.commands.queued', { action, cmdId: res.cmdId })
                    : t('cloud_hub.commands.dispatched', { action, cmdId: res.cmdId });
        } catch (err) {
            commandNotice.value = t('cloud_hub.commands.failed', {
                error: err?.message || t('cloud_hub.commands.unknown_error')
            });
        }
        await loadCommands();
    }

    async function loadQuota() {
        quotaInfo.value = await cloudFetch('/api/admin/quota').catch(() => null);
    }

    async function loadCleanupPreview() {
        loadingCleanupPreview.value = true;
        cleanupError.value = '';
        try {
            const months = resolvedCleanupMonths.value;
            const inc = cleanupIncludeLegacy.value ? '1' : '0';
            cleanupPreview.value = await cloudFetch(
                `/api/admin/cleanup/preview?months=${months}&includeLegacy=${inc}`
            );
        } catch (err) {
            cleanupError.value = err?.message || String(err);
        } finally {
            loadingCleanupPreview.value = false;
        }
    }

    async function loadCleanupBackups() {
        try {
            const data = await cloudFetch('/api/admin/cleanup/backups');
            cleanupBackups.value = Array.isArray(data?.backups) ? data.backups : [];
        } catch {
            cleanupBackups.value = [];
        }
    }

    function requestCleanupConfirm(mode) {
        cleanupNotice.value = '';
        cleanupError.value = '';
        pendingCleanupMode.value = mode;
    }

    async function executeCleanup() {
        const mode = pendingCleanupMode.value;
        if (!mode || cleaningDb.value) return;
        cleaningDb.value = true;
        cleanupError.value = '';
        cleanupNotice.value = '';
        try {
            const months = resolvedCleanupMonths.value;
            const includeLegacy = cleanupIncludeLegacy.value;
            let totalDeleted = 0;
            let totalBackedUp = 0;
            let backupCount = 0;
            let lastFileName = '';
            let truncated = false;

            for (let round = 0; round < 20; round++) {
                const res = await cloudFetch('/api/admin/cleanup', {
                    method: 'POST',
                    json: { months, mode, includeLegacy }
                });
                totalDeleted += Number(res?.deletedRows || 0);
                totalBackedUp += Number(res?.backedUpRows || 0);
                if (res?.backupFileName) {
                    backupCount++;
                    lastFileName = res.backupFileName;
                }
                if (!res?.hasMore) break;
                if (round === 19) truncated = true;
            }

            pendingCleanupMode.value = '';
            if (mode === 'backup_and_delete') {
                cleanupNotice.value =
                    backupCount > 1
                        ? t('cloud_hub.quota.cleanup_done_backup_multi', {
                              rows: totalDeleted.toLocaleString(),
                              files: backupCount
                          })
                        : t('cloud_hub.quota.cleanup_done_backup', {
                              rows: totalDeleted.toLocaleString(),
                              file: lastFileName || `${totalBackedUp}`
                          });
                if (truncated) {
                    cleanupNotice.value += ` ${t('cloud_hub.quota.cleanup_more_remaining')}`;
                }
            } else {
                cleanupNotice.value = t('cloud_hub.quota.cleanup_done_direct', {
                    rows: totalDeleted.toLocaleString()
                });
            }

            await Promise.all([loadQuota(), loadCleanupPreview(), loadCleanupBackups()]);
        } catch (err) {
            cleanupError.value = err?.message || String(err);
        } finally {
            cleaningDb.value = false;
        }
    }

    watch([cleanupMonthsPreset, cleanupCustomMonths, cleanupIncludeLegacy], () => {
        pendingCleanupMode.value = '';
        if (cloudState.hubDialogOpen && activeTab.value === 'quota') {
            loadCleanupPreview();
        }
    });

    async function runWafProbe() {
        wafProbeResult.value = t('cloud_hub.quota.probing');
        try {
            const res = await cloudFetch('/poc/vrc-probe');
            wafProbeResult.value = JSON.stringify(res, null, 2);
        } catch (err) {
            wafProbeResult.value = t('cloud_hub.quota.probe_error', { error: err?.message || err });
        }
    }

    function selectTab(id) {
        activeTab.value = id;
        if (id === 'devices' || id === 'synced_devices') loadDevices();
        else if (id === 'commands') loadCommands();
        else if (id === 'quota') {
            loadQuota();
            loadCleanupPreview();
            loadCleanupBackups();
        }
    }

    function stopPresenceTick() {
        if (presenceTickTimer) {
            clearInterval(presenceTickTimer);
            presenceTickTimer = null;
        }
    }

    watch(
        () => cloudState.hubDialogOpen,
        (open) => {
            if (open) {
                nowTick.value = Date.now();
                stopPresenceTick();
                presenceTickTimer = setInterval(() => {
                    nowTick.value = Date.now();
                }, 15_000);
                selectTab(activeTab.value);
            } else {
                stopPresenceTick();
                // Clear sensitive one-time sync key and transient errors whenever the Hub closes or session expires.
                createdSyncKey.value = '';
                createdDeviceName.value = '';
                deviceActionError.value = '';
                copiedField.value = '';
                pendingCleanupMode.value = '';
                cleanupError.value = '';
                cleanupNotice.value = '';
            }
        }
    );

    onBeforeUnmount(() => {
        stopPresenceTick();
    });
</script>
