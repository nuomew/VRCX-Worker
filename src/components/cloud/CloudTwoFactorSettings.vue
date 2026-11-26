<template>
    <div class="space-y-3">
        <!-- Main status & primary toggle action -->
        <SettingsItem
            :label="t('cloud_hub.two_factor.title')"
            :description="t('cloud_hub.two_factor.desc')">
            <div class="flex items-center gap-2">
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
                    {{ enabled ? t('cloud_hub.two_factor.status_enabled') : t('cloud_hub.two_factor.status_disabled') }}
                </span>

                <Button
                    v-if="!enabled && !setupState"
                    size="sm"
                    :disabled="loadingStatus || startingSetup || blockedByStaticPasscode"
                    @click="startSetup">
                    {{ startingSetup ? t('cloud_hub.two_factor.generating') : t('cloud_hub.two_factor.enable_btn') }}
                </Button>
                <Button
                    v-else-if="enabled && !showDisableConfirm"
                    size="sm"
                    variant="outline"
                    class="border-destructive/40 text-destructive hover:bg-destructive/10"
                    @click="openDisableConfirm">
                    {{ t('cloud_hub.two_factor.disable_btn') }}
                </Button>
            </div>
        </SettingsItem>

        <p
            v-if="!enabled && blockedByStaticPasscode"
            class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {{ t('cloud_hub.two_factor.blocked_by_static_passcode') }}
        </p>

        <!-- Setup wizard card (shown only while binding a new TOTP secret before activation) -->
        <div
            v-if="!enabled && setupState"
            class="rounded-lg border border-border bg-card/70 p-4 space-y-4 text-xs">
            <div class="space-y-1">
                <div class="text-sm font-medium text-foreground">{{ t('cloud_hub.two_factor.setup_heading') }}</div>
                <p class="text-muted-foreground leading-relaxed">{{ t('cloud_hub.two_factor.setup_desc') }}</p>
            </div>

            <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
                <div
                    v-if="qrDataUrl"
                    class="shrink-0 self-center rounded-lg border border-border bg-white p-2 sm:self-start">
                    <img
                        :src="qrDataUrl"
                        :alt="t('cloud_hub.two_factor.qr_alt')"
                        class="block size-40" />
                </div>

                <div class="flex-1 min-w-0 space-y-3">
                    <div class="space-y-1">
                        <div class="font-medium text-muted-foreground">
                            {{ t('cloud_hub.two_factor.manual_secret_label') }}
                        </div>
                        <div class="flex items-center gap-2">
                            <code
                                class="flex-1 break-all rounded-md border border-input bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground select-all">
                                {{ formattedSecret }}
                            </code>
                            <Button size="sm" variant="outline" @click="copySecret">
                                {{
                                    copiedSecret
                                        ? t('cloud_hub.devices.copied')
                                        : t('cloud_hub.two_factor.copy_secret')
                                }}
                            </Button>
                        </div>
                    </div>

                    <div class="space-y-1.5">
                        <label class="block font-medium text-muted-foreground">
                            {{ t('cloud_hub.two_factor.default_trust_label') }}
                        </label>
                        <div class="flex flex-wrap items-center gap-2">
                            <select
                                v-model="trustPreset"
                                class="min-w-[200px] rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground">
                                <option value="0">{{ t('cloud_hub.two_factor.trust_session') }}</option>
                                <option value="3600">{{ t('cloud_hub.two_factor.trust_1h') }}</option>
                                <option value="43200">{{ t('cloud_hub.two_factor.trust_12h') }}</option>
                                <option value="86400">{{ t('cloud_hub.two_factor.trust_1d') }}</option>
                                <option value="259200">{{ t('cloud_hub.two_factor.trust_3d') }}</option>
                                <option value="604800">{{ t('cloud_hub.two_factor.trust_7d') }}</option>
                                <option value="1209600">{{ t('cloud_hub.two_factor.trust_14d') }}</option>
                                <option value="2592000">{{ t('cloud_hub.two_factor.trust_30d') }}</option>
                                <option value="custom">{{ t('cloud_hub.two_factor.trust_custom') }}</option>
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

                    <form class="space-y-2 pt-1" @submit.prevent="confirmEnable">
                        <label class="block font-medium text-muted-foreground">
                            {{ t('cloud_hub.two_factor.confirm_code_label') }}
                        </label>
                        <div class="flex flex-wrap items-center gap-2">
                            <input
                                v-model="verifyCode"
                                type="text"
                                inputmode="numeric"
                                autocomplete="one-time-code"
                                maxlength="6"
                                :placeholder="t('cloud_hub.unlock.totp_placeholder')"
                                class="w-40 rounded-md border border-input bg-background px-3 py-1.5 text-center font-mono text-sm tracking-widest text-foreground"
                                required />
                            <Button size="sm" type="submit" :disabled="submittingEnable">
                                {{
                                    submittingEnable
                                        ? t('cloud_hub.unlock.verifying')
                                        : t('cloud_hub.two_factor.confirm_enable_btn')
                                }}
                            </Button>
                            <Button size="sm" type="button" variant="outline" @click="cancelSetup">
                                {{ t('cloud_hub.two_factor.cancel_btn') }}
                            </Button>
                        </div>
                        <p v-if="actionError" class="text-[11px] text-destructive">{{ actionError }}</p>
                    </form>
                </div>
            </div>
        </div>

        <!-- Enabled state controls: browser trust window + revoke all + disable confirmation -->
        <div v-if="enabled" class="rounded-lg border border-border bg-card/50 p-4 space-y-4 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                <span>
                    {{
                        trustExpiresLabel
                            ? t('cloud_hub.two_factor.current_browser_until', { time: trustExpiresLabel })
                            : t('cloud_hub.two_factor.current_browser_session')
                    }}
                </span>
                <Button
                    size="sm"
                    variant="outline"
                    :disabled="revokingAll"
                    @click="revokeAllTrustedBrowsers">
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
                        class="min-w-[200px] rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground">
                        <option value="0">{{ t('cloud_hub.two_factor.trust_session') }}</option>
                        <option value="3600">{{ t('cloud_hub.two_factor.trust_1h') }}</option>
                        <option value="43200">{{ t('cloud_hub.two_factor.trust_12h') }}</option>
                        <option value="86400">{{ t('cloud_hub.two_factor.trust_1d') }}</option>
                        <option value="259200">{{ t('cloud_hub.two_factor.trust_3d') }}</option>
                        <option value="604800">{{ t('cloud_hub.two_factor.trust_7d') }}</option>
                        <option value="1209600">{{ t('cloud_hub.two_factor.trust_14d') }}</option>
                        <option value="2592000">{{ t('cloud_hub.two_factor.trust_30d') }}</option>
                        <option value="custom">{{ t('cloud_hub.two_factor.trust_custom') }}</option>
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

            <form
                v-if="showDisableConfirm"
                class="space-y-2 border-t border-destructive/30 pt-3"
                @submit.prevent="confirmDisable">
                <div class="font-medium text-destructive">{{ t('cloud_hub.two_factor.disable_confirm_heading') }}</div>
                <p class="text-[11px] text-muted-foreground">{{ t('cloud_hub.two_factor.disable_confirm_desc') }}</p>
                <div class="flex flex-wrap items-center gap-2">
                    <input
                        v-model="disableCode"
                        type="text"
                        inputmode="numeric"
                        autocomplete="one-time-code"
                        maxlength="6"
                        :placeholder="t('cloud_hub.unlock.totp_placeholder')"
                        class="w-40 rounded-md border border-input bg-background px-3 py-1.5 text-center font-mono text-sm tracking-widest text-foreground"
                        required />
                    <Button
                        size="sm"
                        type="submit"
                        variant="destructive"
                        :disabled="submittingDisable">
                        {{
                            submittingDisable
                                ? t('cloud_hub.unlock.verifying')
                                : t('cloud_hub.two_factor.confirm_disable_btn')
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
    import { computed, onMounted, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';
    import { Button } from '@/components/ui/button';
    import { cloudFetch } from '@/ipc-web/apiClient';
    import {
        clamp2faTrustSeconds,
        CLOUD_2FA_TRUST_PRESETS,
        cloudState,
        MAX_CLOUD_2FA_TRUST_DAYS
    } from '@/ipc-web/cloudState';
    import SettingsItem from '@/views/Settings/components/SettingsItem.vue';

    const { t } = useI18n();

    const loadingStatus = ref(false);
    const enabled = ref(Boolean(cloudState.totpGateEnabled));
    const blockedByStaticPasscode = computed(() => Boolean(cloudState.staticPasscodeGateEnabled));
    const trustExpiresAt = ref(cloudState.totpTrustExpiresAt || '');
    const trustPreset = ref('604800');
    const customTrustDays = ref(7);
    const applyToCurrentBrowser = ref(true);

    const startingSetup = ref(false);
    const setupState = ref(null);
    const qrDataUrl = ref('');
    const copiedSecret = ref(false);
    const verifyCode = ref('');
    const submittingEnable = ref(false);

    const savingSettings = ref(false);
    const revokingAll = ref(false);
    const showDisableConfirm = ref(false);
    const disableCode = ref('');
    const submittingDisable = ref(false);
    const actionError = ref('');

    const formattedSecret = computed(() => {
        const raw = setupState.value?.secret || '';
        return raw.replace(/(.{4})/g, '$1 ').trim();
    });

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
            const data = await cloudFetch('/api/auth/2fa/status');
            enabled.value = Boolean(data?.enabled);
            cloudState.totpGateEnabled = enabled.value;
            cloudState.requiresTotp = enabled.value || Boolean(data?.envTotpConfigured);
            cloudState.default2faTrustSeconds = clamp2faTrustSeconds(data?.defaultTrustSeconds);
            trustExpiresAt.value = typeof data?.trustExpiresAt === 'string' ? data.trustExpiresAt : '';
            cloudState.totpTrustExpiresAt = trustExpiresAt.value;
            syncTrustPicker(cloudState.default2faTrustSeconds);
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            loadingStatus.value = false;
        }
    }

    async function startSetup() {
        if (startingSetup.value) return;
        startingSetup.value = true;
        actionError.value = '';
        verifyCode.value = '';
        qrDataUrl.value = '';
        try {
            const data = await cloudFetch('/api/auth/2fa/setup', { method: 'POST', json: {} });
            setupState.value = data;
            syncTrustPicker(data?.defaultTrustSeconds);
            try {
                const QRCode = await import('qrcode');
                qrDataUrl.value = await QRCode.toDataURL(data.otpauthUrl, {
                    width: 196,
                    margin: 2,
                    errorCorrectionLevel: 'M'
                });
            } catch {
                qrDataUrl.value = '';
            }
        } catch (err) {
            actionError.value = err?.message || String(err);
            toast.error(actionError.value);
        } finally {
            startingSetup.value = false;
        }
    }

    function cancelSetup() {
        setupState.value = null;
        qrDataUrl.value = '';
        verifyCode.value = '';
        actionError.value = '';
    }

    async function copySecret() {
        const raw = setupState.value?.secret;
        if (!raw) return;
        try {
            await navigator.clipboard.writeText(raw);
            copiedSecret.value = true;
            setTimeout(() => {
                copiedSecret.value = false;
            }, 2000);
        } catch {
            // Clipboard unavailable
        }
    }

    async function confirmEnable() {
        if (!setupState.value?.setupToken || submittingEnable.value) return;
        submittingEnable.value = true;
        actionError.value = '';
        try {
            const defaultTrustSeconds = resolveTrustSeconds();
            const res = await cloudFetch('/api/auth/2fa/enable', {
                method: 'POST',
                json: {
                    setupToken: setupState.value.setupToken,
                    code: (verifyCode.value || '').replace(/\s+/g, ''),
                    defaultTrustSeconds
                }
            });
            enabled.value = true;
            cloudState.totpGateEnabled = true;
            cloudState.totpVerified = true;
            cloudState.requiresTotp = true;
            cloudState.default2faTrustSeconds = clamp2faTrustSeconds(res?.defaultTrustSeconds);
            trustExpiresAt.value = typeof res?.trustExpiresAt === 'string' ? res.trustExpiresAt : '';
            cloudState.totpTrustExpiresAt = trustExpiresAt.value;
            setupState.value = null;
            qrDataUrl.value = '';
            verifyCode.value = '';
            toast.success(t('cloud_hub.two_factor.enabled_toast'));
        } catch (err) {
            actionError.value = err?.message || String(err);
        } finally {
            submittingEnable.value = false;
        }
    }

    async function saveTrustSettings() {
        if (savingSettings.value) return;
        savingSettings.value = true;
        actionError.value = '';
        try {
            const defaultTrustSeconds = resolveTrustSeconds();
            const res = await cloudFetch('/api/auth/2fa/settings', {
                method: 'PUT',
                json: {
                    defaultTrustSeconds,
                    applyToCurrentBrowser: applyToCurrentBrowser.value
                }
            });
            cloudState.default2faTrustSeconds = clamp2faTrustSeconds(res?.defaultTrustSeconds);
            if (applyToCurrentBrowser.value) {
                trustExpiresAt.value = typeof res?.trustExpiresAt === 'string' ? res.trustExpiresAt : '';
                cloudState.totpTrustExpiresAt = trustExpiresAt.value;
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
        disableCode.value = '';
        actionError.value = '';
    }

    function cancelDisable() {
        showDisableConfirm.value = false;
        disableCode.value = '';
        actionError.value = '';
    }

    async function confirmDisable() {
        if (submittingDisable.value) return;
        submittingDisable.value = true;
        actionError.value = '';
        try {
            await cloudFetch('/api/auth/2fa/disable', {
                method: 'POST',
                json: { code: (disableCode.value || '').replace(/\s+/g, '') }
            });
            enabled.value = false;
            cloudState.totpGateEnabled = false;
            cloudState.totpVerified = true;
            cloudState.requiresTotp = Boolean(cloudState.envTotpConfigured);
            trustExpiresAt.value = '';
            cloudState.totpTrustExpiresAt = '';
            showDisableConfirm.value = false;
            disableCode.value = '';
            toast.success(t('cloud_hub.two_factor.disabled_toast'));
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
            await cloudFetch('/api/auth/2fa/revoke-all', {
                method: 'POST',
                json: { keepCurrentBrowser: false }
            });
            cloudState.authenticated = false;
            cloudState.totpVerified = false;
            cloudState.totpTrustExpiresAt = '';
            window.location.reload();
        } catch (err) {
            actionError.value = err?.message || String(err);
            toast.error(actionError.value);
        } finally {
            revokingAll.value = false;
        }
    }

    onMounted(() => {
        syncTrustPicker(cloudState.default2faTrustSeconds);
        loadStatus();
    });
</script>
