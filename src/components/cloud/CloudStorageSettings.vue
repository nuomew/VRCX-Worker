<template>
    <div class="space-y-4 text-xs">
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
                <label class="inline-flex items-center gap-2 select-none cursor-pointer text-foreground">
                    <input
                        v-model="formEnabled"
                        type="checkbox"
                        class="rounded border-input"
                        :disabled="savingConfig" />
                    <span class="font-medium">{{ t('cloud_hub.storage.enable_extra_label') }}</span>
                </label>
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
                <Button size="sm" variant="outline" :disabled="testingB2 || savingConfig" @click="testB2Connection">
                    {{ testingB2 ? t('cloud_hub.storage.testing') : t('cloud_hub.storage.test_btn') }}
                </Button>
            </div>

            <p v-if="statusNotice" class="text-[11px] text-primary">{{ statusNotice }}</p>
            <p v-if="statusError" class="text-[11px] text-destructive break-all">{{ statusError }}</p>
        </div>
    </div>
</template>

<script setup>
    import { onMounted, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';
    import { Button } from '@/components/ui/button';
    import { cloudFetch } from '@/ipc-web/apiClient';
    import { cloudState } from '@/ipc-web/cloudState';

    const { t } = useI18n();

    const loadingStatus = ref(false);
    const savingConfig = ref(false);
    const testingB2 = ref(false);

    const r2Usage = ref(null);
    const b2Usage = ref(null);
    const overflowActive = ref(false);
    const hasSavedSecret = ref(false);

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

    function applyStatusPayload(data) {
        if (!data) return;
        r2Usage.value = data.r2 ?? null;
        b2Usage.value = data.b2 ?? null;
        overflowActive.value = Boolean(data.overflowActive);
        const ext = data.externalStorage;
        if (ext) {
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
        loadStatus(true);
    });
</script>
