<template>
    <div class="flex flex-col gap-10 py-2">
        <SettingsGroup :title="t('cloud_hub.storage.section_title')">
            <CloudStorageSettings />
        </SettingsGroup>
    </div>
</template>

<script setup>
    import { defineAsyncComponent } from 'vue';
    import { useI18n } from 'vue-i18n';

    import SettingsGroup from '../SettingsGroup.vue';

    const { t } = useI18n();
    const CloudStorageSettings = defineAsyncComponent(
        () => import('@/components/cloud/CloudStorageSettings.vue')
    );
</script>
