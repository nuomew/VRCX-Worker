<template>
    <div class="space-y-3 text-xs">
        <SettingsItem
            :label="t('cloud_hub.migration.export_title')"
            :description="t('cloud_hub.migration.export_desc')">
            <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" :disabled="exporting" @click="startZipExport">
                    {{
                        exporting
                            ? t('cloud_hub.migration.exporting_btn')
                            : t('cloud_hub.migration.export_btn')
                    }}
                </Button>
                <Button
                    v-if="exporting"
                    size="sm"
                    variant="outline"
                    class="border-destructive/40 text-destructive hover:bg-destructive/10"
                    @click="cancelExport">
                    {{ t('cloud_hub.migration.export_cancel_btn') }}
                </Button>
            </div>
        </SettingsItem>

        <div class="rounded-lg border border-border bg-card/60 p-4 space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <label class="inline-flex items-center gap-2 text-foreground select-none cursor-pointer">
                    <input
                        v-model="includeLegacy"
                        type="checkbox"
                        class="rounded border-input"
                        :disabled="exporting" />
                    <span>{{ t('cloud_hub.migration.export_include_legacy_label') }}</span>
                </label>

                <span v-if="summaryInfo" class="font-mono text-[11px] text-muted-foreground">
                    {{
                        t('cloud_hub.migration.export_summary_loaded', {
                            active: summaryInfo.totalActiveRows.toLocaleString(),
                            legacy: summaryInfo.totalLegacyRows.toLocaleString()
                        })
                    }}
                </span>
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <label class="text-[11px] font-medium text-muted-foreground">
                    {{ t('cloud_hub.migration.export_account_prefix_label') }}
                </label>
                <input
                    v-model="accountPrefixInput"
                    type="text"
                    maxlength="64"
                    :disabled="exporting"
                    :placeholder="t('cloud_hub.migration.export_account_prefix_placeholder')"
                    class="w-64 rounded-md border border-input bg-background px-2.5 py-1 font-mono text-xs text-foreground" />
                <span class="text-[11px] text-muted-foreground">
                    {{ t('cloud_hub.migration.export_account_prefix_hint') }}
                </span>
            </div>

            <div v-if="exporting" class="space-y-1.5 pt-1">
                <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                        class="h-full rounded-full bg-primary transition-all duration-200"
                        :style="{ width: `${progressPercent}%` }" />
                </div>
                <div class="text-[11px] text-muted-foreground">
                    <template v-if="progressPhase === 'packaging'">
                        {{ t('cloud_hub.migration.export_packaging') }}
                    </template>
                    <template v-else>
                        {{
                            t('cloud_hub.migration.export_progress_table', {
                                table: progressTable || '...',
                                processed: progressProcessed.toLocaleString(),
                                total: progressTotal.toLocaleString()
                            })
                        }}
                    </template>
                </div>
            </div>

            <p class="text-[11px] text-muted-foreground leading-relaxed">
                {{ t('cloud_hub.migration.export_agent_tip') }}
            </p>

            <p v-if="exportError" class="text-[11px] text-destructive">{{ exportError }}</p>
        </div>
    </div>
</template>

<script setup>
    import { onBeforeUnmount, onMounted, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';
    import { Button } from '@/components/ui/button';
    import { cloudFetch } from '@/ipc-web/apiClient';
    import { deriveUpstreamUserPrefix, exportCloudDataToZip } from '@/ipc-web/cloudDataExport';
    import { cloudState } from '@/ipc-web/cloudState';
    import { useUserStore } from '@/stores';
    import SettingsItem from '@/views/Settings/components/SettingsItem.vue';

    const { t } = useI18n();
    const userStore = useUserStore();

    const includeLegacy = ref(true);
    const accountPrefixInput = ref('');
    const summaryInfo = ref(null);

    const exporting = ref(false);
    const progressPhase = ref('');
    const progressTable = ref('');
    const progressProcessed = ref(0);
    const progressTotal = ref(0);
    const progressPercent = ref(0);
    const exportError = ref('');

    let activeAbort = null;

    async function loadExportSummary() {
        if (!cloudState.authenticated) return;
        try {
            const data = await cloudFetch('/api/migration/export?scope=summary&includeLegacy=1');
            summaryInfo.value = {
                totalActiveRows: Number(data?.totalActiveRows || 0),
                totalLegacyRows: Number(data?.totalLegacyRows || 0)
            };
            if (!accountPrefixInput.value) {
                const livePrefix = deriveUpstreamUserPrefix(userStore.currentUser?.id || '');
                accountPrefixInput.value = data?.userPrefix || livePrefix || '';
            }
        } catch {
            // Non-fatal preview error
        }
    }

    function triggerZipDownload(zipBytes, fileName) {
        const blob = new Blob([zipBytes], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    async function startZipExport() {
        if (exporting.value) return;
        exporting.value = true;
        exportError.value = '';
        progressPhase.value = 'fetching';
        progressTable.value = '';
        progressProcessed.value = 0;
        progressTotal.value = 0;
        progressPercent.value = 2;

        activeAbort = new AbortController();
        try {
            const livePrefix = deriveUpstreamUserPrefix(userStore.currentUser?.id || '');
            const result = await exportCloudDataToZip({
                fetchJson: (path) => cloudFetch(path),
                includeLegacy: includeLegacy.value,
                userPrefixOverride: accountPrefixInput.value.trim() || livePrefix,
                signal: activeAbort.signal,
                onProgress: (info) => {
                    progressPhase.value = info.phase;
                    progressTable.value = info.table;
                    progressProcessed.value = info.processedRows;
                    progressTotal.value = info.totalRows;
                    progressPercent.value = info.percent;
                }
            });
            triggerZipDownload(result.zipBytes, result.fileName);
            toast.success(
                t('cloud_hub.migration.export_done_toast', {
                    rows: result.totalRows.toLocaleString(),
                    file: result.fileName
                })
            );
        } catch (err) {
            if (err?.name === 'AbortError') {
                toast.info(t('cloud_hub.migration.export_cancelled_toast'));
            } else {
                exportError.value = err?.message || String(err);
                toast.error(exportError.value);
            }
        } finally {
            exporting.value = false;
            activeAbort = null;
        }
    }

    function cancelExport() {
        activeAbort?.abort();
    }

    onMounted(() => {
        loadExportSummary();
    });

    onBeforeUnmount(() => {
        activeAbort?.abort();
    });
</script>
