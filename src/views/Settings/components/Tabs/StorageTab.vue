<template>
    <div class="flex flex-col gap-10 py-2">
        <CloudStorageSettings />
    </div>
</template>

<script setup>
    import { defineAsyncComponent } from 'vue';

    const CloudStorageSettings = defineAsyncComponent(
        () => import('@/components/cloud/CloudStorageSettings.vue')
    );
</script>
