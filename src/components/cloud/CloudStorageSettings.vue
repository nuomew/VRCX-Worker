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

                <!-- External Database (MySQL 5.7+ Hybrid Overflow / Full Migration) -->
                <div class="rounded-lg border border-border bg-card/60 p-4 space-y-3">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="font-medium text-sm text-foreground">
                                {{ t('cloud_hub.storage.mysql_title') }}
                            </span>
                            <span
                                class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                                :class="
                                    mysqlSavedEnabled
                                        ? 'border-status-online/40 bg-status-online/10 text-foreground'
                                        : mysqlFormEnabled
                                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                          : 'border-border bg-muted/40 text-muted-foreground'
                                ">
                                <span
                                    class="inline-block size-1.5 rounded-full"
                                    :class="
                                        mysqlSavedEnabled
                                            ? 'bg-status-online'
                                            : mysqlFormEnabled
                                              ? 'bg-amber-500'
                                              : 'bg-muted-foreground/60'
                                    " />
                                {{
                                    mysqlSavedEnabled
                                        ? mysqlSavedMode === 'full_migrate'
                                            ? t('cloud_hub.storage.mysql_status_full')
                                            : t('cloud_hub.storage.mysql_status_hybrid')
                                        : mysqlFormEnabled
                                          ? t('cloud_hub.storage.status_unsaved')
                                          : t('cloud_hub.storage.status_disabled')
                                }}
                            </span>
                        </div>
                        <div class="flex items-center gap-2">
                            <Button
                                v-if="mysqlSavedEnabled"
                                size="sm"
                                variant="outline"
                                :disabled="loadingMysqlStatus || migratingMysql"
                                @click="loadMysqlStatus(true)">
                                {{
                                    loadingMysqlStatus
                                        ? t('cloud_hub.storage.refreshing')
                                        : t('cloud_hub.storage.refresh_usage_btn')
                                }}
                            </Button>
                            <Switch
                                :model-value="mysqlFormEnabled"
                                :disabled="savingMysqlConfig || migratingMysql"
                                :aria-label="t('cloud_hub.storage.mysql_enable_label')"
                                @update:model-value="onToggleExternalMysql" />
                        </div>
                    </div>

                    <p class="text-[11px] text-muted-foreground leading-relaxed">
                        {{ t('cloud_hub.storage.mysql_intro') }}
                    </p>

                    <div
                        v-if="!mysqlFormEnabled && mysqlSavedEnabled"
                        class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                        {{ t('cloud_hub.storage.mysql_disable_warning') }}
                    </div>

                    <template v-if="mysqlFormEnabled">
                        <!-- Two Operating Modes: 1) Hybrid (keep D1 + new data to MySQL 5.7)  2) Full Migration -->
                        <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                            <button
                                type="button"
                                :disabled="savingMysqlConfig || migratingMysql"
                                class="rounded-md border p-3 text-left transition-colors"
                                :class="
                                    mysqlFormMode === 'new_writes_only'
                                        ? 'border-primary bg-primary/10'
                                        : 'border-border/80 bg-background/60 hover:bg-accent/40'
                                "
                                @click="selectMysqlMode('new_writes_only')">
                                <div class="flex items-center justify-between gap-2">
                                    <span class="font-medium text-xs text-foreground">
                                        {{ t('cloud_hub.storage.mysql_mode_hybrid_title') }}
                                    </span>
                                    <span
                                        class="inline-block size-3 rounded-full border"
                                        :class="
                                            mysqlFormMode === 'new_writes_only'
                                                ? 'border-primary bg-primary'
                                                : 'border-muted-foreground/50'
                                        " />
                                </div>
                                <p class="mt-1 text-[11px] text-muted-foreground leading-relaxed">
                                    {{ t('cloud_hub.storage.mysql_mode_hybrid_desc') }}
                                </p>
                            </button>

                            <button
                                type="button"
                                :disabled="savingMysqlConfig || migratingMysql"
                                class="rounded-md border p-3 text-left transition-colors"
                                :class="
                                    mysqlFormMode === 'full_migrate'
                                        ? 'border-primary bg-primary/10'
                                        : 'border-border/80 bg-background/60 hover:bg-accent/40'
                                "
                                @click="selectMysqlMode('full_migrate')">
                                <div class="flex items-center justify-between gap-2">
                                    <span class="font-medium text-xs text-foreground">
                                        {{ t('cloud_hub.storage.mysql_mode_full_title') }}
                                    </span>
                                    <span
                                        class="inline-block size-3 rounded-full border"
                                        :class="
                                            mysqlFormMode === 'full_migrate'
                                                ? 'border-primary bg-primary'
                                                : 'border-muted-foreground/50'
                                        " />
                                </div>
                                <p class="mt-1 text-[11px] text-muted-foreground leading-relaxed">
                                    {{ t('cloud_hub.storage.mysql_mode_full_desc') }}
                                </p>
                            </button>
                        </div>

                        <!-- Live MySQL Usage Card -->
                        <div
                            v-if="mysqlUsage"
                            class="rounded-md border border-border/70 bg-muted/30 p-3 space-y-1.5">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <span class="font-medium text-foreground">
                                    {{ t('cloud_hub.storage.mysql_usage_heading') }}
                                </span>
                                <span
                                    v-if="mysqlUsage.connected"
                                    class="font-mono text-[11px] text-muted-foreground">
                                    MySQL {{ mysqlUsage.mysqlVersion }}
                                </span>
                            </div>
                            <template v-if="!mysqlUsage.connected">
                                <p class="text-[11px] text-destructive break-all">
                                    {{
                                        mysqlUsage.error
                                            ? formatMysqlErrorMessage(mysqlUsage.error)
                                            : t('cloud_hub.storage.mysql_connect_failed')
                                    }}
                                </p>
                            </template>
                            <template v-else>
                                <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-foreground">
                                    <span>{{ t('cloud_hub.storage.mysql_usage_size', { size: formatBytes(mysqlUsage.usedBytes) }) }}</span>
                                    <span>{{ t('cloud_hub.storage.mysql_usage_chunks', { chunks: Number(mysqlUsage.totalChunks || 0).toLocaleString() }) }}</span>
                                    <span>{{ t('cloud_hub.storage.mysql_usage_rows', { rows: Number(mysqlUsage.totalLogicalRows || 0).toLocaleString() }) }}</span>
                                    <span v-if="(mysqlUsage.businessRows || 0) > 0">{{ t('cloud_hub.storage.mysql_usage_business', { count: Number(mysqlUsage.businessRows || 0).toLocaleString() }) }}</span>
                                    <span>{{ t('cloud_hub.storage.mysql_usage_cache', { count: Number(mysqlUsage.cacheRows || 0).toLocaleString() }) }}</span>
                                </div>
                            </template>
                        </div>

                        <!-- Connection Type & MySQL 5.7+ Credentials Form -->
                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2" @input="mysqlFormDirty = true">
                            <div v-if="mysqlHyperdriveBound" class="space-y-1 sm:col-span-2">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.mysql_conn_type_label') }}
                                </label>
                                <select
                                    v-model="mysqlFormConnType"
                                    :disabled="savingMysqlConfig || migratingMysql"
                                    class="w-full sm:w-80 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground dark:[color-scheme:dark]"
                                    @change="mysqlFormDirty = true">
                                    <option class="bg-card text-foreground" value="direct">
                                        {{ t('cloud_hub.storage.mysql_conn_direct') }}
                                    </option>
                                    <option class="bg-card text-foreground" value="hyperdrive">
                                        {{ t('cloud_hub.storage.mysql_conn_hyperdrive') }}
                                    </option>
                                </select>
                            </div>

                            <template v-if="mysqlFormConnType === 'direct'">
                                <div class="space-y-1">
                                    <label class="block text-[11px] font-medium text-muted-foreground">
                                        {{ t('cloud_hub.storage.mysql_host_label') }}
                                    </label>
                                    <input
                                        v-model="mysqlFormHost"
                                        type="text"
                                        placeholder="db.example.com"
                                        autocomplete="off"
                                        :disabled="savingMysqlConfig || migratingMysql"
                                        class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                                </div>

                                <div class="space-y-1">
                                    <label class="block text-[11px] font-medium text-muted-foreground">
                                        {{ t('cloud_hub.storage.mysql_port_label') }}
                                    </label>
                                    <input
                                        v-model.number="mysqlFormPort"
                                        type="number"
                                        min="1"
                                        max="65535"
                                        placeholder="3306"
                                        :disabled="savingMysqlConfig || migratingMysql"
                                        class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                                </div>

                                <div class="space-y-1">
                                    <label class="block text-[11px] font-medium text-muted-foreground">
                                        {{ t('cloud_hub.storage.mysql_database_label') }}
                                    </label>
                                    <input
                                        v-model="mysqlFormDatabase"
                                        type="text"
                                        placeholder="vrcx_cloud"
                                        autocomplete="off"
                                        :disabled="savingMysqlConfig || migratingMysql"
                                        class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                                </div>

                                <div class="space-y-1">
                                    <label class="block text-[11px] font-medium text-muted-foreground">
                                        {{ t('cloud_hub.storage.mysql_username_label') }}
                                    </label>
                                    <input
                                        v-model="mysqlFormUsername"
                                        type="text"
                                        placeholder="vrcx"
                                        autocomplete="off"
                                        :disabled="savingMysqlConfig || migratingMysql"
                                        class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                                </div>

                                <div class="space-y-1">
                                    <label class="block text-[11px] font-medium text-muted-foreground">
                                        {{ t('cloud_hub.storage.mysql_password_label') }}
                                    </label>
                                    <input
                                        v-model="mysqlFormPassword"
                                        type="password"
                                        autocomplete="new-password"
                                        :placeholder="
                                            mysqlCanReuseSavedPassword
                                                ? t('cloud_hub.storage.mysql_password_saved_placeholder')
                                                : mysqlHasSavedPassword
                                                  ? t('cloud_hub.storage.mysql_password_reenter_placeholder')
                                                  : t('cloud_hub.storage.mysql_password_placeholder')
                                        "
                                        :disabled="savingMysqlConfig || migratingMysql"
                                        class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                                </div>

                                <div class="space-y-1">
                                    <label class="block text-[11px] font-medium text-muted-foreground">
                                        {{ t('cloud_hub.storage.mysql_ssl_label') }}
                                    </label>
                                    <select
                                        v-model="mysqlFormSslMode"
                                        :disabled="savingMysqlConfig || migratingMysql"
                                        class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground dark:[color-scheme:dark]"
                                        @change="mysqlFormDirty = true">
                                        <option class="bg-card text-foreground" value="disabled">
                                            {{ t('cloud_hub.storage.mysql_ssl_disabled') }}
                                        </option>
                                        <option
                                            v-if="mysqlFormSslMode === 'skip_verify'"
                                            class="bg-card text-foreground"
                                            value="skip_verify">
                                            {{ t('cloud_hub.storage.mysql_ssl_skip_verify') }}
                                        </option>
                                        <option class="bg-card text-foreground" value="verify">
                                            {{ t('cloud_hub.storage.mysql_ssl_verify') }}
                                        </option>
                                    </select>
                                </div>
                            </template>

                            <div class="space-y-1 sm:col-span-2">
                                <label class="block text-[11px] font-medium text-muted-foreground">
                                    {{ t('cloud_hub.storage.mysql_prefix_label') }}
                                </label>
                                <input
                                    v-model="mysqlFormTablePrefix"
                                    type="text"
                                    placeholder="vrcx_"
                                    :disabled="savingMysqlConfig || migratingMysql"
                                    class="w-64 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                            </div>
                        </div>

                        <div class="flex flex-wrap items-center gap-2 pt-1">
                            <Button
                                size="sm"
                                :disabled="savingMysqlConfig || migratingMysql"
                                @click="saveMysqlConfig">
                                {{
                                    savingMysqlConfig
                                        ? t('cloud_hub.storage.saving')
                                        : t('cloud_hub.storage.save_btn')
                                }}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                :disabled="testingMysql || savingMysqlConfig || migratingMysql"
                                @click="testMysqlConnection">
                                {{
                                    testingMysql
                                        ? t('cloud_hub.storage.testing')
                                        : t('cloud_hub.storage.mysql_test_btn')
                                }}
                            </Button>
                        </div>

                        <!-- Mode 2: Full D1 -> MySQL Resumable Migration Panel -->
                        <div
                            v-if="mysqlFormMode === 'full_migrate'"
                            class="rounded-md border border-border/80 bg-muted/25 p-3 space-y-2.5">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <span class="font-medium text-xs text-foreground">
                                    {{ t('cloud_hub.storage.mysql_migrate_heading') }}
                                </span>
                                <span
                                    v-if="mysqlMigrationState?.d1Drained && mysqlD1PendingTotal === 0"
                                    class="rounded-full border border-status-online/40 bg-status-online/10 px-2 py-0.5 text-[11px] font-medium text-foreground">
                                    {{ t('cloud_hub.storage.mysql_migrate_done_badge') }}
                                </span>
                            </div>

                            <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                                <span>
                                    {{
                                        t('cloud_hub.storage.mysql_pending_chunks', {
                                            chunks: Number(mysqlD1Pending?.totalChunks || 0).toLocaleString(),
                                            rows: Number(mysqlD1Pending?.totalChunkRows || 0).toLocaleString()
                                        })
                                    }}
                                </span>
                                <span v-if="(mysqlD1Pending?.totalLegacySingleRows || 0) > 0">
                                    {{
                                        t('cloud_hub.storage.mysql_pending_legacy', {
                                            rows: Number(mysqlD1Pending?.totalLegacySingleRows || 0).toLocaleString()
                                        })
                                    }}
                                </span>
                                <span v-if="(mysqlD1Pending?.totalBusinessRows || 0) > 0">
                                    {{
                                        t('cloud_hub.storage.mysql_pending_business', {
                                            count: Number(mysqlD1Pending?.totalBusinessRows || 0).toLocaleString()
                                        })
                                    }}
                                </span>
                                <span v-if="(mysqlD1Pending?.totalCacheRows || 0) > 0">
                                    {{
                                        t('cloud_hub.storage.mysql_pending_cache', {
                                            count: Number(mysqlD1Pending?.totalCacheRows || 0).toLocaleString()
                                        })
                                    }}
                                </span>
                                <span
                                    v-if="
                                        Number(mysqlMigrationState?.totalRowsMoved || 0) +
                                            Number(mysqlMigrationState?.totalBusinessRowsMoved || 0) +
                                            Number(mysqlMigrationState?.totalRollupMoved || 0) >
                                        0
                                    ">
                                    {{
                                        t('cloud_hub.storage.mysql_moved_summary', {
                                            chunks: Number(mysqlMigrationState?.totalChunksMoved || 0).toLocaleString(),
                                            rows: (
                                                Number(mysqlMigrationState?.totalRowsMoved || 0) +
                                                Number(mysqlMigrationState?.totalBusinessRowsMoved || 0) +
                                                Number(mysqlMigrationState?.totalRollupMoved || 0)
                                            ).toLocaleString()
                                        })
                                    }}
                                </span>
                            </div>

                            <div v-if="migratingMysql || mysqlMigrationProgressPercent > 0" class="space-y-1">
                                <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                    <div
                                        class="h-full rounded-full bg-primary transition-all duration-200"
                                        :style="{ width: `${Math.min(100, mysqlMigrationProgressPercent)}%` }" />
                                </div>
                            </div>

                            <div class="flex flex-wrap items-center gap-2">
                                <Button
                                    size="sm"
                                    :disabled="
                                        migratingMysql ||
                                        savingMysqlConfig ||
                                        !mysqlConfigReady ||
                                        mysqlD1PendingTotal === 0
                                    "
                                    @click="startMysqlMigration">
                                    {{
                                        migratingMysql
                                            ? t('cloud_hub.storage.mysql_migrating_btn')
                                            : Number(mysqlMigrationState?.totalChunksMoved || 0) +
                                                    Number(mysqlMigrationState?.totalBusinessRowsMoved || 0) +
                                                    Number(mysqlMigrationState?.totalRollupMoved || 0) >
                                                    0 && mysqlD1PendingTotal > 0
                                              ? t('cloud_hub.storage.mysql_resume_migrate_btn')
                                              : t('cloud_hub.storage.mysql_start_migrate_btn')
                                    }}
                                </Button>
                                <Button
                                    v-if="migratingMysql"
                                    size="sm"
                                    variant="outline"
                                    @click="pauseMysqlMigration">
                                    {{ t('cloud_hub.storage.mysql_pause_migrate_btn') }}
                                </Button>
                                <span
                                    v-if="!mysqlConfigReady"
                                    class="text-[11px] text-amber-600 dark:text-amber-400">
                                    {{ t('cloud_hub.storage.mysql_config_incomplete_hint') }}
                                </span>
                                <span
                                    v-else-if="!mysqlSavedEnabled || mysqlSavedMode !== 'full_migrate' || mysqlFormDirty"
                                    class="text-[11px] text-muted-foreground">
                                    {{ t('cloud_hub.storage.mysql_save_before_migrate_hint') }}
                                </span>
                            </div>
                        </div>
                    </template>

                    <p v-if="mysqlNotice" class="text-[11px] text-primary">{{ mysqlNotice }}</p>
                    <p v-if="mysqlError" class="text-[11px] text-destructive break-all">{{ mysqlError }}</p>
                </div>

                <!-- Database Row Compaction (All 6 D1 Shards: 1000-row Chunks + Cache Gzip + Control Pruning) -->
                <div class="rounded-lg border border-border bg-card/60 p-4 space-y-2.5">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="space-y-0.5">
                            <div class="font-medium text-sm text-foreground">
                                {{ t('cloud_hub.storage.compact_heading') }}
                            </div>
                            <div class="text-[11px] text-muted-foreground">
                                {{ t('cloud_hub.storage.compact_desc') }}
                            </div>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                            <select
                                v-model="compactRetentionDays"
                                :disabled="compactingDb || cleaningDb"
                                class="rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground dark:[color-scheme:dark]">
                                <option class="bg-card text-foreground" value="0">
                                    {{ t('cloud_hub.storage.compact_mode_all') }}
                                </option>
                                <option class="bg-card text-foreground" value="7">
                                    {{ t('cloud_hub.storage.compact_mode_7d') }}
                                </option>
                                <option class="bg-card text-foreground" value="30">
                                    {{ t('cloud_hub.storage.compact_mode_30d') }}
                                </option>
                            </select>
                            <Button
                                size="sm"
                                variant="outline"
                                :disabled="compactingDb || cleaningDb"
                                @click="runDatabaseCompaction">
                                {{
                                    compactingDb
                                        ? t('cloud_hub.storage.compacting_btn')
                                        : t('cloud_hub.storage.compact_btn')
                                }}
                            </Button>
                        </div>
                    </div>
                    <p v-if="compactNotice" class="text-[11px] text-primary">{{ compactNotice }}</p>
                    <p v-if="compactError" class="text-[11px] text-destructive">{{ compactError }}</p>
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
                                    cleanupPreview.oldestIso && cleanupPreview.cutoffIso && cleanupPreview.totalRows > 0
                                        ? t('cloud_hub.quota.cleanup_cutoff_label', {
                                              start: cleanupPreview.oldestIso.slice(0, 10),
                                              end: cleanupPreview.cutoffIso.slice(0, 10)
                                          })
                                        : cleanupPreview.oldestIso
                                          ? t('cloud_hub.quota.cleanup_oldest_only', {
                                                start: cleanupPreview.oldestIso.slice(0, 10)
                                            })
                                          : t('cloud_hub.quota.cleanup_no_records')
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
                            v-if="cleanupPreview.clampedToRecentGuard && cleanupPreview.totalRows > 0"
                            class="text-[11px] text-amber-600 dark:text-amber-400">
                            {{ t('cloud_hub.quota.cleanup_recent_guard_hint') }}
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
                            v-if="!quotaInfo || quotaInfo.r2Enabled || !cleanupPreview?.b2Enabled"
                            type="button"
                            class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                            :disabled="
                                cleaningDb ||
                                !quotaInfo?.r2Enabled ||
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
                                              start: cleanupPreview?.oldestIso?.slice(0, 10) || '',
                                              end: cleanupPreview?.cutoffIso?.slice(0, 10) || '',
                                              rows: (cleanupPreview?.totalRows ?? 0).toLocaleString()
                                          })
                                        : t('cloud_hub.quota.cleanup_confirm_backup_desc', {
                                              months: resolvedCleanupMonths,
                                              start: cleanupPreview?.oldestIso?.slice(0, 10) || '',
                                              end: cleanupPreview?.cutoffIso?.slice(0, 10) || '',
                                              rows: (cleanupPreview?.totalRows ?? 0).toLocaleString()
                                          })
                                    : t('cloud_hub.quota.cleanup_confirm_direct_desc', {
                                          months: resolvedCleanupMonths,
                                          start: cleanupPreview?.oldestIso?.slice(0, 10) || '',
                                          end: cleanupPreview?.cutoffIso?.slice(0, 10) || '',
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
                                    savedEnabled
                                        ? 'border-status-online/40 bg-status-online/10 text-foreground'
                                        : formEnabled
                                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                          : 'border-border bg-muted/50 text-muted-foreground'
                                ">
                                <span
                                    class="inline-block size-1.5 rounded-full"
                                    :class="
                                        savedEnabled
                                            ? 'bg-status-online'
                                            : formEnabled
                                              ? 'bg-amber-500'
                                              : 'bg-muted-foreground/60'
                                    " />
                                {{
                                    savedEnabled
                                        ? t('cloud_hub.storage.status_enabled')
                                        : formEnabled
                                          ? t('cloud_hub.storage.status_unsaved')
                                          : t('cloud_hub.storage.status_disabled')
                                }}
                            </span>
                        </div>
                        <Switch
                            :model-value="formEnabled"
                            :disabled="savingConfig"
                            :aria-label="t('cloud_hub.storage.enable_extra_label')"
                            @update:model-value="onToggleExtraStorage" />
                    </div>

                    <template v-if="formEnabled">
                        <!-- Backblaze B2 Signup & Pricing Hint (shown when extra storage is enabled) -->
                        <div class="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
                            {{ t('cloud_hub.storage.b2_pricing_hint_prefix')
                            }}<a
                                href="https://secure.backblaze.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="font-medium text-primary hover:underline">
                                https://secure.backblaze.com</a
                            >{{ t('cloud_hub.storage.b2_pricing_hint_suffix') }}
                        </div>

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

                        <!-- Built-in Cloudflare Workers Direct Proxy Toggle (default ON; disabling warns about official B2 egress fees) -->
                        <div class="rounded-md border border-border/70 bg-muted/20 p-3 space-y-2.5">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="font-medium text-foreground">
                                        {{ t('cloud_hub.storage.direct_proxy_label') }}
                                    </span>
                                    <span
                                        class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                                        :class="
                                            formUseWorkerDirectProxy
                                                ? 'border-status-online/40 bg-status-online/10 text-foreground'
                                                : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                        ">
                                        <span
                                            class="inline-block size-1.5 rounded-full"
                                            :class="
                                                formUseWorkerDirectProxy ? 'bg-status-online' : 'bg-amber-500'
                                            " />
                                        {{
                                            formUseWorkerDirectProxy
                                                ? t('cloud_hub.storage.direct_proxy_active')
                                                : t('cloud_hub.storage.direct_proxy_official')
                                        }}
                                    </span>
                                </div>
                                <Switch
                                    :model-value="formUseWorkerDirectProxy"
                                    :disabled="savingConfig"
                                    :aria-label="t('cloud_hub.storage.direct_proxy_label')"
                                    @update:model-value="onToggleWorkerDirectProxy" />
                            </div>

                            <div
                                v-if="pendingDisableDirectProxyConfirm"
                                class="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                                <div class="text-[11px] font-medium text-foreground">
                                    {{ t('cloud_hub.storage.direct_proxy_disable_confirm_desc') }}
                                </div>
                                <div class="flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        class="rounded-md bg-destructive px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                                        :disabled="savingConfig"
                                        @click="confirmDisableWorkerDirectProxy">
                                        {{ t('cloud_hub.storage.direct_proxy_disable_confirm_btn') }}
                                    </button>
                                    <button
                                        type="button"
                                        class="rounded-md border border-border px-3 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
                                        :disabled="savingConfig"
                                        @click="pendingDisableDirectProxyConfirm = false">
                                        {{ t('cloud_hub.storage.direct_proxy_disable_cancel_btn') }}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Overflow Threshold & B2 S3-Compatible Credentials -->
                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2" @input="b2FormDirty = true">
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
    const compactingDb = ref(false);
    const compactRetentionDays = ref('0');
    const compactNotice = ref('');
    const compactError = ref('');
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

    // --- External Database (MySQL 5.7+) State ---
    const loadingMysqlStatus = ref(false);
    const savingMysqlConfig = ref(false);
    const testingMysql = ref(false);
    const migratingMysql = ref(false);
    const pauseMysqlRequested = ref(false);

    const mysqlSavedEnabled = ref(false);
    const mysqlSavedMode = ref('new_writes_only');
    const mysqlSavedHost = ref('');
    const mysqlSavedPort = ref(3306);
    const mysqlSavedUsername = ref('');
    const mysqlHyperdriveBound = ref(false);
    const mysqlHasSavedPassword = ref(false);
    const mysqlFormDirty = ref(false);

    const mysqlFormEnabled = ref(false);
    const mysqlFormMode = ref('new_writes_only');
    const mysqlFormConnType = ref('direct');
    const mysqlFormHost = ref('');
    const mysqlFormPort = ref(3306);
    const mysqlFormDatabase = ref('');
    const mysqlFormUsername = ref('');
    const mysqlFormPassword = ref('');
    const mysqlFormSslMode = ref('disabled');
    const mysqlFormTablePrefix = ref('vrcx_');

    const mysqlUsage = ref(null);
    const mysqlD1Pending = ref(null);
    const mysqlMigrationState = ref(null);
    const mysqlMigrationInitialTotal = ref(0);
    const mysqlNotice = ref('');
    const mysqlError = ref('');

    const mysqlD1PendingTotal = computed(() => {
        const p = mysqlD1Pending.value;
        if (!p) return 0;
        return (
            Number(p.totalChunks || 0) +
            Number(p.totalLegacySingleRows || 0) +
            Number(p.totalCacheRows || 0) +
            Number(p.totalRollupRows || 0) +
            Number(p.totalBusinessRows || 0)
        );
    });

    const mysqlMigrationProgressPercent = computed(() => {
        const init = mysqlMigrationInitialTotal.value;
        if (init <= 0) {
            return mysqlMigrationState.value?.d1Drained && mysqlD1PendingTotal.value === 0 ? 100 : 0;
        }
        const remaining = mysqlD1PendingTotal.value;
        if (remaining <= 0) return 100;
        return Math.max(2, Math.min(99, Math.round(((init - remaining) / init) * 100)));
    });

    const mysqlCanReuseSavedPassword = computed(() => {
        if (!mysqlHasSavedPassword.value || mysqlFormConnType.value !== 'direct') {
            return false;
        }
        return (
            mysqlFormHost.value.trim().toLowerCase() === mysqlSavedHost.value.trim().toLowerCase() &&
            (Number(mysqlFormPort.value) || 3306) === (Number(mysqlSavedPort.value) || 3306) &&
            mysqlFormUsername.value.trim() === mysqlSavedUsername.value.trim()
        );
    });

    function formatMysqlErrorMessage(err) {
        const code = typeof err === 'object' && err && typeof err.code === 'string' ? err.code : '';
        const raw =
            typeof err === 'string'
                ? err
                : err instanceof Error
                  ? err.message || String(err)
                  : typeof err?.message === 'string'
                    ? err.message
                    : String(err || '');

        if (code === 'PASSWORD_REQUIRED_FOR_NEW_TARGET') {
            return t('cloud_hub.storage.mysql_err_password_required_new_target');
        }
        if (code === 'SAVED_PASSWORD_UNREADABLE') {
            return t('cloud_hub.storage.mysql_err_saved_password_unreadable');
        }
        if (code === 'UNSUPPORTED_SSL_MODE' || /does not support skipping TLS/i.test(raw)) {
            return t('cloud_hub.storage.mysql_err_skip_verify_unsupported');
        }
        if (code === 'HYPERDRIVE_UNBOUND') {
            return t('cloud_hub.storage.mysql_err_hyperdrive_unbound');
        }
        if (code === 'INVALID_HOST') {
            return t('cloud_hub.storage.mysql_err_invalid_host');
        }
        if (code === 'INVALID_PORT') {
            return t('cloud_hub.storage.mysql_err_invalid_port');
        }
        if (code === 'INVALID_DATABASE') {
            return t('cloud_hub.storage.mysql_err_invalid_database');
        }
        if (code === 'INVALID_USERNAME') {
            return t('cloud_hub.storage.mysql_err_invalid_username');
        }
        if (code === 'INVALID_TABLE_PREFIX') {
            return t('cloud_hub.storage.mysql_err_invalid_prefix');
        }
        if (code === 'INVALID_PASSWORD') {
            return t('cloud_hub.storage.mysql_err_invalid_password');
        }
        if (code === 'INCOMPLETE_CONFIG') {
            return t('cloud_hub.storage.mysql_err_incomplete');
        }

        const accessDenied = raw.match(/Access denied for user '([^']*)'@'([^']*)'\s*\(using password:\s*(YES|NO)\)/i);
        if (accessDenied) {
            const [, user, ip, usingPw] = accessDenied;
            return usingPw.toUpperCase() === 'NO'
                ? t('cloud_hub.storage.mysql_err_access_denied_no_pw', { user, ip })
                : t('cloud_hub.storage.mysql_err_access_denied_with_pw', { user, ip });
        }
        const hostNotAllowed = raw.match(/Host '([^']*)' is not allowed to connect/i);
        if (hostNotAllowed) {
            return t('cloud_hub.storage.mysql_err_host_not_allowed', { ip: hostNotAllowed[1] });
        }
        const unknownDb = raw.match(/Unknown database '([^']*)'/i);
        if (unknownDb) {
            return t('cloud_hub.storage.mysql_err_unknown_database', { db: unknownDb[1] });
        }
        if (/Server does not support secure connection|HANDSHAKE_NO_SSL_SUPPORT/i.test(raw)) {
            return t('cloud_hub.storage.mysql_err_server_no_ssl');
        }
        if (/TLS handshake failed|HANDSHAKE_SSL_ERROR|certificate/i.test(raw)) {
            return t('cloud_hub.storage.mysql_err_tls_failed');
        }
        if (/ETIMEDOUT|timed?\s*out/i.test(raw)) {
            return t('cloud_hub.storage.mysql_err_timeout');
        }
        if (/ECONNREFUSED|connection refused/i.test(raw)) {
            return t('cloud_hub.storage.mysql_err_refused');
        }
        if (/ENOTFOUND|getaddrinfo|could not resolve|dns/i.test(raw)) {
            return t('cloud_hub.storage.mysql_err_dns');
        }
        if (/Connection lost|ECONNRESET|PROTOCOL_CONNECTION_LOST/i.test(raw)) {
            return t('cloud_hub.storage.mysql_err_connection_lost');
        }
        return raw || t('cloud_hub.storage.mysql_connect_failed');
    }

    function applyMysqlStatusPayload(data, { forceFormSync = false } = {}) {
        if (!data) return;
        const cfg = data.config;
        if (cfg) {
            mysqlSavedEnabled.value = Boolean(cfg.enabled);
            mysqlSavedMode.value = cfg.mode === 'full_migrate' ? 'full_migrate' : 'new_writes_only';
            mysqlSavedHost.value = cfg.host || '';
            mysqlSavedPort.value = Number(cfg.port || 3306) || 3306;
            mysqlSavedUsername.value = cfg.username || '';
            mysqlHyperdriveBound.value = Boolean(cfg.hyperdriveBound);
            mysqlHasSavedPassword.value = Boolean(cfg.hasPassword);
            if (forceFormSync || !mysqlFormDirty.value) {
                mysqlFormEnabled.value = Boolean(cfg.enabled);
                mysqlFormMode.value = cfg.mode === 'full_migrate' ? 'full_migrate' : 'new_writes_only';
                mysqlFormConnType.value = cfg.connectionType === 'hyperdrive' ? 'hyperdrive' : 'direct';
                mysqlFormHost.value = cfg.host || '';
                mysqlFormPort.value = Number(cfg.port || 3306) || 3306;
                mysqlFormDatabase.value = cfg.database || '';
                mysqlFormUsername.value = cfg.username || '';
                mysqlFormSslMode.value = cfg.sslMode || 'disabled';
                mysqlFormTablePrefix.value = cfg.tablePrefix ?? 'vrcx_';
                mysqlFormDirty.value = false;
            }
        }
        if (data.d1Pending !== undefined) {
            mysqlD1Pending.value = data.d1Pending;
        }
        if (data.migration !== undefined) {
            mysqlMigrationState.value = data.migration;
        }
        if (data.mysqlUsage !== undefined) {
            mysqlUsage.value = data.mysqlUsage;
        }
    }

    async function loadMysqlStatus(forceRefresh = false) {
        if (!cloudState.authenticated) return;
        loadingMysqlStatus.value = true;
        mysqlError.value = '';
        try {
            const data = await cloudFetch(`/api/storage/mysql/status${forceRefresh ? '?refresh=1' : ''}`);
            applyMysqlStatusPayload(data);
        } catch (err) {
            mysqlError.value = formatMysqlErrorMessage(err);
        } finally {
            loadingMysqlStatus.value = false;
        }
    }

    function selectMysqlMode(mode) {
        mysqlFormMode.value = mode === 'full_migrate' ? 'full_migrate' : 'new_writes_only';
        mysqlFormDirty.value = true;
        mysqlError.value = '';
        mysqlNotice.value = '';
    }

    async function onToggleExternalMysql(nextEnabled) {
        const wantEnable = Boolean(nextEnabled);
        const hadUnsaved = mysqlFormDirty.value;
        mysqlFormEnabled.value = wantEnable;
        mysqlError.value = '';
        mysqlNotice.value = '';

        const hasCompleteDirect = Boolean(
            mysqlFormHost.value.trim() && mysqlFormDatabase.value.trim() && mysqlFormUsername.value.trim()
        );
        const hasCompleteSaved =
            mysqlFormConnType.value === 'hyperdrive' ? mysqlHyperdriveBound.value : hasCompleteDirect;

        if ((!wantEnable && mysqlSavedEnabled.value) || (wantEnable && !mysqlSavedEnabled.value && hasCompleteSaved && !hadUnsaved)) {
            if (savingMysqlConfig.value) return;
            savingMysqlConfig.value = true;
            try {
                const data = await cloudFetch('/api/storage/mysql/config', {
                    method: 'PUT',
                    json: { enabled: wantEnable }
                });
                applyMysqlStatusPayload(data, { forceFormSync: true });
                mysqlNotice.value = t('cloud_hub.storage.mysql_saved_toast');
                toast.success(mysqlNotice.value);
                await Promise.all([loadMysqlStatus(wantEnable), loadQuota(), loadCleanupPreview()]);
            } catch (err) {
                mysqlFormEnabled.value = !wantEnable;
                mysqlError.value = formatMysqlErrorMessage(err);
                toast.error(mysqlError.value);
            } finally {
                savingMysqlConfig.value = false;
            }
            return;
        }

        mysqlFormDirty.value = true;
    }

    async function saveMysqlConfig() {
        if (savingMysqlConfig.value) return;
        savingMysqlConfig.value = true;
        mysqlError.value = '';
        mysqlNotice.value = '';
        try {
            const data = await cloudFetch('/api/storage/mysql/config', {
                method: 'PUT',
                json: {
                    enabled: mysqlFormEnabled.value,
                    mode: mysqlFormMode.value,
                    connectionType: mysqlFormConnType.value,
                    host: mysqlFormHost.value.trim(),
                    port: Number(mysqlFormPort.value) || 3306,
                    database: mysqlFormDatabase.value.trim(),
                    username: mysqlFormUsername.value.trim(),
                    sslMode: mysqlFormSslMode.value,
                    tablePrefix: mysqlFormTablePrefix.value.trim(),
                    ...(mysqlFormPassword.value ? { password: mysqlFormPassword.value } : {})
                }
            });
            mysqlFormPassword.value = '';
            applyMysqlStatusPayload(data, { forceFormSync: true });
            mysqlNotice.value = t('cloud_hub.storage.mysql_saved_toast');
            toast.success(mysqlNotice.value);
            await Promise.all([loadMysqlStatus(mysqlFormEnabled.value), loadQuota(), loadCleanupPreview()]);
        } catch (err) {
            mysqlError.value = formatMysqlErrorMessage(err);
            toast.error(mysqlError.value);
        } finally {
            savingMysqlConfig.value = false;
        }
    }

    async function testMysqlConnection() {
        if (testingMysql.value) return;
        testingMysql.value = true;
        mysqlError.value = '';
        mysqlNotice.value = '';
        try {
            const data = await cloudFetch('/api/storage/mysql/test', {
                method: 'POST',
                json: {
                    connectionType: mysqlFormConnType.value,
                    host: mysqlFormHost.value.trim(),
                    port: Number(mysqlFormPort.value) || 3306,
                    database: mysqlFormDatabase.value.trim(),
                    username: mysqlFormUsername.value.trim(),
                    sslMode: mysqlFormSslMode.value,
                    tablePrefix: mysqlFormTablePrefix.value.trim(),
                    ...(mysqlFormPassword.value ? { password: mysqlFormPassword.value } : {})
                }
            });
            if (data?.mysqlUsage) {
                mysqlUsage.value = data.mysqlUsage;
            }
            mysqlNotice.value = t('cloud_hub.storage.mysql_test_ok', {
                version: data?.mysqlVersion || '5.7+',
                ms: data?.latencyMs ?? 0,
                tables: data?.tablesReady ?? 47
            });
            toast.success(mysqlNotice.value);
        } catch (err) {
            mysqlError.value = formatMysqlErrorMessage(err);
            toast.error(mysqlError.value);
        } finally {
            testingMysql.value = false;
        }
    }

    const mysqlConfigReady = computed(() => {
        if (mysqlFormConnType.value === 'hyperdrive') {
            return mysqlHyperdriveBound.value;
        }
        return Boolean(
            mysqlFormHost.value.trim() && mysqlFormDatabase.value.trim() && mysqlFormUsername.value.trim()
        );
    });

    function pauseMysqlMigration() {
        pauseMysqlRequested.value = true;
    }

    async function startMysqlMigration() {
        if (migratingMysql.value || savingMysqlConfig.value || !mysqlConfigReady.value) return;
        migratingMysql.value = true;
        pauseMysqlRequested.value = false;
        mysqlError.value = '';
        mysqlNotice.value = '';
        mysqlMigrationInitialTotal.value = Math.max(mysqlMigrationInitialTotal.value, mysqlD1PendingTotal.value);

        let batchMovedChunks = 0;
        let batchMovedRows = 0;
        let finished = false;
        try {
            // Auto-persist MySQL Mode (enabled + full_migrate) to D1 config before starting one-click migration.
            if (!mysqlSavedEnabled.value || mysqlSavedMode.value !== 'full_migrate' || mysqlFormDirty.value) {
                const cfgData = await cloudFetch('/api/storage/mysql/config', {
                    method: 'PUT',
                    json: {
                        enabled: true,
                        mode: 'full_migrate',
                        connectionType: mysqlFormConnType.value,
                        host: mysqlFormHost.value.trim(),
                        port: Number(mysqlFormPort.value) || 3306,
                        database: mysqlFormDatabase.value.trim(),
                        username: mysqlFormUsername.value.trim(),
                        sslMode: mysqlFormSslMode.value,
                        tablePrefix: mysqlFormTablePrefix.value.trim(),
                        ...(mysqlFormPassword.value ? { password: mysqlFormPassword.value } : {})
                    }
                });
                mysqlFormPassword.value = '';
                applyMysqlStatusPayload(cfgData, { forceFormSync: true });
            }

            for (let round = 0; round < 200; round++) {
                if (pauseMysqlRequested.value) {
                    mysqlNotice.value = t('cloud_hub.storage.mysql_migrate_paused_toast', {
                        chunks: batchMovedChunks.toLocaleString(),
                        rows: batchMovedRows.toLocaleString()
                    });
                    break;
                }
                const res = await cloudFetch('/api/storage/mysql/migrate', {
                    method: 'POST',
                    json: { maxChunks: 8, maxCacheRows: 80 }
                });
                batchMovedChunks += Number(res?.movedChunks || 0);
                batchMovedRows +=
                    Number(res?.movedRows || 0) +
                    Number(res?.compactedSingleRows || 0) +
                    Number(res?.movedRollupRows || 0) +
                    Number(res?.movedBusinessRows || 0) +
                    Number(res?.movedCacheRows || 0);
                if (res?.remaining) mysqlD1Pending.value = res.remaining;
                if (res?.migration) mysqlMigrationState.value = res.migration;
                if (res?.done) {
                    finished = true;
                    break;
                }
            }
            if (finished) {
                const stateTotalRows =
                    Number(mysqlMigrationState.value?.totalRowsMoved || 0) +
                    Number(mysqlMigrationState.value?.totalRollupMoved || 0) +
                    Number(mysqlMigrationState.value?.totalBusinessRowsMoved || 0) +
                    Number(mysqlMigrationState.value?.totalCacheMoved || 0);
                mysqlNotice.value = t('cloud_hub.storage.mysql_migrate_done_toast', {
                    chunks: Number(mysqlMigrationState.value?.totalChunksMoved || batchMovedChunks).toLocaleString(),
                    rows: Math.max(stateTotalRows, batchMovedRows).toLocaleString()
                });
                toast.success(mysqlNotice.value);
            } else if (!pauseMysqlRequested.value) {
                mysqlNotice.value = t('cloud_hub.storage.mysql_migrate_more_toast', {
                    chunks: batchMovedChunks.toLocaleString(),
                    rows: batchMovedRows.toLocaleString()
                });
                toast.success(mysqlNotice.value);
            }
            await Promise.all([loadMysqlStatus(true), loadQuota(), loadCleanupPreview()]);
        } catch (err) {
            mysqlError.value = formatMysqlErrorMessage(err);
            toast.error(mysqlError.value);
        } finally {
            migratingMysql.value = false;
            pauseMysqlRequested.value = false;
        }
    }

    // --- Object Storage (R2 & Backblaze B2) State ---
    const loadingStatus = ref(false);
    const savingConfig = ref(false);
    const testingB2 = ref(false);

    const r2Usage = ref(null);
    const b2Usage = ref(null);
    const overflowActive = ref(false);
    const hasSavedSecret = ref(false);
    const savedEnabled = ref(false);
    const b2FormDirty = ref(false);
    const formUseWorkerDirectProxy = ref(true);
    const pendingDisableDirectProxyConfirm = ref(false);

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

    async function runDatabaseCompaction() {
        if (compactingDb.value || cleaningDb.value) return;
        compactingDb.value = true;
        compactNotice.value = '';
        compactError.value = '';
        try {
            const parsedDays = Number(compactRetentionDays.value);
            const retentionDays = Number.isInteger(parsedDays) && parsedDays >= 0 && parsedDays <= 365 ? parsedDays : 0;
            let totalPacked = 0;
            let totalChunks = 0;
            let totalChunksCompressed = 0;
            let totalCacheCompressed = 0;
            let totalBytesSaved = 0;
            let totalPruned = 0;
            let hasMoreAfterLoop = false;
            for (let round = 0; round < 120; round++) {
                const res = await cloudFetch('/api/admin/storage/compact', {
                    method: 'POST',
                    json: { retentionDays, includeLegacy: true, maxChunksPerTable: 8 }
                });
                totalPacked += Number(res?.totalPackedRows || 0);
                totalChunks += Number(res?.totalChunksCreated || 0);
                totalChunksCompressed += Number(res?.totalChunksCompressed || 0);
                totalCacheCompressed += Number(res?.cacheCompressedRows || 0);
                totalBytesSaved += Number(res?.totalBytesSaved || res?.cacheBytesSaved || 0);
                totalPruned += Number(res?.totalPrunedRows || 0);
                if (res?.hasMore) {
                    compactNotice.value = t('cloud_hub.storage.compact_progress_notice', {
                        chunksCompressed: totalChunksCompressed.toLocaleString(),
                        cacheCompressed: totalCacheCompressed.toLocaleString(),
                        saved: formatBytes(totalBytesSaved)
                    });
                    if (round === 119) {
                        hasMoreAfterLoop = true;
                    }
                } else {
                    break;
                }
            }
            if (totalPacked > 0 || totalChunksCompressed > 0 || totalCacheCompressed > 0 || totalPruned > 0) {
                compactNotice.value = t('cloud_hub.storage.compact_done_toast', {
                    packed: totalPacked.toLocaleString(),
                    chunks: totalChunks.toLocaleString(),
                    chunksCompressed: totalChunksCompressed.toLocaleString(),
                    compressed: totalCacheCompressed.toLocaleString(),
                    saved: formatBytes(totalBytesSaved),
                    pruned: totalPruned.toLocaleString()
                });
                if (hasMoreAfterLoop) {
                    compactNotice.value += ` ${t('cloud_hub.storage.compact_more_remaining')}`;
                }
            } else {
                compactNotice.value = t('cloud_hub.storage.compact_noop_toast');
            }
            toast.success(compactNotice.value);
            await Promise.all([refreshDatabaseSection(), loadMysqlStatus(mysqlSavedEnabled.value)]);
        } catch (err) {
            compactError.value = err?.message || String(err);
            toast.error(compactError.value);
        } finally {
            compactingDb.value = false;
        }
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
            // Lock the confirmed forward cutoff across multi-round backup_and_delete batches
            // so advancing the oldest timestamp after round 1 never creeps into newer months.
            let lockedCutoffIso = cleanupPreview.value?.cutoffIso || '';
            let totalDeleted = 0;
            let totalBackedUp = 0;
            let backupCount = 0;
            let lastFileName = '';
            let lastProvider = '';
            let truncated = false;

            for (let round = 0; round < 20; round++) {
                const res = await cloudFetch('/api/admin/cleanup', {
                    method: 'POST',
                    json: {
                        months,
                        mode,
                        includeLegacy,
                        backupTarget,
                        ...(lockedCutoffIso ? { cutoffIso: lockedCutoffIso } : {})
                    }
                });
                if (!lockedCutoffIso && res?.cutoffIso) {
                    lockedCutoffIso = res.cutoffIso;
                }
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

    function applyStatusPayload(data, { forceFormSync = false } = {}) {
        if (!data) return;
        r2Usage.value = data.r2 ?? null;
        b2Usage.value = data.b2 ?? null;
        overflowActive.value = Boolean(data.overflowActive);
        const ext = data.externalStorage;
        if (ext) {
            savedEnabled.value = Boolean(ext.enabled);
            cloudState.b2Enabled = Boolean(ext.enabled && ext.endpoint && ext.bucket && ext.accessKeyId && ext.hasSecretKey);
            hasSavedSecret.value = Boolean(ext.hasSecretKey);
            // Do not clobber user's in-progress form edits if an async refresh finishes late.
            if (forceFormSync || !b2FormDirty.value) {
                formEnabled.value = Boolean(ext.enabled);
                formUseWorkerDirectProxy.value = ext.useWorkerDirectProxy !== false;
                pendingDisableDirectProxyConfirm.value = false;
                formEndpoint.value = ext.endpoint || '';
                formBucket.value = ext.bucket || '';
                formRegion.value = ext.region || '';
                formAccessKeyId.value = ext.accessKeyId || '';
                formKeyPrefix.value = (ext.keyPrefix || '').replace(/\/+$/, '');
                const gb = Number(ext.r2OverflowThresholdBytes || 0) / (1024 * 1024 * 1024);
                formThresholdGb.value = Number.isFinite(gb) && gb > 0 ? Number(gb.toFixed(2)) : 9;
                b2FormDirty.value = false;
            }
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

    async function persistWorkerDirectProxySetting(nextVal) {
        if (!savedEnabled.value) {
            formUseWorkerDirectProxy.value = nextVal;
            pendingDisableDirectProxyConfirm.value = false;
            return;
        }
        if (savingConfig.value) return;
        const prevVal = formUseWorkerDirectProxy.value;
        formUseWorkerDirectProxy.value = nextVal;
        pendingDisableDirectProxyConfirm.value = false;
        savingConfig.value = true;
        statusError.value = '';
        statusNotice.value = '';
        try {
            const data = await cloudFetch('/api/storage/config', {
                method: 'PUT',
                json: { useWorkerDirectProxy: nextVal }
            });
            // Preserve any unsaved credential/threshold edits in the form; only sync usage & proxy toggle.
            applyStatusPayload(data);
            if (data?.externalStorage) {
                formUseWorkerDirectProxy.value = data.externalStorage.useWorkerDirectProxy !== false;
                pendingDisableDirectProxyConfirm.value = false;
            }
            const msg = t('cloud_hub.storage.saved_toast');
            statusNotice.value = msg;
            toast.success(msg);
        } catch (err) {
            formUseWorkerDirectProxy.value = prevVal;
            statusError.value = err?.message || String(err);
            toast.error(statusError.value);
        } finally {
            savingConfig.value = false;
        }
    }

    function onToggleWorkerDirectProxy(nextEnabled) {
        const wantEnable = Boolean(nextEnabled);
        if (!wantEnable) {
            // Require explicit secondary confirmation before switching to official direct B2 egress.
            pendingDisableDirectProxyConfirm.value = true;
            return;
        }
        pendingDisableDirectProxyConfirm.value = false;
        persistWorkerDirectProxySetting(true);
    }

    async function confirmDisableWorkerDirectProxy() {
        await persistWorkerDirectProxySetting(false);
    }

    async function onToggleExtraStorage(nextEnabled) {
        const wantEnable = Boolean(nextEnabled);
        const hadUnsavedEdits = b2FormDirty.value;
        formEnabled.value = wantEnable;
        pendingDisableDirectProxyConfirm.value = false;
        statusError.value = '';
        statusNotice.value = '';

        // Auto-persist when toggling an already-configured B2 integration OFF or back ON so the switch takes effect immediately.
        const hasCompleteSavedConfig = Boolean(
            hasSavedSecret.value &&
                formEndpoint.value.trim() &&
                formBucket.value.trim() &&
                formAccessKeyId.value.trim()
        );
        if ((!wantEnable && savedEnabled.value) || (wantEnable && !savedEnabled.value && hasCompleteSavedConfig && !hadUnsavedEdits)) {
            if (savingConfig.value) return;
            savingConfig.value = true;
            try {
                const data = await cloudFetch('/api/storage/config', {
                    method: 'PUT',
                    json: { enabled: wantEnable }
                });
                applyStatusPayload(data, { forceFormSync: true });
                const msg = t('cloud_hub.storage.saved_toast');
                statusNotice.value = msg;
                toast.success(msg);
                await Promise.all([loadCleanupPreview(), loadCleanupBackups()]);
            } catch (err) {
                formEnabled.value = !wantEnable;
                statusError.value = err?.message || String(err);
                toast.error(statusError.value);
            } finally {
                savingConfig.value = false;
            }
            return;
        }

        b2FormDirty.value = wantEnable;
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
                    useWorkerDirectProxy: formUseWorkerDirectProxy.value,
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
            applyStatusPayload(data, { forceFormSync: true });
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
        Promise.all([loadQuota(), loadMysqlStatus(true), loadCleanupPreview(), loadCleanupBackups(), loadStatus(true)]);
    });
</script>
