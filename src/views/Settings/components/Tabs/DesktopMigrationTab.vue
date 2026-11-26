<template>
    <div class="flex flex-col gap-10 py-2">
        <SettingsGroup :title="t('cloud_hub.migration.section_title')">
            <CloudDesktopMigrationSettings />
        </SettingsGroup>
        <SettingsGroup :title="t('cloud_hub.migration.export_section_title')">
            <CloudDataExportSettings />
        </SettingsGroup>
    </div>
</template>

<script setup>
    import { defineAsyncComponent } from 'vue';
    import { useI18n } from 'vue-i18n';

    import SettingsGroup from '../SettingsGroup.vue';

    const { t } = useI18n();
    const CloudDesktopMigrationSettings = defineAsyncComponent(
        () => import('@/components/cloud/CloudDesktopMigrationSettings.vue')
    );
    const CloudDataExportSettings = defineAsyncComponent(
        () => import('@/components/cloud/CloudDataExportSettings.vue')
    );
</script>
