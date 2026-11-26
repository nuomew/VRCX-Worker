<template>
    <div class="flex flex-col gap-10 py-2">
        <SettingsGroup :title="t('cloud_hub.two_factor.section_title')">
            <CloudTwoFactorSettings />
        </SettingsGroup>
        <SettingsGroup :title="t('cloud_hub.static_passcode.section_title')">
            <CloudStaticPasscodeSettings />
        </SettingsGroup>
    </div>
</template>

<script setup>
    import { defineAsyncComponent } from 'vue';
    import { useI18n } from 'vue-i18n';

    import SettingsGroup from '../SettingsGroup.vue';

    const { t } = useI18n();
    const CloudTwoFactorSettings = defineAsyncComponent(
        () => import('@/components/cloud/CloudTwoFactorSettings.vue')
    );
    const CloudStaticPasscodeSettings = defineAsyncComponent(
        () => import('@/components/cloud/CloudStaticPasscodeSettings.vue')
    );
</script>
