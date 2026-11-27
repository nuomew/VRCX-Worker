<template>
    <Dialog :open="isTranslationApiDialogVisible" @update:open="(open) => (open ? null : closeDialog())">
        <DialogContent>
            <DialogHeader>
                <DialogTitle>{{ t('dialog.translation_api.header') }}</DialogTitle>
            </DialogHeader>
            <div class="options-container-item">
                <span class="name">{{ t('view.settings.appearance.appearance.bio_language') }}</span>
                <Select :model-value="bioLanguage" @update:modelValue="setBioLanguage">
                    <SelectTrigger size="sm" style="float: right">
                        <SelectValue :placeholder="String(getLanguageName(bioLanguage) || bioLanguage || '')" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectItem v-for="language in languageCodes" :key="language" :value="language">
                                {{ getLanguageName(language) }}
                            </SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
            </div>
            <br />
            <FieldGroup class="mb-3">
                <Field>
                    <FieldLabel>{{ t('dialog.translation_api.mode') }}</FieldLabel>
                    <FieldContent>
                        <Select
                            :model-value="form.translationApiType"
                            @update:modelValue="handleTranslationApiTypeChange">
                            <SelectTrigger size="sm" style="width: 100%">
                                <SelectValue :placeholder="t('dialog.translation_api.mode')" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    <SelectItem
                                        value="cloudflare"
                                        :text-value="t('dialog.translation_api.mode_cloudflare')">
                                        {{ t('dialog.translation_api.mode_cloudflare') }}
                                    </SelectItem>
                                    <SelectItem value="google" :text-value="t('dialog.translation_api.mode_google')">
                                        {{ t('dialog.translation_api.mode_google') }}
                                    </SelectItem>
                                    <SelectItem value="openai" :text-value="t('dialog.translation_api.mode_openai')">
                                        {{ t('dialog.translation_api.mode_openai') }}
                                    </SelectItem>
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </FieldContent>
                </Field>
            </FieldGroup>

            <template v-if="form.translationApiType === 'cloudflare'">
                <FieldGroup>
                    <div
                        class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
                        {{ t('dialog.translation_api.cloudflare.hint') }}
                    </div>

                    <Field>
                        <FieldLabel>{{ t('dialog.translation_api.cloudflare.preset') }}</FieldLabel>
                        <FieldContent>
                            <Select
                                :model-value="selectedCloudflarePreset"
                                @update:modelValue="handleCloudflarePresetChange">
                                <SelectTrigger size="sm" style="width: 100%">
                                    <SelectValue :placeholder="t('dialog.translation_api.cloudflare.preset')" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        <SelectItem
                                            v-for="preset in CLOUDFLARE_AI_TRANSLATION_PRESETS"
                                            :key="preset.id"
                                            :value="preset.id">
                                            {{ isZhLocale ? preset.labelZh : preset.label }}
                                        </SelectItem>
                                        <SelectItem value="__custom__">
                                            {{ t('dialog.translation_api.cloudflare.custom_option') }}
                                        </SelectItem>
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </FieldContent>
                    </Field>

                    <Field>
                        <FieldLabel>{{ t('dialog.translation_api.cloudflare.model') }}</FieldLabel>
                        <FieldContent>
                            <InputGroupField
                                v-model="form.translationApiModel"
                                :placeholder="DEFAULT_CLOUDFLARE_AI_MODEL"
                                clearable />
                        </FieldContent>
                    </Field>

                    <div
                        data-testid="cloudflare-quota-info"
                        class="rounded-md border px-3 py-2 text-xs leading-relaxed"
                        :class="
                            activeCloudflarePreset?.tier === 'paid'
                                ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        ">
                        <template v-if="activeCloudflarePreset">
                            {{ isZhLocale ? activeCloudflarePreset.quotaDetailZh : activeCloudflarePreset.quotaDetail }}
                        </template>
                        <template v-else>
                            {{ t('dialog.translation_api.cloudflare.custom_quota_hint') }}
                        </template>
                    </div>

                    <Field>
                        <FieldLabel>{{ t('dialog.translation_api.openai.prompt_optional') }}</FieldLabel>
                        <FieldContent>
                            <InputGroupTextareaField v-model="form.translationApiPrompt" :rows="3" clearable />
                        </FieldContent>
                    </Field>
                </FieldGroup>
            </template>

            <template v-if="form.translationApiType === 'google'">
                <FieldGroup>
                    <Field>
                        <FieldLabel>{{ t('dialog.translation_api.description') }}</FieldLabel>
                        <FieldContent>
                            <InputGroupField
                                v-model="form.translationApiKey"
                                type="password"
                                show-password
                                placeholder="AIzaSy..."
                                clearable />
                        </FieldContent>
                    </Field>
                </FieldGroup>
            </template>

            <template v-if="form.translationApiType === 'openai'">
                <FieldGroup>
                    <Field>
                        <FieldLabel>{{ t('dialog.translation_api.openai.endpoint') }}</FieldLabel>
                        <FieldContent>
                            <InputGroupField
                                v-model="form.translationApiEndpoint"
                                placeholder="https://api.openai.com/v1/chat/completions"
                                clearable />
                        </FieldContent>
                    </Field>

                    <Field>
                        <FieldLabel>{{ t('dialog.translation_api.openai.api_key') }}</FieldLabel>
                        <FieldContent>
                            <InputGroupField
                                v-model="form.translationApiKey"
                                type="password"
                                show-password
                                placeholder="sk-..."
                                clearable />
                        </FieldContent>
                    </Field>

                    <Field>
                        <FieldLabel>{{ t('dialog.translation_api.openai.model') }}</FieldLabel>
                        <FieldContent>
                            <div class="flex gap-2 items-start">
                                <div class="flex-1">
                                    <Select
                                        v-if="availableModels.length > 0"
                                        :model-value="form.translationApiModel"
                                        @update:modelValue="(value) => (form.translationApiModel = value)">
                                        <SelectTrigger size="sm" style="width: 100%">
                                            <SelectValue :placeholder="t('dialog.translation_api.openai.model')" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectGroup>
                                                <SelectItem
                                                    v-for="model in availableModels"
                                                    :key="model"
                                                    :value="model">
                                                    {{ model }}
                                                </SelectItem>
                                            </SelectGroup>
                                        </SelectContent>
                                    </Select>
                                    <InputGroupField
                                        v-else
                                        v-model="form.translationApiModel"
                                        clearable
                                        class="w-full" />
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    @click="fetchModels"
                                    :disabled="isFetchingModels || !form.translationApiEndpoint">
                                    {{
                                        isFetchingModels
                                            ? t('dialog.translation_api.fetching_models')
                                            : t('dialog.translation_api.fetch_models')
                                    }}
                                </Button>
                            </div>
                        </FieldContent>
                    </Field>

                    <Field>
                        <FieldLabel>{{ t('dialog.translation_api.openai.prompt_optional') }}</FieldLabel>
                        <FieldContent>
                            <InputGroupTextareaField v-model="form.translationApiPrompt" :rows="3" clearable />
                        </FieldContent>
                    </Field>
                </FieldGroup>
            </template>

            <DialogFooter>
                <Button
                    variant="outline"
                    v-if="form.translationApiType === 'google'"
                    @click="
                        openExternalLink(
                            'https://translatepress.com/docs/automatic-translation/generate-google-api-key/'
                        )
                    ">
                    {{ t('dialog.translation_api.guide') }}
                </Button>
                <Button
                    variant="outline"
                    v-if="form.translationApiType === 'openai' || form.translationApiType === 'cloudflare'"
                    @click="testTranslationConfig">
                    {{ t('dialog.translation_api.test') }}
                </Button>
                <Button @click="saveTranslationApiConfig">
                    {{ t('dialog.translation_api.save') }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>

<script setup>
    import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
    import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
    import { Field, FieldContent, FieldGroup, FieldLabel } from '@/components/ui/field';
    import { computed, reactive, ref, watch } from 'vue';
    import { InputGroupField, InputGroupTextareaField } from '@/components/ui/input-group';
    import { Button } from '@/components/ui/button';
    import { storeToRefs } from 'pinia';
    import { toast } from 'vue-sonner';
    import { useI18n } from 'vue-i18n';

    import { getLanguageName, languageCodes } from '../../../localization';
    import { openExternalLink } from '../../../shared/utils';
    import { useAdvancedSettingsStore } from '../../../stores';
    import {
        CLOUDFLARE_AI_TRANSLATION_PRESETS,
        DEFAULT_CLOUDFLARE_AI_MODEL
    } from '../../Tools/chatTranslatorUtils';

    const advancedSettingsStore = useAdvancedSettingsStore();

    const {
        bioLanguage,
        translationApi,
        translationApiKey,
        translationApiType,
        translationApiEndpoint,
        translationApiModel,
        translationApiPrompt
    } = storeToRefs(advancedSettingsStore);

    const {
        setBioLanguage,
        translateText,
        fetchAvailableModels,
        setTranslationApiKey,
        setTranslationApiType,
        setTranslationApiEndpoint,
        setTranslationApiModel,
        setTranslationApiPrompt
    } = advancedSettingsStore;

    const { t, locale } = useI18n();

    const isFetchingModels = ref(false);
    const availableModels = ref([]);
    const isZhLocale = computed(() => String(locale?.value || '').toLowerCase().startsWith('zh'));

    const props = defineProps({
        isTranslationApiDialogVisible: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['update:isTranslationApiDialogVisible']);

    function handleTranslationApiTypeChange(value) {
        const nextType = String(value);
        form.translationApiType = nextType;
        if (nextType === 'cloudflare' && (!form.translationApiModel || !form.translationApiModel.trim().startsWith('@'))) {
            form.translationApiModel = DEFAULT_CLOUDFLARE_AI_MODEL;
        }
    }

    const form = reactive({
        translationApiType: 'google',
        translationApiEndpoint: 'https://api.openai.com/v1/chat/completions',
        translationApiModel: '',
        translationApiPrompt: '',
        translationApiKey: ''
    });

    const activeCloudflarePreset = computed(() => {
        const trimmed = String(form.translationApiModel || '').trim();
        return CLOUDFLARE_AI_TRANSLATION_PRESETS.find((item) => item.id === trimmed) || null;
    });

    const selectedCloudflarePreset = computed(() => activeCloudflarePreset.value?.id || '__custom__');

    function handleCloudflarePresetChange(value) {
        const val = String(value || '');
        if (val && val !== '__custom__') {
            form.translationApiModel = val;
        }
    }

    const loadFormFromStore = () => {
        form.translationApiType = translationApiType.value || 'google';
        form.translationApiEndpoint = translationApiEndpoint.value || 'https://api.openai.com/v1/chat/completions';
        form.translationApiModel =
            translationApiModel.value || (form.translationApiType === 'cloudflare' ? DEFAULT_CLOUDFLARE_AI_MODEL : '');
        form.translationApiPrompt = translationApiPrompt.value || '';
        form.translationApiKey = translationApiKey.value || '';
        availableModels.value = [];
    };

    watch(
        () => props.isTranslationApiDialogVisible,
        (visible) => {
            if (visible) {
                loadFormFromStore();
            }
        },
        { immediate: true }
    );

    async function saveTranslationApiConfig() {
        if (form.translationApiType === 'openai') {
            if (!form.translationApiEndpoint || !form.translationApiModel) {
                toast.warning(t('dialog.translation_api.msg_fill_endpoint_model'));
                return;
            }
        }
        if (form.translationApiType === 'cloudflare') {
            const trimmedModel = String(form.translationApiModel || '').trim();
            if (!trimmedModel) {
                form.translationApiModel = DEFAULT_CLOUDFLARE_AI_MODEL;
            } else {
                form.translationApiModel = trimmedModel;
            }
        }

        await Promise.all([
            setTranslationApiType(form.translationApiType),
            setTranslationApiEndpoint(form.translationApiEndpoint),
            setTranslationApiModel(form.translationApiModel),
            setTranslationApiPrompt(form.translationApiPrompt),
            setTranslationApiKey(form.translationApiKey)
        ]);

        // Auto-enable the global translation switch when saving built-in Workers AI so chat/bio translation works immediately
        if (
            form.translationApiType === 'cloudflare' &&
            translationApi &&
            !translationApi.value &&
            typeof advancedSettingsStore.setTranslationApi === 'function'
        ) {
            await advancedSettingsStore.setTranslationApi();
        }

        toast.success(t('dialog.translation_api.msg_settings_saved'));
        closeDialog();
    }

    async function fetchModels() {
        if (!form.translationApiEndpoint) {
            toast.warning(t('dialog.translation_api.msg_endpoint_required'));
            return;
        }

        isFetchingModels.value = true;
        try {
            const models = await fetchAvailableModels({
                endpoint: form.translationApiEndpoint,
                key: form.translationApiKey
            });

            if (models && models.length > 0) {
                availableModels.value = models;
                toast.success(t('dialog.translation_api.msg_models_fetched', { count: models.length }));
            } else {
                availableModels.value = [];
                toast.warning(t('dialog.translation_api.msg_no_models_found'));
            }
        } catch (err) {
            console.error('[TranslationAPI] Failed to fetch models', err);
        } finally {
            isFetchingModels.value = false;
        }
    }

    async function testTranslationConfig() {
        if (form.translationApiType === 'cloudflare') {
            const model = String(form.translationApiModel || '').trim() || DEFAULT_CLOUDFLARE_AI_MODEL;
            try {
                const testText = 'Hello world';
                const target = isZhLocale.value ? 'zh-CN' : 'fr';
                const data = await translateText(testText, target, {
                    type: 'cloudflare',
                    model,
                    prompt: form.translationApiPrompt,
                    allowWhenDisabled: true
                });
                if (data) {
                    toast.success(`${t('dialog.translation_api.msg_test_success')}: ${data}`);
                } else {
                    toast.error(t('dialog.translation_api.msg_test_failed'));
                }
            } catch (err) {
                console.error('[TranslationAPI] Workers AI test failed', err);
                toast.error(t('dialog.translation_api.msg_test_failed'));
            }
            return;
        }

        if (form.translationApiType !== 'openai') {
            return;
        }
        if (!form.translationApiEndpoint || !form.translationApiModel) {
            toast.warning(t('dialog.translation_api.msg_fill_endpoint_model'));
            return;
        }

        try {
            const testText = 'Hello world';
            const data = await translateText(testText, 'fr', {
                type: form.translationApiType,
                endpoint: form.translationApiEndpoint,
                model: form.translationApiModel,
                prompt: form.translationApiPrompt,
                key: form.translationApiKey
            });
            if (data) {
                toast.success(t('dialog.translation_api.msg_test_success'));
            } else {
                console.error('[TranslationAPI] Test returned empty result');
                toast.error(t('dialog.translation_api.msg_test_failed'));
            }
        } catch (err) {
            console.error('[TranslationAPI] Test failed', err);
            toast.error(t('dialog.translation_api.msg_test_failed'));
        }
    }

    function closeDialog() {
        emit('update:isTranslationApiDialogVisible', false);
    }
</script>
