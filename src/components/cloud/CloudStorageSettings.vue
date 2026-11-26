<template>
    <div class="flex flex-col gap-10">
        <!-- Group 1: Cloud Databases (D1 Quota & Age-Based Cleanup) -->
        <SettingsGroup :title="t('cloud_hub.storage.db_section_title')">
            <div class="space-y-4 py-1 text-xs">
                <!-- D1 Shard Usage Cards -->
                <div v-if="quotaInfo?.databases" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div
                        v-for="(info, key) in quotaInfo.databases"
                        :key="key"
                        class="rounded-lg border border-border bg-card/60 p-3 space-y-1.5">
                        <div class="font-mono font-semibold uppercase text-foreground">DB_{{ key }}</div>
                        <div class="text-sm font-bold font-mono text-foreground">
                            {{ formatBytes(info.bytes) }} / 500 MB
                        </div>
                        <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                                class="h-full rounded-full bg-primary transition-all duration-200"
                                :style="{ width: Math.min(100, info.percentOfFreeLimit) + '%' }" />
                        </div>
                        <div class="text-[11px] text-muted-foreground">
                            {{ t('cloud_hub.quota.shard_percent', { percent: info.percentOfFreeLimit }) }}
                        </div>
                    </div>
                </div>

                <!-- Database Age-Based Cleanup (Direct Delete / Backup to R2 / Backup to B2) -->
                <div class="rounded-lg border border-border bg-card/60 p-4 space-y-3">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="font-medium text-sm text-foreground">{{ t('cloud_hub.quota.cleanup_heading') }}</div>
                        <Button
                            size="sm"
                            variant="outline"
                            :disabled="loadingCleanupPreview || cleaningDb"
                            @click="refreshDatabaseSection">
                            {{
                                loadingCleanupPreview
                                    ? t('cloud_hub.quota.cleanup_loading')
                                    : t('cloud_hub.quota.cleanup_refresh')
                            }}
                        </Button>
                    </div>

                    <div class="flex flex-wrap items-center gap-2.5">
                        <label class="text-[11px] font-medium text-muted-foreground">
                            {{ t('cloud_hub.quota.cleanup_months_label') }}
                        </label>
                        <select
                            v-model="cleanupMonthsPreset"
                            :disabled="cleaningDb"
                            class="rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground dark:[color-scheme:dark]">
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
                            @click="requestCleanupConfirm('delete', 'auto')">
                            {{ t('cloud_hub.quota.cleanup_direct_btn') }}
                        </button>
                        <button
                            type="button"
                            class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                            :disabled="
                                cleaningDb ||
                                (!quotaInfo?.r2Enabled && !cleanupPreview?.b2Enabled) ||
                                !cleanupPreview ||
                                cleanupPreview.totalRows === 0
                            "
                            @click="requestCleanupConfirm('backup_and_delete', 'auto')">
                            {{ t('cloud_hub.quota.cleanup_backup_r2_btn') }}
                        </button>
                        <button
                            v-if="cleanupPreview?.b2Enabled"
                            type="button"
                            class="rounded-md border border-primary/50 px-3 py-1.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                            :disabled="cleaningDb || !cleanupPreview || cleanupPreview.totalRows === 0"
                            @click="requestCleanupConfirm('backup_and_delete', 'b2')">
                            {{ t('cloud_hub.quota.cleanup_backup_b2_btn') }}
                        </button>
                        <span
                            v-if="quotaInfo && !quotaInfo.r2Enabled && !cleanupPreview?.b2Enabled"
                            class="text-[11px] text-muted-foreground">
                            {{ t('cloud_hub.quota.cleanup_r2_unbound') }}
                        </span>
                    </div>

                    <div
                        v-if="pendingCleanupMode"
                        class="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                        <div class="text-[11px] font-medium text-foreground">
                            {{
                                pendingCleanupMode === 'backup_and_delete'
                                    ? pendingCleanupTarget === 'b2' || cleanupPreview?.overflowActive
                                        ? t('cloud_hub.quota.cleanup_confirm_backup_b2_desc', {
                                              months: resolvedCleanupMonths,
                                              rows: (cleanupPreview?.totalRows ?? 0).toLocaleString()
                                          })
                                        : t('cloud_hub.quota.cleanup_confirm_backup_desc', {
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

                    <div v-if="cleanupBackups.length > 0" class="space-y-1.5 pt-1">
                        <div class="text-[11px] font-medium text-muted-foreground">
                            {{ t('cloud_hub.quota.cleanup_r2_backups_heading', { count: cleanupBackups.length }) }}
                        </div>
                        <div
                            v-for="item in cleanupBackups"
                            :key="item.key"
                            class="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-2.5 py-1.5 text-[11px]">
                            <div class="min-w-0 flex items-center gap-1.5 truncate">
                                <span
                                    class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase"
                                    :class="
                                        item.provider === 'b2'
                                            ? 'bg-primary/15 text-primary'
                                            : 'bg-muted text-muted-foreground'
                                    ">
                                    {{ item.provider === 'b2' ? 'B2' : 'R2' }}
                                </span>
                                <span class="truncate font-mono text-foreground">{{ item.fileName }}</span>
                                <span class="shrink-0 text-muted-foreground">
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
            </div>
        </SettingsGroup>

        <!-- Group 2: Object Storage (Cloudflare R2 & Backblaze B2) -->
        <SettingsGroup :title="t('cloud_hub.storage.section_title')">
            <div class="space-y-4 py-1 text-xs">
                <!-- 1. Primary Cloudflare R2 Storage Usage -->
                <div class="rounded-lg border border-border bg-card/60 p-4 space-y-3">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                            <span class="font-medium text-sm text-foreground">{{ t('cloud_hub.storage.r2_title') }}</span>
                            <span
                                class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                                :class="
                                    r2Usage?.bound
                                        ? 'border-status-online/40 bg-status-online/10 text-foreground'
                                        : 'border-border bg-muted/50 text-muted-foreground'
                                ">
                                <span
                                    class="inline-block size-1.5 rounded-full"
                                    :class="r2Usage?.bound ? 'bg-status-online' : 'bg-muted-foreground/60'" />
                                {{
                                    r2Usage?.bound
                                        ? t('cloud_hub.storage.status_bound')
                                        : t('cloud_hub.storage.status_unbound')
                                }}
                            </span>
                            <span
                                v-if="overflowActive"
                                class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                                {{ t('cloud_hub.storage.overflow_active_badge') }}
                            </span>
                        </div>
                        <Button size="sm" variant="outline" :disabled="loadingStatus" @click="loadStatus(true)">
                            {{
                                loadingStatus
                                    ? t('cloud_hub.storage.refreshing')
                                    : t('cloud_hub.storage.refresh_usage_btn')
                            }}
                        </Button>
                    </div>

                    <div v-if="r2Usage?.bound" class="space-y-2">
                        <div class="flex flex-wrap items-baseline justify-between gap-2">
                            <span class="text-sm font-semibold font-mono text-foreground">
                                {{ formatBytes(r2Usage.usedBytes) }} / {{ formatBytes(r2Usage.freeLimitBytes) }}
                            </span>
                            <span class="font-mono text-[11px] text-muted-foreground">
                                {{
                                    t('cloud_hub.storage.usage_meta', {
                                        percent: r2Usage.percent,
                                        count: r2Usage.objectCount.toLocaleString()
                                    })
                                }}
                            </span>
                        </div>
                        <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
                            <div
                                class="h-full rounded-full transition-all duration-200"
                                :class="overflowActive ? 'bg-amber-500' : 'bg-primary'"
                                :style="{ width: `${Math.min(100, r2Usage.percent)}%` }" />
                        </div>
                        <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                            <span>
                                {{
                                    t('cloud_hub.storage.breakdown_screenshots', {
                                        size: formatBytes(r2Usage.screenshotsBytes),
                                        count: r2Usage.screenshotsCount.toLocaleString()
                                    })
                                }}
                            </span>
                            <span>
                                {{
                                    t('cloud_hub.storage.breakdown_backups', {
                                        size: formatBytes(r2Usage.backupsBytes),
                                        count: r2Usage.backupsCount.toLocaleString()
                                    })
                                }}
                            </span>
                        </div>
                    </div>
                    <div v-else class="text-[11px] text-muted-foreground">
                        {{ t('cloud_hub.storage.r2_unbound_hint') }}
                    </div>
                </div>

                <!-- 2. Optional External Storage (Backblaze B2, Disabled by Default) -->
                <div class="rounded-lg border border-border bg-card/60 p-4 space-y-4">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="font-medium text-sm text-foreground">{{ t('cloud_hub.storage.b2_title') }}</span>
                            <span
                                class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                                :class="
                                    formEnabled
                                        ? 'border-status-online/40 bg-status-online/10 text-foreground'
                                        : 'border-border bg-muted/50 text-muted-foreground'
                                ">
                                <span
                                    class="inline-block size-1.5 rounded-full"
                                    :class="formEnabled ? 'bg-status-online' : 'bg-muted-foreground/60'" />
                                {{
                                    formEnabled
                                        ? t('cloud_hub.storage.status_enabled')
                                        : t('cloud_hub.storage.status_disabled')
                                }}
                            </span>
                            <a
                                href="https://secure.backblaze.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="text-[11px] text-primary hover:underline">
                                secure.backblaze.com
                            </a>
                        </div>
                        <Switch
                            :model-value="formEnabled"
                            :disabled="savingConfig"
                            :aria-label="t('cloud_hub.storage.enable_extra_label')"
                            @update:model-value="onToggleExtraStorage" />
                    </div>

                    <template v-if="formEnabled">
                        <!-- Backblaze B2 Usage Meter (shown when B2 is enabled / configured) -->
                        <div
                            v-if="b2Usage?.bound"
                            class="rounded-md border border-border/70 bg-muted/30 p-3 space-y-2">
                            <div class="flex flex-wrap items-baseline justify-between gap-2">
                                <span class="font-medium text-foreground">{{ t('cloud_hub.storage.b2_usage_heading') }}</span>
                                <span v-if="!b2Usage.error" class="font-mono text-[11px] text-muted-foreground">
                                    {{
                                        t('cloud_hub.storage.usage_meta', {
                                            percent: b2Usage.percent,
                                            count: b2Usage.objectCount.toLocaleString()
                                        })
                                    }}
                                </span>
                            </div>
                            <template v-if="b2Usage.error">
                                <p class="text-[11px] text-destructive break-all">{{ b2Usage.error }}</p>
                            </template>
                            <template v-else>
                                <div class="font-mono text-sm font-semibold text-foreground">
                                    {{ formatBytes(b2Usage.usedBytes) }} / {{ formatBytes(b2Usage.freeLimitBytes) }}
                                </div>
                                <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
                                    <div
                                        class="h-full rounded-full bg-primary transition-all duration-200"
                                        :style="{ width: `${Math.min(100, b2Usage.percent)}%` }" />
                                </div>
                                <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                                    <span>
                                        {{
                                            t('cloud_hub.storage.breakdown_screenshots', {
                                                size: formatBytes(b2Usage.screenshotsBytes),
                                                count: b2Usage.screenshotsCount.toLocaleString()
                                            })
                                        }}
                                    </span>
                                    <span>
                                        {{
                                            t('cloud_hub.storage.breakdown_backups', {
                                                size: formatBytes(b2Usage.backupsBytes),
                                                count: b2Usage.backupsCount.toLocaleString()
                                            })
                                        }}
                                    </span>
                                </div>
                            </template>
                        </div>

                        <!-- Built-in Cloudflare Workers Direct Proxy Status (auto-enabled once B2 is configured) -->
                        <div
                            v-if="b2DirectProxyEnabled"
                            class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/25 bg-primary/5 px-3 py-2">
                            <div class="min-w-0 flex flex-wrap items-center gap-2">
                                <span class="font-medium text-foreground">
                                    {{ t('cloud_hub.storage.direct_proxy_label') }}
                                </span>
                                <span
                                    class="rounded bg-status-online/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                                    {{ t('cloud_hub.storage.direct_proxy_active') }}
                                </span>
                                <code class="truncate font-mono text-[11px] text-muted-foreground">{{
                                    b2DirectProxyUrl
                                }}</code>
                            </div>
                            <button
                                type="button"
                                class="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent"
                                @click="copyDirectProxyUrl">
                                {{
                                    copiedDirectProxyUrl
                                        ? t('cloud_hub.storage.direct_proxy_copied')
                                        : t('cloud_hub.storage.direct_proxy_copy')
                                }}
                            </button>
                        </div>

                        <!-- Overflow Threshold & B2 S3-Compatible Credentials -->
                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div class="space-y-1 sm:col-span-2">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.threshold_label') }}
                                </label>
                                <div class="flex flex-wrap items-center gap-2">
                                    <input
                                        v-model.number="formThresholdGb"
                                        type="number"
                                        min="0.1"
                                        max="10"
                                        step="0.5"
                                        :disabled="savingConfig"
                                        class="w-28 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                                    <span class="text-muted-foreground">GB / 10 GB</span>
                                </div>
                            </div>

                            <div class="space-y-1 sm:col-span-2">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.endpoint_label') }}
                                </label>
                                <input
                                    v-model="formEndpoint"
                                    type="text"
                                    placeholder="https://s3.us-west-004.backblazeb2.com"
                                    :disabled="savingConfig"
                                    class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                            </div>

                            <div class="space-y-1">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.bucket_label') }}
                                </label>
                                <input
                                    v-model="formBucket"
                                    type="text"
                                    placeholder="vrcx-backup-bucket"
                                    :disabled="savingConfig"
                                    class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                            </div>

                            <div class="space-y-1">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.region_label') }}
                                </label>
                                <input
                                    v-model="formRegion"
                                    type="text"
                                    :placeholder="t('cloud_hub.storage.region_placeholder')"
                                    :disabled="savingConfig"
                                    class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                            </div>

                            <div class="space-y-1">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.key_id_label') }}
                                </label>
                                <input
                                    v-model="formAccessKeyId"
                                    type="text"
                                    autocomplete="off"
                                    :disabled="savingConfig"
                                    class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                            </div>

                            <div class="space-y-1">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.app_key_label') }}
                                </label>
                                <input
                                    v-model="formSecretAccessKey"
                                    type="password"
                                    autocomplete="new-password"
                                    :placeholder="
                                        hasSavedSecret
                                            ? t('cloud_hub.storage.app_key_saved_placeholder')
                                            : t('cloud_hub.storage.app_key_placeholder')
                                    "
                                    :disabled="savingConfig"
                                    class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                            </div>

                            <div class="space-y-1 sm:col-span-2">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.prefix_label') }}
                                </label>
                                <input
                                    v-model="formKeyPrefix"
                                    type="text"
                                    placeholder="vrcx"
                                    :disabled="savingConfig"
                                    class="w-64 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                            </div>
                        </div>

                        <div class="flex flex-wrap items-center gap-2 pt-1">
                            <Button size="sm" :disabled="savingConfig" @click="saveConfig">
                                {{ savingConfig ? t('cloud_hub.storage.saving') : t('cloud_hub.storage.save_btn') }}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                :disabled="testingB2 || savingConfig"
                                @click="testB2Connection">
                                {{ testingB2 ? t('cloud_hub.storage.testing') : t('cloud_hub.storage.test_btn') }}
                            </Button>
                        </div>
                    </template>

                    <p v-if="statusNotice" class="text-[11px] text-primary">{{ statusNotice }}</p>
                    <p v-if="statusError" class="text-[11px] text-destructive break-all">{{ statusError }}</p>
                </div>
            </div>
        </SettingsGroup>
    </div>
</template>

<script setup>
    import { computed, onMounted, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';
    import { Button } from '@/components/ui/button';
    import { Switch } from '@/components/ui/switch';
    import SettingsGroup from '@/views/Settings/components/SettingsGroup.vue';
    import { cloudFetch } from '@/ipc-web/apiClient';
    import { cloudState } from '@/ipc-web/cloudState';

    const { t } = useI18n();

    // --- D1 Quota & Cleanup State ---
    const quotaInfo = ref(null);
    const cleanupMonthsPreset = ref('6');
    const cleanupCustomMonths = ref(6);
    const cleanupIncludeLegacy = ref(false);
    const cleanupPreview = ref(null);
    const loadingCleanupPreview = ref(false);
    const pendingCleanupMode = ref('');
    const pendingCleanupTarget = ref('auto');
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

    // --- Object Storage (R2 & Backblaze B2) State ---
    const loadingStatus = ref(false);
    const savingConfig = ref(false);
    const testingB2 = ref(false);

    const r2Usage = ref(null);
    const b2Usage = ref(null);
    const overflowActive = ref(false);
    const hasSavedSecret = ref(false);
    const savedEnabled = ref(false);
    const b2DirectProxyEnabled = ref(false);
    const b2DirectProxyBasePath = ref('/api/storage/b2/');
    const copiedDirectProxyUrl = ref(false);

    const b2DirectProxyUrl = computed(() => {
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        return `${origin}${b2DirectProxyBasePath.value}`;
    });

    const formEnabled = ref(false);
    const formThresholdGb = ref(9);
    const formEndpoint = ref('');
    const formBucket = ref('');
    const formRegion = ref('');
    const formAccessKeyId = ref('');
    const formSecretAccessKey = ref('');
    const formKeyPrefix = ref('');

    const statusNotice = ref('');
    const statusError = ref('');

    function formatBytes(bytes) {
        const n = Number(bytes || 0);
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
        return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    async function loadQuota() {
        if (!cloudState.authenticated) return;
        quotaInfo.value = await cloudFetch('/api/admin/quota').catch(() => null);
    }

    async function loadCleanupPreview() {
        if (!cloudState.authenticated) return;
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
        if (!cloudState.authenticated) return;
        try {
            const data = await cloudFetch('/api/admin/cleanup/backups');
            cleanupBackups.value = Array.isArray(data?.backups) ? data.backups : [];
        } catch {
            cleanupBackups.value = [];
        }
    }

    async function refreshDatabaseSection() {
        await Promise.all([loadQuota(), loadCleanupPreview(), loadCleanupBackups()]);
    }

    function requestCleanupConfirm(mode, target = 'auto') {
        cleanupNotice.value = '';
        cleanupError.value = '';
        pendingCleanupMode.value = mode;
        pendingCleanupTarget.value = target;
    }

    async function executeCleanup() {
        const mode = pendingCleanupMode.value;
        const backupTarget = pendingCleanupTarget.value || 'auto';
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
            let lastProvider = '';
            let truncated = false;

            for (let round = 0; round < 20; round++) {
                const res = await cloudFetch('/api/admin/cleanup', {
                    method: 'POST',
                    json: { months, mode, includeLegacy, backupTarget }
                });
                totalDeleted += Number(res?.deletedRows || 0);
                totalBackedUp += Number(res?.backedUpRows || 0);
                if (res?.backupFileName) {
                    backupCount++;
                    lastFileName = res.backupFileName;
                    lastProvider = res.backupProvider === 'b2' ? 'Backblaze B2' : 'R2';
                }
                if (!res?.hasMore) break;
                if (round === 19) truncated = true;
            }

            pendingCleanupMode.value = '';
            if (mode === 'backup_and_delete') {
                const targetLabel = lastProvider || (backupTarget === 'b2' ? 'Backblaze B2' : 'R2');
                cleanupNotice.value =
                    backupCount > 1
                        ? t('cloud_hub.quota.cleanup_done_backup_multi', {
                              target: targetLabel,
                              rows: totalDeleted.toLocaleString(),
                              files: backupCount
                          })
                        : t('cloud_hub.quota.cleanup_done_backup', {
                              target: targetLabel,
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
            toast.success(cleanupNotice.value);

            await Promise.all([
                loadQuota(),
                loadCleanupPreview(),
                loadCleanupBackups(),
                mode === 'backup_and_delete' ? loadStatus(true) : Promise.resolve()
            ]);
        } catch (err) {
            cleanupError.value = err?.message || String(err);
            toast.error(cleanupError.value);
        } finally {
            cleaningDb.value = false;
        }
    }

    watch([cleanupMonthsPreset, cleanupCustomMonths, cleanupIncludeLegacy], () => {
        pendingCleanupMode.value = '';
        loadCleanupPreview();
    });

    function applyStatusPayload(data) {
        if (!data) return;
        r2Usage.value = data.r2 ?? null;
        b2Usage.value = data.b2 ?? null;
        overflowActive.value = Boolean(data.overflowActive);
        b2DirectProxyEnabled.value = Boolean(data.b2DirectProxy?.enabled);
        if (typeof data.b2DirectProxy?.basePath === 'string' && data.b2DirectProxy.basePath) {
            b2DirectProxyBasePath.value = data.b2DirectProxy.basePath;
        }
        const ext = data.externalStorage;
        if (ext) {
            savedEnabled.value = Boolean(ext.enabled);
            formEnabled.value = Boolean(ext.enabled);
            formEndpoint.value = ext.endpoint || '';
            formBucket.value = ext.bucket || '';
            formRegion.value = ext.region || '';
            formAccessKeyId.value = ext.accessKeyId || '';
            formKeyPrefix.value = (ext.keyPrefix || '').replace(/\/+$/, '');
            hasSavedSecret.value = Boolean(ext.hasSecretKey);
            const gb = Number(ext.r2OverflowThresholdBytes || 0) / (1024 * 1024 * 1024);
            formThresholdGb.value = Number.isFinite(gb) && gb > 0 ? Number(gb.toFixed(2)) : 9;
        }
    }

    async function loadStatus(forceRefresh = false) {
        if (!cloudState.authenticated) return;
        loadingStatus.value = true;
        statusError.value = '';
        try {
            const data = await cloudFetch(`/api/storage/status${forceRefresh ? '?refresh=1' : ''}`);
            applyStatusPayload(data);
        } catch (err) {
            statusError.value = err?.message || String(err);
        } finally {
            loadingStatus.value = false;
        }
    }

    async function copyDirectProxyUrl() {
        try {
            await navigator.clipboard.writeText(b2DirectProxyUrl.value);
            copiedDirectProxyUrl.value = true;
            setTimeout(() => {
                copiedDirectProxyUrl.value = false;
            }, 2000);
        } catch {
            // Clipboard permission unavailable
        }
    }

    async function onToggleExtraStorage(nextEnabled) {
        formEnabled.value = Boolean(nextEnabled);
        statusError.value = '';
        statusNotice.value = '';
        // When collapsing a previously enabled config, persist disabled state immediately
        // while keeping saved encrypted B2 credentials intact on the server.
        if (!formEnabled.value && savedEnabled.value) {
            if (savingConfig.value) return;
            savingConfig.value = true;
            try {
                const data = await cloudFetch('/api/storage/config', {
                    method: 'PUT',
                    json: { enabled: false }
                });
                applyStatusPayload(data);
                const msg = t('cloud_hub.storage.saved_toast');
                statusNotice.value = msg;
                toast.success(msg);
                await Promise.all([loadCleanupPreview(), loadCleanupBackups()]);
            } catch (err) {
                formEnabled.value = true;
                statusError.value = err?.message || String(err);
                toast.error(statusError.value);
            } finally {
                savingConfig.value = false;
            }
        }
    }

    async function saveConfig() {
        if (savingConfig.value) return;
        savingConfig.value = true;
        statusError.value = '';
        statusNotice.value = '';
        try {
            const data = await cloudFetch('/api/storage/config', {
                method: 'PUT',
                json: {
                    enabled: formEnabled.value,
                    r2OverflowThresholdGb: Number(formThresholdGb.value) || 9,
                    endpoint: formEndpoint.value.trim(),
                    bucket: formBucket.value.trim(),
                    region: formRegion.value.trim(),
                    keyPrefix: formKeyPrefix.value.trim(),
                    accessKeyId: formAccessKeyId.value.trim(),
                    ...(formSecretAccessKey.value.trim()
                        ? { secretAccessKey: formSecretAccessKey.value.trim() }
                        : {})
                }
            });
            formSecretAccessKey.value = '';
            applyStatusPayload(data);
            const msg = t('cloud_hub.storage.saved_toast');
            statusNotice.value = msg;
            toast.success(msg);
            // Sync database cleanup panel (B2 backup button & combined backup list) immediately.
            await Promise.all([loadCleanupPreview(), loadCleanupBackups()]);
        } catch (err) {
            statusError.value = err?.message || String(err);
            toast.error(statusError.value);
        } finally {
            savingConfig.value = false;
        }
    }

    async function testB2Connection() {
        if (testingB2.value) return;
        testingB2.value = true;
        statusError.value = '';
        statusNotice.value = '';
        try {
            const data = await cloudFetch('/api/storage/test', {
                method: 'POST',
                json: {
                    endpoint: formEndpoint.value.trim(),
                    bucket: formBucket.value.trim(),
                    region: formRegion.value.trim(),
                    keyPrefix: formKeyPrefix.value.trim(),
                    accessKeyId: formAccessKeyId.value.trim(),
                    ...(formSecretAccessKey.value.trim()
                        ? { secretAccessKey: formSecretAccessKey.value.trim() }
                        : {})
                }
            });
            statusNotice.value = t('cloud_hub.storage.test_ok', {
                ms: data.latencyMs,
                size: formatBytes(data.usedBytes),
                count: Number(data.objectCount || 0).toLocaleString()
            });
            toast.success(statusNotice.value);
        } catch (err) {
            statusError.value = err?.message || String(err);
            toast.error(statusError.value);
        } finally {
            testingB2.value = false;
        }
    }

    onMounted(() => {
        Promise.all([loadQuota(), loadCleanupPreview(), loadCleanupBackups(), loadStatus(true)]);
    });
</script>
