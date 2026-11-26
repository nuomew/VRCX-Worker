<template>
    <div class="x-container flex w-full flex-col">
        <div class="mx-auto flex w-full max-w-2xl flex-col">
            <div class="shrink-0 p-1.5">
                <span class="text-lg font-semibold text-foreground">{{ t('view.settings.header') }}</span>
            </div>
            <TabsUnderline default-value="system" :items="settingsTabs" :unmount-on-hide="false" fill>
                <template #system>
                    <SystemTab />
                </template>
                <template #security>
                    <SecurityTab v-if="isWeb" />
                </template>
                <template #desktop_migration>
                    <DesktopMigrationTab v-if="isWeb" />
                </template>
                <template #storage>
                    <StorageTab v-if="isWeb" />
                </template>
                <template #interface>
                    <InterfaceTab />
                </template>
                <template #social>
                    <SocialTab />
                </template>
                <template #notifications>
                    <NotificationsTab />
                </template>
                <template #vr>
                    <VrTab />
                </template>
                <template #media>
                    <MediaTab />
                </template>
                <template #integrations>
                    <IntegrationsTab />
                </template>
                <template #advanced>
                    <AdvancedTab />
                </template>
            </TabsUnderline>
        </div>
    </div>
</template>

<script setup>
    import { computed, defineAsyncComponent, onBeforeMount } from 'vue';
    import { TabsUnderline } from '@/components/ui/tabs';
    import { useI18n } from 'vue-i18n';

    import AdvancedTab from './components/Tabs/AdvancedTab.vue';
    import InterfaceTab from './components/Tabs/InterfaceTab.vue';
    import IntegrationsTab from './components/Tabs/IntegrationsTab.vue';
    import MediaTab from './components/Tabs/MediaTab.vue';
    import NotificationsTab from './components/Tabs/NotificationsTab.vue';
    import SocialTab from './components/Tabs/SocialTab.vue';
    import SystemTab from './components/Tabs/SystemTab.vue';
    import VrTab from './components/Tabs/VrTab.vue';

    const SecurityTab = defineAsyncComponent(() => import('./components/Tabs/SecurityTab.vue'));
    const DesktopMigrationTab = defineAsyncComponent(() => import('./components/Tabs/DesktopMigrationTab.vue'));
    const StorageTab = defineAsyncComponent(() => import('./components/Tabs/StorageTab.vue'));

    const { t } = useI18n();
    const isWeb = typeof WEB !== 'undefined' && WEB;
    const settingsTabs = computed(() => {
        const tabs = [
            { value: 'system', label: t('view.settings.category.system') },
            ...(isWeb
                ? [
                      { value: 'security', label: t('cloud_hub.two_factor.tab_label') },
                      { value: 'desktop_migration', label: t('cloud_hub.migration.tab_label') },
                      { value: 'storage', label: t('cloud_hub.storage.tab_label') }
                  ]
                : []),
            { value: 'interface', label: t('view.settings.category.interface') },
            { value: 'social', label: t('view.settings.category.social') },
            { value: 'notifications', label: t('view.settings.category.notifications') },
            { value: 'vr', label: t('view.settings.category.vr') },
            { value: 'media', label: t('view.settings.category.media') },
            { value: 'integrations', label: t('view.settings.category.integrations') },
            { value: 'advanced', label: t('view.settings.category.advanced') }
        ];
        return isWeb ? tabs.filter((tab) => tab.value !== 'vr' && tab.value !== 'media') : tabs;
    });

    onBeforeMount(() => {
        const menuItem = document.querySelector('li[role="menuitem"].is-active');

        if (menuItem) {
            menuItem.classList.remove('is-active');
        }
    });
</script>
