<template>
    <div class="space-y-4 text-xs">
        <!-- Intro & Primary "Fetch from Desktop" Action -->
        <SettingsItem
            :label="t('cloud_hub.migration.title')"
            :description="t('cloud_hub.migration.desc')">
            <div class="flex flex-wrap items-center gap-2">
                <select
                    v-if="devices.length > 1"
                    v-model="selectedDeviceId"
                    class="rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground dark:[color-scheme:dark]">
                    <option
                        v-for="dev in devices"
                        :key="dev.deviceId"
                        class="bg-card text-foreground"
                        :value="dev.deviceId">
                        {{ dev.deviceName }} ({{
                            dev.online
                                ? t('cloud_hub.migration.device_online')
                                : t('cloud_hub.migration.device_offline')
                        }})
                    </option>
                </select>
                <Button
                    size="sm"
                    :disabled="scanning || isJobActive || !legacyDbBound || devices.length === 0"
                    @click="requestDesktopScan">
                    {{
                        scanning
                            ? t('cloud_hub.migration.scanning_btn')
                            : t('cloud_hub.migration.fetch_desktop_btn')
                    }}
                </Button>
                <Button size="sm" variant="outline" :disabled="loadingState" @click="loadMigrationState">
                    {{ t('cloud_hub.migration.refresh_btn') }}
                </Button>
            </div>
        </SettingsItem>

        <!-- Dedicated Legacy D1 Storage Usage Card -->
        <div class="rounded-lg border border-border bg-card/60 p-4 space-y-2.5">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="font-medium text-foreground">
                        {{ t('cloud_hub.migration.legacy_db_title') }}
                    </span>
                    <span class="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                        DB_LEGACY (vrcx-legacy)
                    </span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="font-mono text-foreground">
                        {{ formatBytes(legacyDbBytes) }} / {{ formatBytes(legacyDbLimitBytes) }}
                    </span>
                    <Button
                        v-if="totalImportedRows > 0 && !showClearConfirm"
                        size="sm"
                        variant="outline"
                        class="h-7 border-destructive/40 px-2.5 text-[11px] text-destructive hover:bg-destructive/10"
                        :disabled="isJobActive || clearingData"
                        @click="showClearConfirm = true">
                        {{ t('cloud_hub.migration.clear_data_btn') }}
                    </Button>
                </div>
            </div>

            <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div class="flex h-full w-full">
                    <div
                        class="h-full bg-primary transition-all"
                        :style="{ width: `${Math.min(100, legacyDbPercent)}%` }" />
                    <div
                        v-if="selectedEstimatedBytes > 0"
                        class="h-full transition-all"
                        :class="projectedExceedsLimit ? 'bg-destructive/80' : 'bg-primary/45'"
                        :style="{ width: `${Math.min(100 - Math.min(100, legacyDbPercent), projectedDeltaPercent)}%` }" />
                </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                    {{
                        t('cloud_hub.migration.legacy_db_usage_hint', {
                            used: formatBytes(legacyDbBytes),
                            percent: legacyDbPercent,
                            rows: totalImportedRows.toLocaleString()
                        })
                    }}
                </span>
                <span v-if="devices.length === 0" class="text-destructive">
                    {{ t('cloud_hub.migration.no_agent_hint') }}
                </span>
                <span v-else-if="!hasOnlineDevice" class="text-muted-foreground">
                    {{ t('cloud_hub.migration.agent_offline_hint') }}
                </span>
            </div>

            <div
                v-if="showClearConfirm"
                class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                <span class="text-[11px] text-destructive">
                    {{ t('cloud_hub.migration.clear_confirm_desc') }}
                </span>
                <div class="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="destructive"
                        class="h-7 px-2.5 text-[11px]"
                        :disabled="clearingData"
                        @click="clearLegacyData">
                        {{
                            clearingData
                                ? t('cloud_hub.migration.clearing')
                                : t('cloud_hub.migration.confirm_clear_btn')
                        }}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        class="h-7 px-2.5 text-[11px]"
                        @click="showClearConfirm = false">
                        {{ t('cloud_hub.two_factor.cancel_btn') }}
                    </Button>
                </div>
            </div>

            <p v-if="!legacyDbBound" class="text-[11px] text-destructive">
                {{ t('cloud_hub.migration.legacy_db_unbound') }}
            </p>
        </div>

        <!-- Waiting for Scan Notice -->
        <div
            v-if="waitingForScan"
            class="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-muted-foreground">
            {{ t('cloud_hub.migration.waiting_scan_hint', { seconds: syncIntervalSeconds }) }}
        </div>

        <!-- Active / Recent Migration Job Progress -->
        <div
            v-if="job && job.jobId"
            class="rounded-lg border border-border bg-card/60 p-4 space-y-2.5">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="font-medium text-foreground">{{ t('cloud_hub.migration.job_heading') }}</span>
                    <span
                        class="rounded-full border px-2 py-0.5 text-[11px] font-medium"
                        :class="jobStatusBadgeClass">
                        {{ jobStatusLabel }}
                    </span>
                </div>
                <Button
                    v-if="isJobActive"
                    size="sm"
                    variant="outline"
                    class="h-7 border-destructive/40 px-2.5 text-[11px] text-destructive hover:bg-destructive/10"
                    :disabled="cancellingJob"
                    @click="cancelMigrationJob">
                    {{
                        cancellingJob
                            ? t('cloud_hub.migration.cancelling')
                            : t('cloud_hub.migration.cancel_job_btn')
                    }}
                </Button>
            </div>

            <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                    class="h-full bg-primary transition-all"
                    :style="{ width: `${jobProgressPercent}%` }" />
            </div>

            <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                    {{
                        t('cloud_hub.migration.job_stats', {
                            processed: (job.processedRows || 0).toLocaleString(),
                            total: Math.max(job.totalEstimatedRows || 0, job.processedRows || 0).toLocaleString(),
                            inserted: (job.insertedRows || 0).toLocaleString(),
                            skipped: (job.skippedRows || 0).toLocaleString()
                        })
                    }}
                </span>
                <span v-if="job.currentCategory && isJobActive">
                    {{ t('cloud_hub.migration.current_category', { name: categoryLabel(job.currentCategory) }) }}
                </span>
            </div>
            <p v-if="job.errorMessage" class="text-[11px] text-destructive">{{ job.errorMessage }}</p>
        </div>

        <!-- Desktop Inventory & Manual Category Selection (ALL OFF BY DEFAULT) -->
        <div v-if="inventory" class="rounded-lg border border-border bg-card/60 p-4 space-y-4">
            <div class="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 pb-3">
                <div class="space-y-0.5">
                    <div class="font-medium text-foreground">
                        {{ t('cloud_hub.migration.inventory_heading', { device: inventory.deviceName || inventory.deviceId }) }}
                    </div>
                    <div class="text-[11px] text-muted-foreground">
                        <template v-if="inventory.dbFound">
                            {{
                                t('cloud_hub.migration.inventory_found_meta', {
                                    file: inventory.dbFileName,
                                    size: formatBytes(inventory.dbFileBytes),
                                    time: formatDateTime(inventory.scannedAt)
                                })
                            }}
                        </template>
                        <template v-else>
                            {{ inventory.errorMessage || t('cloud_hub.migration.inventory_not_found') }}
                        </template>
                    </div>
                </div>

                <!-- Optional Account Selector when multiple desktop VRCX accounts exist -->
                <div v-if="inventory.dbFound && inventoryAccounts.length > 0" class="flex items-center gap-2">
                    <label class="text-[11px] text-muted-foreground">
                        {{ t('cloud_hub.migration.account_label') }}
                    </label>
                    <select
                        v-model="selectedAccountPrefix"
                        class="rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground dark:[color-scheme:dark]"
                        @change="resetSelectionsToOff">
                        <option
                            v-for="acc in inventoryAccounts"
                            :key="acc.prefix"
                            class="bg-card text-foreground"
                            :value="acc.prefix">
                            {{ acc.label }}
                        </option>
                    </select>
                </div>
            </div>

            <template v-if="inventory.dbFound">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="text-[11px] text-muted-foreground">
                        {{ t('cloud_hub.migration.default_off_hint') }}
                    </span>
                    <div class="flex items-center gap-2">
                        <Button size="sm" variant="outline" class="h-7 px-2.5 text-[11px]" @click="selectLightweightCategories">
                            {{ t('cloud_hub.migration.select_lightweight_btn') }}
                        </Button>
                        <Button size="sm" variant="outline" class="h-7 px-2.5 text-[11px]" @click="resetSelectionsToOff">
                            {{ t('cloud_hub.migration.clear_selection_btn') }}
                        </Button>
                    </div>
                </div>

                <!-- Category Checklist -->
                <div class="divide-y divide-border/60 rounded-md border border-border">
                    <label
                        v-for="item in mergedCategoryList"
                        :key="item.key"
                        class="flex items-start justify-between gap-3 px-3 py-2.5 transition-colors"
                        :class="
                            item.rowCount > 0 && !isJobActive && !wouldExceedLimit(item)
                                ? 'cursor-pointer hover:bg-accent/40'
                                : 'cursor-not-allowed opacity-55'
                        ">
                        <div class="flex items-start gap-2.5 min-w-0">
                            <input
                                type="checkbox"
                                class="mt-0.5 rounded border-input"
                                :checked="Boolean(selectedCategories[item.key])"
                                :disabled="item.rowCount <= 0 || isJobActive || wouldExceedLimit(item)"
                                @change="toggleCategory(item.key, $event.target.checked, item)" />
                            <div class="min-w-0 space-y-0.5">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="font-medium text-foreground">{{ categoryLabel(item.key) }}</span>
                                    <span
                                        v-if="importedStats[item.key] > 0"
                                        class="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                        {{ t('cloud_hub.migration.already_imported_badge', { count: importedStats[item.key].toLocaleString() }) }}
                                    </span>
                                    <span
                                        v-if="wouldExceedLimit(item)"
                                        class="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                                        {{ t('cloud_hub.migration.exceeds_500mb_badge') }}
                                    </span>
                                </div>
                                <div class="text-[11px] text-muted-foreground">
                                    {{ categoryDesc(item.key) }}
                                </div>
                            </div>
                        </div>

                        <div class="shrink-0 text-right space-y-0.5">
                            <div class="font-mono font-medium text-foreground">
                                {{ t('cloud_hub.migration.est_size_prefix') }} {{ formatBytes(item.estimatedDbBytes) }}
                            </div>
                            <div class="font-mono text-[11px] text-muted-foreground">
                                {{ t('cloud_hub.migration.row_count_label', { count: item.rowCount.toLocaleString() }) }}
                            </div>
                        </div>
                    </label>
                </div>

                <!-- Live Selected Estimated Footprint Summary + Start Action -->
                <div class="rounded-md border border-border bg-muted/30 p-3 space-y-2.5">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="space-y-0.5">
                            <div class="font-medium text-foreground">
                                {{
                                    t('cloud_hub.migration.selected_summary', {
                                        count: selectedCategoryKeys.length,
                                        rows: selectedTotalRows.toLocaleString(),
                                        size: formatBytes(selectedEstimatedBytes)
                                    })
                                }}
                            </div>
                            <div
                                class="text-[11px]"
                                :class="
                                    projectedExceedsLimit
                                        ? 'text-destructive font-medium'
                                        : projectedNearLimit
                                          ? 'text-amber-500 font-medium'
                                          : 'text-muted-foreground'
                                ">
                                {{
                                    t('cloud_hub.migration.projected_total_summary', {
                                        total: formatBytes(projectedTotalBytes),
                                        limit: formatBytes(legacyDbLimitBytes),
                                        percent: projectedTotalPercent
                                    })
                                }}
                            </div>
                        </div>
                        <Button
                            size="sm"
                            :disabled="
                                startingJob ||
                                isJobActive ||
                                selectedCategoryKeys.length === 0 ||
                                projectedExceedsLimit ||
                                !legacyDbBound
                            "
                            @click="startMigration">
                            {{
                                startingJob
                                    ? t('cloud_hub.migration.starting_btn')
                                    : t('cloud_hub.migration.start_sync_btn')
                            }}
                        </Button>
                    </div>
                    <p v-if="projectedExceedsLimit" class="text-[11px] text-destructive">
                        {{ t('cloud_hub.migration.quota_exceeded_warning') }}
                    </p>
                </div>
            </template>
        </div>

        <!-- Empty State before First Desktop Fetch -->
        <div
            v-else
            class="rounded-lg border border-dashed border-border p-4 text-center text-muted-foreground space-y-1">
            <div>{{ t('cloud_hub.migration.empty_inventory_title') }}</div>
            <div class="text-[11px]">{{ t('cloud_hub.migration.empty_inventory_desc') }}</div>
        </div>

        <p v-if="actionError" class="text-[11px] text-destructive">{{ actionError }}</p>
    </div>
</template>

<script setup>
    import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';
    import { Button } from '@/components/ui/button';
    import { cloudFetch } from '@/ipc-web/apiClient';
    import { cloudState } from '@/ipc-web/cloudState';
    import SettingsItem from '@/views/Settings/components/SettingsItem.vue';

    const { t } = useI18n();

    const CATEGORY_ORDER = [
        'memos_notes',
        'favorites',
        'avatar_history',
        'friend_log',
        'notifications',
        'moderation_profiles',
        'settings',
        'gamelog',
        'feed'
    ];
    const LIGHTWEIGHT_CATEGORIES = ['memos_notes', 'favorites', 'avatar_history', 'friend_log', 'moderation_profiles'];
    const WARN_LIMIT_BYTES = 400 * 1024 * 1024;

    const loadingState = ref(false);
    const scanning = ref(false);
    const waitingForScan = ref(false);
    const scanRequestedAtMs = ref(0);
    const startingJob = ref(false);
    const cancellingJob = ref(false);
    const clearingData = ref(false);
    const showClearConfirm = ref(false);
    const actionError = ref('');

    const legacyDbBound = ref(true);
    const legacyDbBytes = ref(0);
    const legacyDbLimitBytes = ref(500 * 1024 * 1024);
    const legacyDbPercent = ref(0);
    const syncIntervalSeconds = ref(60);
    const devices = ref([]);
    const selectedDeviceId = ref('');
    const inventory = ref(null);
    const job = ref(null);
    const importedStats = reactive({
        memos_notes: 0,
        favorites: 0,
        avatar_history: 0,
        friend_log: 0,
        notifications: 0,
        moderation_profiles: 0,
        gamelog: 0,
        feed: 0,
        settings: 0
    });

    // All migration categories are strictly disabled (unchecked) by default.
    const selectedCategories = reactive(Object.fromEntries(CATEGORY_ORDER.map((k) => [k, false])));
    const selectedAccountPrefix = ref('');

    let pollTimer = null;
    let lastCompletedJobId = '';

    const hasOnlineDevice = computed(() => devices.value.some((d) => d.online));
    const inventoryAccounts = computed(() => (Array.isArray(inventory.value?.accounts) ? inventory.value.accounts : []));
    const isJobActive = computed(() => job.value?.status === 'queued' || job.value?.status === 'running');
    const totalImportedRows = computed(() =>
        Object.values(importedStats).reduce((sum, n) => sum + (Number.isFinite(Number(n)) ? Number(n) : 0), 0)
    );

    const mergedCategoryList = computed(() => {
        if (!inventory.value?.dbFound) return [];
        const byKey = new Map();
        for (const key of CATEGORY_ORDER) {
            byKey.set(key, { key, rowCount: 0, rawBytes: 0, estimatedDbBytes: 0, tables: [] });
        }
        for (const item of inventory.value.sharedCategories || []) {
            if (!byKey.has(item.key)) continue;
            const slot = byKey.get(item.key);
            slot.rowCount += Number(item.rowCount || 0);
            slot.rawBytes += Number(item.rawBytes || 0);
            slot.estimatedDbBytes += Number(item.estimatedDbBytes || 0);
            slot.tables = [...slot.tables, ...(item.tables || [])];
        }
        const activeAccount = inventoryAccounts.value.find((a) => a.prefix === selectedAccountPrefix.value);
        if (activeAccount) {
            for (const item of activeAccount.categories || []) {
                if (!byKey.has(item.key)) continue;
                const slot = byKey.get(item.key);
                slot.rowCount += Number(item.rowCount || 0);
                slot.rawBytes += Number(item.rawBytes || 0);
                slot.estimatedDbBytes += Number(item.estimatedDbBytes || 0);
                slot.tables = [...slot.tables, ...(item.tables || [])];
            }
        }
        return CATEGORY_ORDER.map((k) => byKey.get(k));
    });

    const selectedCategoryKeys = computed(() =>
        mergedCategoryList.value
            .filter((item) => item.rowCount > 0 && selectedCategories[item.key])
            .map((item) => item.key)
    );
    const selectedTotalRows = computed(() =>
        mergedCategoryList.value
            .filter((item) => item.rowCount > 0 && selectedCategories[item.key])
            .reduce((sum, item) => sum + item.rowCount, 0)
    );
    const selectedEstimatedBytes = computed(() =>
        mergedCategoryList.value
            .filter((item) => item.rowCount > 0 && selectedCategories[item.key])
            .reduce((sum, item) => sum + item.estimatedDbBytes, 0)
    );
    const projectedTotalBytes = computed(() => legacyDbBytes.value + selectedEstimatedBytes.value);
    const projectedTotalPercent = computed(() =>
        Number(((projectedTotalBytes.value / Math.max(1, legacyDbLimitBytes.value)) * 100).toFixed(2))
    );
    const projectedDeltaPercent = computed(() =>
        Number(((selectedEstimatedBytes.value / Math.max(1, legacyDbLimitBytes.value)) * 100).toFixed(2))
    );
    const projectedNearLimit = computed(() => projectedTotalBytes.value >= WARN_LIMIT_BYTES);
    const projectedExceedsLimit = computed(
        () =>
            selectedEstimatedBytes.value > legacyDbLimitBytes.value ||
            projectedTotalBytes.value > legacyDbLimitBytes.value
    );

    function wouldExceedLimit(item) {
        if (!item || selectedCategories[item.key] || item.rowCount <= 0) return false;
        const nextSelected = selectedEstimatedBytes.value + Number(item.estimatedDbBytes || 0);
        return nextSelected > legacyDbLimitBytes.value || legacyDbBytes.value + nextSelected > legacyDbLimitBytes.value;
    }

    const jobProgressPercent = computed(() => {
        if (!job.value) return 0;
        if (job.value.status === 'completed') return 100;
        const total = Math.max(1, Number(job.value.totalEstimatedRows || 0));
        return Math.min(99, Math.round((Number(job.value.processedRows || 0) / total) * 100));
    });

    const jobStatusLabel = computed(() => {
        const s = job.value?.status || '';
        return t(`cloud_hub.migration.status_${s || 'idle'}`);
    });

    const jobStatusBadgeClass = computed(() => {
        const s = job.value?.status;
        if (s === 'completed') return 'border-status-online/40 bg-status-online/10 text-foreground';
        if (s === 'failed' || s === 'stopped_quota_limit') return 'border-destructive/40 bg-destructive/10 text-destructive';
        if (s === 'queued' || s === 'running') return 'border-primary/40 bg-primary/10 text-primary';
        return 'border-border bg-muted/50 text-muted-foreground';
    });

    function categoryLabel(key) {
        return t(`cloud_hub.migration.cat_${key}_label`);
    }

    function categoryDesc(key) {
        return t(`cloud_hub.migration.cat_${key}_desc`);
    }

    function formatBytes(bytes) {
        const n = Number(bytes || 0);
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    }

    function formatDateTime(iso) {
        if (!iso) return '-';
        const dt = new Date(iso);
        if (Number.isNaN(dt.getTime())) return iso;
        const pad = (v) => String(v).padStart(2, '0');
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
    }

    function toggleCategory(key, checked, item = null) {
        if (checked) {
            const target = item || mergedCategoryList.value.find((c) => c.key === key);
            if (target && wouldExceedLimit(target)) {
                selectedCategories[key] = false;
                toast.warning(t('cloud_hub.migration.exceeds_500mb_toast'));
                return;
            }
        }
        selectedCategories[key] = Boolean(checked);
    }

    function resetSelectionsToOff() {
        for (const key of CATEGORY_ORDER) {
            selectedCategories[key] = false;
        }
    }

    function selectLightweightCategories() {
        resetSelectionsToOff();
        let runningBytes = legacyDbBytes.value;
        const candidates = mergedCategoryList.value
            .filter((item) => item.rowCount > 0 && LIGHTWEIGHT_CATEGORIES.includes(item.key))
            .sort((a, b) => a.estimatedDbBytes - b.estimatedDbBytes);
        for (const item of candidates) {
            const itemBytes = Number(item.estimatedDbBytes || 0);
            if (runningBytes + itemBytes <= legacyDbLimitBytes.value) {
                selectedCategories[item.key] = true;
                runningBytes += itemBytes;
            }
        }
    }

    function ensurePolling() {
        const shouldPoll = waitingForScan.value || isJobActive.value;
        if (shouldPoll && !pollTimer) {
            pollTimer = setInterval(() => {
                loadMigrationState({ silent: true });
            }, 2500);
        } else if (!shouldPoll && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    async function loadMigrationState({ silent = false } = {}) {
        if (!cloudState.authenticated) return;
        if (!silent) {
            loadingState.value = true;
            actionError.value = '';
        }
        try {
            const data = await cloudFetch('/api/migration/state');
            legacyDbBound.value = data?.legacyDbBound !== false;
            legacyDbBytes.value = Number(data?.legacyDbBytes || 0);
            legacyDbLimitBytes.value = Number(data?.legacyDbLimitBytes || 500 * 1024 * 1024);
            legacyDbPercent.value = Number(data?.legacyDbPercent || 0);
            syncIntervalSeconds.value = Number(data?.syncIntervalSeconds || 60);
            devices.value = Array.isArray(data?.devices) ? data.devices : [];
            if (!selectedDeviceId.value && devices.value.length > 0) {
                const onlineFirst = devices.value.find((d) => d.online) || devices.value[0];
                selectedDeviceId.value = onlineFirst.deviceId;
            }

            const prevScannedAt = inventory.value?.scannedAt || '';
            inventory.value = data?.inventory || null;
            if (inventory.value?.scannedAt && inventory.value.scannedAt !== prevScannedAt) {
                const scannedMs = Date.parse(inventory.value.scannedAt);
                if (waitingForScan.value && Number.isFinite(scannedMs) && scannedMs >= scanRequestedAtMs.value - 2000) {
                    waitingForScan.value = false;
                    resetSelectionsToOff();
                    toast.success(t('cloud_hub.migration.scan_completed_toast'));
                }
            }
            if (inventoryAccounts.value.length > 0) {
                const exists = inventoryAccounts.value.some((a) => a.prefix === selectedAccountPrefix.value);
                if (!exists) {
                    selectedAccountPrefix.value = inventoryAccounts.value[0].prefix;
                }
            } else {
                selectedAccountPrefix.value = '';
            }

            const nextStats = data?.importedStats || {};
            for (const key of CATEGORY_ORDER) {
                importedStats[key] = Number(nextStats[key] || 0);
            }

            const prevStatus = job.value?.status;
            job.value = data?.job || null;
            if (
                job.value?.status === 'completed' &&
                prevStatus &&
                prevStatus !== 'completed' &&
                job.value.jobId !== lastCompletedJobId
            ) {
                lastCompletedJobId = job.value.jobId;
                toast.success(t('cloud_hub.migration.job_completed_toast'));
            }
        } catch (err) {
            if (!silent) {
                actionError.value = err?.message || String(err);
            }
        } finally {
            if (!silent) {
                loadingState.value = false;
            }
            ensurePolling();
        }
    }

    async function requestDesktopScan() {
        if (scanning.value) return;
        scanning.value = true;
        actionError.value = '';
        try {
            const res = await cloudFetch('/api/migration/scan', {
                method: 'POST',
                json: { deviceId: selectedDeviceId.value || undefined }
            });
            scanRequestedAtMs.value = Date.parse(res?.requestedAt || '') || Date.now();
            waitingForScan.value = true;
            toast.info(t('cloud_hub.migration.scan_dispatched_toast'));
            ensurePolling();
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            scanning.value = false;
        }
    }

    async function startMigration() {
        if (startingJob.value || selectedCategoryKeys.value.length === 0) return;
        startingJob.value = true;
        actionError.value = '';
        try {
            const res = await cloudFetch('/api/migration/start', {
                method: 'POST',
                json: {
                    deviceId: selectedDeviceId.value || inventory.value?.deviceId || undefined,
                    accountPrefix: selectedAccountPrefix.value || '',
                    categories: selectedCategoryKeys.value
                }
            });
            job.value = res?.job || null;
            toast.success(t('cloud_hub.migration.job_started_toast'));
            ensurePolling();
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            startingJob.value = false;
        }
    }

    async function cancelMigrationJob() {
        if (cancellingJob.value) return;
        cancellingJob.value = true;
        actionError.value = '';
        try {
            const res = await cloudFetch('/api/migration/cancel', { method: 'POST', json: {} });
            if (res?.job) {
                job.value = res.job;
            }
            toast.info(t('cloud_hub.migration.job_cancelled_toast'));
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            cancellingJob.value = false;
            ensurePolling();
        }
    }

    async function clearLegacyData() {
        if (clearingData.value) return;
        clearingData.value = true;
        actionError.value = '';
        try {
            await cloudFetch('/api/migration/data', { method: 'DELETE' });
            showClearConfirm.value = false;
            toast.success(t('cloud_hub.migration.cleared_toast'));
            await loadMigrationState();
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            clearingData.value = false;
        }
    }

    onMounted(() => {
        resetSelectionsToOff();
        loadMigrationState();
    });

    onBeforeUnmount(() => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    });
</script>
