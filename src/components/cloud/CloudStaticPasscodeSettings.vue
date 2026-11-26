<template>
    <div class="space-y-3">
        <!-- Main status & primary toggle action -->
        <SettingsItem
            :label="t('cloud_hub.static_passcode.title')"
            :description="t('cloud_hub.static_passcode.desc')">
            <div class="flex flex-wrap items-center gap-2">
                <span
                    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
                    :class="
                        enabled
                            ? 'border-status-online/40 bg-status-online/10 text-foreground'
                            : 'border-border bg-muted/50 text-muted-foreground'
                    ">
                    <span
                        class="inline-block size-1.5 rounded-full"
                        :class="enabled ? 'bg-status-online' : 'bg-muted-foreground/60'" />
                    {{
                        enabled
                            ? t('cloud_hub.two_factor.status_enabled')
                            : t('cloud_hub.two_factor.status_disabled')
                    }}
                </span>

                <Button
                    v-if="!enabled && !showEnableForm"
                    size="sm"
                    :disabled="loadingStatus || blockedByTotp"
                    @click="openEnableForm">
                    {{ t('cloud_hub.static_passcode.enable_btn') }}
                </Button>
                <template v-else-if="enabled">
                    <Button
                        v-if="!showChangeForm && !showDisableConfirm"
                        size="sm"
                        variant="outline"
                        @click="openChangeForm">
                        {{ t('cloud_hub.static_passcode.change_btn') }}
                    </Button>
                    <Button
                        v-if="!showDisableConfirm && !showChangeForm"
                        size="sm"
                        variant="outline"
                        class="border-destructive/40 text-destructive hover:bg-destructive/10"
                        @click="openDisableConfirm">
                        {{ t('cloud_hub.static_passcode.disable_btn') }}
                    </Button>
                </template>
            </div>
        </SettingsItem>

        <p
            v-if="!enabled && blockedByTotp"
            class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {{ t('cloud_hub.static_passcode.blocked_by_2fa') }}
        </p>

        <!-- Enable setup card -->
        <form
            v-if="!enabled && showEnableForm"
            class="rounded-lg border border-border bg-card/70 p-4 space-y-3.5 text-xs"
            @submit.prevent="confirmEnable">
            <div class="space-y-1">
                <div class="text-sm font-medium text-foreground">
                    {{ t('cloud_hub.static_passcode.setup_heading') }}
                </div>
                <p class="text-muted-foreground leading-relaxed">
                    {{ t('cloud_hub.static_passcode.setup_desc') }}
                </p>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
                <div class="space-y-1">
                    <label class="block font-medium text-muted-foreground">
                        {{ t('cloud_hub.static_passcode.new_passphrase_label') }}
                    </label>
                    <input
                        v-model="newPassphrase"
                        type="password"
                        autocomplete="new-password"
                        maxlength="128"
                        :placeholder="t('cloud_hub.static_passcode.new_passphrase_placeholder')"
                        class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground"
                        required />
                </div>
                <div class="space-y-1">
                    <label class="block font-medium text-muted-foreground">
                        {{ t('cloud_hub.static_passcode.confirm_passphrase_label') }}
                    </label>
                    <input
                        v-model="confirmPassphrase"
                        type="password"
                        autocomplete="new-password"
                        maxlength="128"
                        :placeholder="t('cloud_hub.static_passcode.confirm_passphrase_placeholder')"
                        class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground"
                        required />
                </div>
            </div>

            <!-- Live complexity checklist -->
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                <span :class="newFormatCheck.minLengthOk ? 'text-status-online' : 'text-muted-foreground'">
                    {{ newFormatCheck.minLengthOk ? '✓' : '•' }} {{ t('cloud_hub.static_passcode.rule_min_length') }}
                </span>
                <span :class="newFormatCheck.hasLetter ? 'text-status-online' : 'text-muted-foreground'">
                    {{ newFormatCheck.hasLetter ? '✓' : '•' }} {{ t('cloud_hub.static_passcode.rule_letter') }}
                </span>
                <span :class="newFormatCheck.hasDigit ? 'text-status-online' : 'text-muted-foreground'">
                    {{ newFormatCheck.hasDigit ? '✓' : '•' }} {{ t('cloud_hub.static_passcode.rule_digit') }}
                </span>
            </div>

            <div class="space-y-1.5">
                <label class="block font-medium text-muted-foreground">
                    {{ t('cloud_hub.two_factor.default_trust_label') }}
                </label>
                <div class="flex flex-wrap items-center gap-2">
                    <select
                        v-model="trustPreset"
                        class="min-w-[200px] rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground dark:[color-scheme:dark]">
                        <option class="bg-card text-foreground" value="0">{{ t('cloud_hub.two_factor.trust_session') }}</option>
                        <option class="bg-card text-foreground" value="3600">{{ t('cloud_hub.two_factor.trust_1h') }}</option>
                        <option class="bg-card text-foreground" value="43200">{{ t('cloud_hub.two_factor.trust_12h') }}</option>
                        <option class="bg-card text-foreground" value="86400">{{ t('cloud_hub.two_factor.trust_1d') }}</option>
                        <option class="bg-card text-foreground" value="259200">{{ t('cloud_hub.two_factor.trust_3d') }}</option>
                        <option class="bg-card text-foreground" value="604800">{{ t('cloud_hub.two_factor.trust_7d') }}</option>
                        <option class="bg-card text-foreground" value="1209600">{{ t('cloud_hub.two_factor.trust_14d') }}</option>
                        <option class="bg-card text-foreground" value="2592000">{{ t('cloud_hub.two_factor.trust_30d') }}</option>
                        <option class="bg-card text-foreground" value="custom">{{ t('cloud_hub.two_factor.trust_custom') }}</option>
                    </select>
                    <div v-if="trustPreset === 'custom'" class="flex items-center gap-1.5">
                        <input
                            v-model.number="customTrustDays"
                            type="number"
                            min="1"
                            max="30"
                            step="1"
                            class="w-20 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                        <span class="text-muted-foreground">{{ t('cloud_hub.two_factor.custom_days_unit') }}</span>
                    </div>
                </div>
                <p class="text-[11px] text-muted-foreground">
                    {{ t('cloud_hub.two_factor.default_trust_hint') }}
                </p>
            </div>

            <div class="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" type="submit" :disabled="submittingEnable || !canSubmitNewPassphrase">
                    {{
                        submittingEnable
                            ? t('cloud_hub.unlock.verifying')
                            : t('cloud_hub.static_passcode.confirm_enable_btn')
                    }}
                </Button>
                <Button size="sm" type="button" variant="outline" @click="cancelEnableForm">
                    {{ t('cloud_hub.two_factor.cancel_btn') }}
                </Button>
            </div>
            <p v-if="actionError" class="text-[11px] text-destructive">{{ actionError }}</p>
        </form>

        <!-- Enabled state controls -->
        <div v-if="enabled" class="rounded-lg border border-border bg-card/50 p-4 space-y-4 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                <span>
                    {{
                        trustExpiresLabel
                            ? t('cloud_hub.two_factor.current_browser_until', { time: trustExpiresLabel })
                            : t('cloud_hub.two_factor.current_browser_session')
                    }}
                </span>
                <Button size="sm" variant="outline" :disabled="revokingAll" @click="revokeAllTrustedBrowsers">
                    {{
                        revokingAll
                            ? t('cloud_hub.two_factor.revoking')
                            : t('cloud_hub.two_factor.revoke_all_btn')
                    }}
                </Button>
            </div>

            <div class="space-y-2 border-t border-border/60 pt-3">
                <div class="font-medium text-foreground">{{ t('cloud_hub.two_factor.default_trust_label') }}</div>
                <div class="flex flex-wrap items-center gap-2">
                    <select
                        v-model="trustPreset"
                        class="min-w-[200px] rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground dark:[color-scheme:dark]">
                        <option class="bg-card text-foreground" value="0">{{ t('cloud_hub.two_factor.trust_session') }}</option>
                        <option class="bg-card text-foreground" value="3600">{{ t('cloud_hub.two_factor.trust_1h') }}</option>
                        <option class="bg-card text-foreground" value="43200">{{ t('cloud_hub.two_factor.trust_12h') }}</option>
                        <option class="bg-card text-foreground" value="86400">{{ t('cloud_hub.two_factor.trust_1d') }}</option>
                        <option class="bg-card text-foreground" value="259200">{{ t('cloud_hub.two_factor.trust_3d') }}</option>
                        <option class="bg-card text-foreground" value="604800">{{ t('cloud_hub.two_factor.trust_7d') }}</option>
                        <option class="bg-card text-foreground" value="1209600">{{ t('cloud_hub.two_factor.trust_14d') }}</option>
                        <option class="bg-card text-foreground" value="2592000">{{ t('cloud_hub.two_factor.trust_30d') }}</option>
                        <option class="bg-card text-foreground" value="custom">{{ t('cloud_hub.two_factor.trust_custom') }}</option>
                    </select>
                    <div v-if="trustPreset === 'custom'" class="flex items-center gap-1.5">
                        <input
                            v-model.number="customTrustDays"
                            type="number"
                            min="1"
                            max="30"
                            step="1"
                            class="w-20 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground" />
                        <span class="text-muted-foreground">{{ t('cloud_hub.two_factor.custom_days_unit') }}</span>
                    </div>
                    <Button size="sm" variant="outline" :disabled="savingSettings" @click="saveTrustSettings">
                        {{
                            savingSettings
                                ? t('cloud_hub.devices.saving')
                                : t('cloud_hub.two_factor.save_trust_btn')
                        }}
                    </Button>
                </div>
                <label class="inline-flex items-center gap-2 text-[11px] text-muted-foreground select-none cursor-pointer">
                    <input v-model="applyToCurrentBrowser" type="checkbox" class="rounded border-input" />
                    <span>{{ t('cloud_hub.two_factor.apply_current_browser') }}</span>
                </label>
                <p class="text-[11px] text-muted-foreground">
                    {{ t('cloud_hub.two_factor.default_trust_hint') }}
                </p>
            </div>

            <!-- Change static passphrase form -->
            <form
                v-if="showChangeForm"
                class="space-y-3 border-t border-border/60 pt-3"
                @submit.prevent="confirmChange">
                <div class="font-medium text-foreground">{{ t('cloud_hub.static_passcode.change_heading') }}</div>
                <div class="grid gap-3 sm:grid-cols-3">
                    <div class="space-y-1">
                        <label class="block font-medium text-muted-foreground">
                            {{ t('cloud_hub.static_passcode.current_passphrase_label') }}
                        </label>
                        <input
                            v-model="currentPassphrase"
                            type="password"
                            autocomplete="current-password"
                            maxlength="128"
                            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground"
                            required />
                    </div>
                    <div class="space-y-1">
                        <label class="block font-medium text-muted-foreground">
                            {{ t('cloud_hub.static_passcode.new_passphrase_label') }}
                        </label>
                        <input
                            v-model="newPassphrase"
                            type="password"
                            autocomplete="new-password"
                            maxlength="128"
                            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground"
                            required />
                    </div>
                    <div class="space-y-1">
                        <label class="block font-medium text-muted-foreground">
                            {{ t('cloud_hub.static_passcode.confirm_passphrase_label') }}
                        </label>
                        <input
                            v-model="confirmPassphrase"
                            type="password"
                            autocomplete="new-password"
                            maxlength="128"
                            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground"
                            required />
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                    <span :class="newFormatCheck.minLengthOk ? 'text-status-online' : 'text-muted-foreground'">
                        {{ newFormatCheck.minLengthOk ? '✓' : '•' }} {{ t('cloud_hub.static_passcode.rule_min_length') }}
                    </span>
                    <span :class="newFormatCheck.hasLetter ? 'text-status-online' : 'text-muted-foreground'">
                        {{ newFormatCheck.hasLetter ? '✓' : '•' }} {{ t('cloud_hub.static_passcode.rule_letter') }}
                    </span>
                    <span :class="newFormatCheck.hasDigit ? 'text-status-online' : 'text-muted-foreground'">
                        {{ newFormatCheck.hasDigit ? '✓' : '•' }} {{ t('cloud_hub.static_passcode.rule_digit') }}
                    </span>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        type="submit"
                        :disabled="submittingChange || !currentPassphrase || !canSubmitNewPassphrase">
                        {{
                            submittingChange
                                ? t('cloud_hub.devices.saving')
                                : t('cloud_hub.static_passcode.confirm_change_btn')
                        }}
                    </Button>
                    <Button size="sm" type="button" variant="outline" @click="cancelChangeForm">
                        {{ t('cloud_hub.two_factor.cancel_btn') }}
                    </Button>
                </div>
            </form>

            <!-- Disable confirmation form -->
            <form
                v-if="showDisableConfirm"
                class="space-y-2 border-t border-destructive/30 pt-3"
                @submit.prevent="confirmDisable">
                <div class="font-medium text-destructive">
                    {{ t('cloud_hub.static_passcode.disable_confirm_heading') }}
                </div>
                <p class="text-[11px] text-muted-foreground">
                    {{ t('cloud_hub.static_passcode.disable_confirm_desc') }}
                </p>
                <div class="flex flex-wrap items-center gap-2">
                    <input
                        v-model="disablePassphrase"
                        type="password"
                        autocomplete="current-password"
                        maxlength="128"
                        :placeholder="t('cloud_hub.static_passcode.current_passphrase_label')"
                        class="w-60 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground"
                        required />
                    <Button size="sm" type="submit" variant="destructive" :disabled="submittingDisable">
                        {{
                            submittingDisable
                                ? t('cloud_hub.unlock.verifying')
                                : t('cloud_hub.static_passcode.confirm_disable_btn')
                        }}
                    </Button>
                    <Button size="sm" type="button" variant="outline" @click="cancelDisable">
                        {{ t('cloud_hub.two_factor.cancel_btn') }}
                    </Button>
                </div>
            </form>

            <p v-if="actionError" class="text-[11px] text-destructive">{{ actionError }}</p>
        </div>
    </div>
</template>

<script setup>
    import { computed, onMounted, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';
    import { Button } from '@/components/ui/button';
    import { cloudFetch } from '@/ipc-web/apiClient';
    import {
        clamp2faTrustSeconds,
        CLOUD_2FA_TRUST_PRESETS,
        cloudState,
        MAX_CLOUD_2FA_TRUST_DAYS,
        validateStaticPassphraseFormat
    } from '@/ipc-web/cloudState';
    import SettingsItem from '@/views/Settings/components/SettingsItem.vue';

    const { t } = useI18n();

    const loadingStatus = ref(false);
    const enabled = ref(Boolean(cloudState.staticPasscodeGateEnabled));
    const blockedByTotp = computed(() => Boolean(cloudState.totpGateEnabled));
    const trustExpiresAt = ref(cloudState.staticPasscodeTrustExpiresAt || '');
    const trustPreset = ref('604800');
    const customTrustDays = ref(7);
    const applyToCurrentBrowser = ref(true);

    const showEnableForm = ref(false);
    const showChangeForm = ref(false);
    const showDisableConfirm = ref(false);

    const currentPassphrase = ref('');
    const newPassphrase = ref('');
    const confirmPassphrase = ref('');
    const disablePassphrase = ref('');

    const submittingEnable = ref(false);
    const submittingChange = ref(false);
    const savingSettings = ref(false);
    const revokingAll = ref(false);
    const submittingDisable = ref(false);
    const actionError = ref('');

    const newFormatCheck = computed(() => validateStaticPassphraseFormat(newPassphrase.value));
    const canSubmitNewPassphrase = computed(
        () => newFormatCheck.value.valid && newPassphrase.value === confirmPassphrase.value
    );

    const trustExpiresLabel = computed(() => {
        if (!trustExpiresAt.value) return '';
        const dt = new Date(trustExpiresAt.value);
        if (Number.isNaN(dt.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    });

    function syncTrustPicker(seconds) {
        const clamped = clamp2faTrustSeconds(seconds);
        if (CLOUD_2FA_TRUST_PRESETS.includes(clamped)) {
            trustPreset.value = String(clamped);
        } else {
            trustPreset.value = 'custom';
            customTrustDays.value = Math.min(Math.max(Math.round(clamped / 86400), 1), MAX_CLOUD_2FA_TRUST_DAYS);
        }
    }

    function resolveTrustSeconds() {
        if (trustPreset.value === 'custom') {
            const days = Math.min(Math.max(Math.floor(Number(customTrustDays.value) || 1), 1), MAX_CLOUD_2FA_TRUST_DAYS);
            return clamp2faTrustSeconds(days * 86400);
        }
        return clamp2faTrustSeconds(Number(trustPreset.value));
    }

    async function loadStatus() {
        if (!cloudState.authenticated) return;
        loadingStatus.value = true;
        actionError.value = '';
        try {
            const data = await cloudFetch('/api/auth/static-passcode/status');
            enabled.value = Boolean(data?.enabled);
            cloudState.staticPasscodeGateEnabled = enabled.value;
            cloudState.staticPasscodeDefaultTrustSeconds = clamp2faTrustSeconds(data?.defaultTrustSeconds);
            trustExpiresAt.value = typeof data?.trustExpiresAt === 'string' ? data.trustExpiresAt : '';
            cloudState.staticPasscodeTrustExpiresAt = trustExpiresAt.value;
            syncTrustPicker(cloudState.staticPasscodeDefaultTrustSeconds);
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            loadingStatus.value = false;
        }
    }

    function openEnableForm() {
        showEnableForm.value = true;
        newPassphrase.value = '';
        confirmPassphrase.value = '';
        actionError.value = '';
        syncTrustPicker(cloudState.staticPasscodeDefaultTrustSeconds);
    }

    function cancelEnableForm() {
        showEnableForm.value = false;
        newPassphrase.value = '';
        confirmPassphrase.value = '';
        actionError.value = '';
    }

    async function confirmEnable() {
        if (submittingEnable.value) return;
        actionError.value = '';
        if (!newFormatCheck.value.valid) {
            actionError.value = t('cloud_hub.static_passcode.invalid_format_err');
            return;
        }
        if (newPassphrase.value !== confirmPassphrase.value) {
            actionError.value = t('cloud_hub.static_passcode.mismatch_err');
            return;
        }
        submittingEnable.value = true;
        try {
            const defaultTrustSeconds = resolveTrustSeconds();
            const res = await cloudFetch('/api/auth/static-passcode/enable', {
                method: 'POST',
                json: {
                    passphrase: newPassphrase.value,
                    confirmPassphrase: confirmPassphrase.value,
                    defaultTrustSeconds
                }
            });
            enabled.value = true;
            cloudState.staticPasscodeGateEnabled = true;
            cloudState.staticPasscodeVerified = true;
            cloudState.staticPasscodeDefaultTrustSeconds = clamp2faTrustSeconds(res?.defaultTrustSeconds);
            trustExpiresAt.value = typeof res?.trustExpiresAt === 'string' ? res.trustExpiresAt : '';
            cloudState.staticPasscodeTrustExpiresAt = trustExpiresAt.value;
            showEnableForm.value = false;
            newPassphrase.value = '';
            confirmPassphrase.value = '';
            toast.success(t('cloud_hub.static_passcode.enabled_toast'));
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            submittingEnable.value = false;
        }
    }

    function openChangeForm() {
        showChangeForm.value = true;
        showDisableConfirm.value = false;
        currentPassphrase.value = '';
        newPassphrase.value = '';
        confirmPassphrase.value = '';
        actionError.value = '';
    }

    function cancelChangeForm() {
        showChangeForm.value = false;
        currentPassphrase.value = '';
        newPassphrase.value = '';
        confirmPassphrase.value = '';
        actionError.value = '';
    }

    async function confirmChange() {
        if (submittingChange.value) return;
        actionError.value = '';
        if (!newFormatCheck.value.valid) {
            actionError.value = t('cloud_hub.static_passcode.invalid_format_err');
            return;
        }
        if (newPassphrase.value !== confirmPassphrase.value) {
            actionError.value = t('cloud_hub.static_passcode.mismatch_err');
            return;
        }
        submittingChange.value = true;
        try {
            const res = await cloudFetch('/api/auth/static-passcode/change', {
                method: 'PUT',
                json: {
                    currentPassphrase: currentPassphrase.value,
                    newPassphrase: newPassphrase.value,
                    confirmPassphrase: confirmPassphrase.value
                }
            });
            trustExpiresAt.value = typeof res?.trustExpiresAt === 'string' ? res.trustExpiresAt : '';
            cloudState.staticPasscodeTrustExpiresAt = trustExpiresAt.value;
            cancelChangeForm();
            toast.success(t('cloud_hub.static_passcode.changed_toast'));
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            submittingChange.value = false;
        }
    }

    async function saveTrustSettings() {
        if (savingSettings.value) return;
        savingSettings.value = true;
        actionError.value = '';
        try {
            const defaultTrustSeconds = resolveTrustSeconds();
            const res = await cloudFetch('/api/auth/static-passcode/settings', {
                method: 'PUT',
                json: {
                    defaultTrustSeconds,
                    applyToCurrentBrowser: applyToCurrentBrowser.value
                }
            });
            cloudState.staticPasscodeDefaultTrustSeconds = clamp2faTrustSeconds(res?.defaultTrustSeconds);
            if (applyToCurrentBrowser.value) {
                trustExpiresAt.value = typeof res?.trustExpiresAt === 'string' ? res.trustExpiresAt : '';
                cloudState.staticPasscodeTrustExpiresAt = trustExpiresAt.value;
            }
            toast.success(t('cloud_hub.two_factor.saved_trust_toast'));
        } catch (err) {
            actionError.value = err?.message || String(err);
            toast.error(actionError.value);
        } finally {
            savingSettings.value = false;
        }
    }

    function openDisableConfirm() {
        showDisableConfirm.value = true;
        showChangeForm.value = false;
        disablePassphrase.value = '';
        actionError.value = '';
    }

    function cancelDisable() {
        showDisableConfirm.value = false;
        disablePassphrase.value = '';
        actionError.value = '';
    }

    async function confirmDisable() {
        if (submittingDisable.value) return;
        submittingDisable.value = true;
        actionError.value = '';
        try {
            await cloudFetch('/api/auth/static-passcode/disable', {
                method: 'POST',
                json: { passphrase: disablePassphrase.value }
            });
            enabled.value = false;
            cloudState.staticPasscodeGateEnabled = false;
            cloudState.staticPasscodeVerified = true;
            trustExpiresAt.value = '';
            cloudState.staticPasscodeTrustExpiresAt = '';
            showDisableConfirm.value = false;
            disablePassphrase.value = '';
            toast.success(t('cloud_hub.static_passcode.disabled_toast'));
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            submittingDisable.value = false;
        }
    }

    async function revokeAllTrustedBrowsers() {
        if (revokingAll.value) return;
        revokingAll.value = true;
        actionError.value = '';
        try {
            await cloudFetch('/api/auth/static-passcode/revoke-all', {
                method: 'POST',
                json: { keepCurrentBrowser: false }
            });
            cloudState.authenticated = false;
            cloudState.staticPasscodeVerified = false;
            cloudState.staticPasscodeTrustExpiresAt = '';
            window.location.reload();
        } catch (err) {
            actionError.value = err?.message || String(err);
            toast.error(actionError.value);
        } finally {
            revokingAll.value = false;
        }
    }

    watch(blockedByTotp, (blocked) => {
        if (blocked && showEnableForm.value) {
            cancelEnableForm();
        }
    });

    onMounted(() => {
        syncTrustPicker(cloudState.staticPasscodeDefaultTrustSeconds);
        loadStatus();
    });
</script>
