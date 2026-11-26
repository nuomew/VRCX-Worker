<template>
    <div class="x-container flex flex-col overflow-hidden">
        <!-- Header Bar -->
        <div class="flex items-center justify-between gap-2 ml-2 mb-3 shrink-0 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap">
                <Button variant="ghost" size="sm" class="mr-2" @click="goBack">
                    <ArrowLeft class="size-4" />
                    {{ t('nav_tooltip.tools') }}
                </Button>
                <span class="header">{{ t('view.tools.system_tools.chat_translator') }}</span>

                <!-- Companion & OSC Live Status Badge -->
                <button
                    v-if="isWebMode"
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-muted/70"
                    :class="
                        hasRealtimeDevice
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : hasOnlineDevice
                              ? 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                              : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    "
                    :title="t('view.tools.chat_translator.realtime_isolated_hint')"
                    @click="openCloudHubDialog">
                    <span
                        class="size-2 rounded-full"
                        :class="
                            hasRealtimeDevice
                                ? 'bg-emerald-500 animate-pulse'
                                : hasOnlineDevice
                                  ? 'bg-sky-500'
                                  : 'bg-amber-500'
                        " />
                    <span>
                        {{
                            hasRealtimeDevice
                                ? t('view.tools.chat_translator.agent_realtime', {
                                      name: activeDevice?.deviceName || 'Windows PC'
                                  })
                                : hasOnlineDevice
                                  ? t('view.tools.chat_translator.agent_online', {
                                        name: activeDevice?.deviceName || 'Windows PC'
                                    })
                                  : t('view.tools.chat_translator.agent_offline')
                        }}
                    </span>
                </button>

                <Badge
                    v-if="isWebMode && activeDevice?.vrcRunning"
                    variant="outline"
                    class="text-xs font-normal border-sky-500/40 text-sky-600 dark:text-sky-400">
                    {{ t('view.tools.chat_translator.vrc_running') }}
                </Badge>

                <Badge
                    v-if="isWebMode"
                    variant="outline"
                    class="text-xs font-normal border-border/80 text-muted-foreground"
                    :title="t('view.tools.chat_translator.dedicated_db_hint')">
                    {{ t('view.tools.chat_translator.dedicated_db_badge') }}
                </Badge>

                <Badge
                    v-if="isWebMode && !prefs.oscEnabled"
                    variant="outline"
                    class="text-xs font-normal border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    {{ t('view.tools.chat_translator.osc_paused_badge') }}
                </Badge>
            </div>

            <div class="flex items-center gap-1.5 flex-wrap">
                <Button variant="outline" size="sm" @click="isTranslationApiDialogVisible = true">
                    <Languages class="size-4" />
                    <span>{{ translationEngineLabel }}</span>
                </Button>

                <Button
                    variant="outline"
                    size="sm"
                    @click="isOscSettingsDialogVisible = true">
                    <SlidersHorizontal class="size-4" />
                    <span>{{ t('view.tools.chat_translator.osc_settings_btn') }}</span>
                </Button>

                <Button
                    v-if="isWebMode"
                    variant="outline"
                    size="icon-sm"
                    :disabled="loadingMessages"
                    :title="t('view.tools.chat_translator.refresh_tooltip')"
                    :ariaLabel="t('view.tools.chat_translator.refresh_tooltip')"
                    @click="fetchMessages({ showLoader: true, reset: true })">
                    <RefreshCw class="size-4" :class="{ 'animate-spin': loadingMessages }" />
                </Button>

                <Button
                    variant="outline"
                    size="icon-sm"
                    :disabled="messages.length === 0 || clearingHistory"
                    :title="t('view.tools.chat_translator.clear_history')"
                    :ariaLabel="t('view.tools.chat_translator.clear_history')"
                    @click="handleClearHistory">
                    <Trash2 class="size-4" />
                </Button>
            </div>
        </div>

        <!-- Compact Translation Toggle Bar (Translation OFF by default; sends original text when off or unconfigured) -->
        <div class="shrink-0 mb-3 rounded-lg border border-border bg-card/60 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2.5 text-xs">
                <div class="inline-flex items-center gap-2 select-none font-medium text-foreground">
                    <Switch
                        :model-value="prefs.translateEnabled"
                        :class="TOGGLE_SWITCH_CLASS"
                        :aria-label="t('view.tools.chat_translator.translate_enabled_label')"
                        @update:model-value="(val) => setBoolPref('translateEnabled', val)" />
                    <span>{{ t('view.tools.chat_translator.translate_enabled_label') }}</span>
                </div>

                <template v-if="prefs.translateEnabled">
                    <!-- Source Language -->
                    <div class="flex items-center gap-1.5">
                        <span class="text-muted-foreground">{{ t('view.tools.chat_translator.source_lang') }}</span>
                        <select
                            v-model="prefs.sourceLang"
                            :aria-label="t('view.tools.chat_translator.source_lang')"
                            class="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground dark:[color-scheme:dark]"
                            @change="persistPrefs">
                            <option class="bg-card text-foreground" value="auto">
                                {{ t('view.tools.chat_translator.lang_auto') }}
                            </option>
                            <option
                                v-for="lang in CHAT_TRANSLATOR_LANGUAGES"
                                :key="lang.code"
                                class="bg-card text-foreground"
                                :value="lang.code">
                                {{ lang.label }}
                            </option>
                        </select>
                    </div>

                    <!-- Swap Languages -->
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        :disabled="prefs.sourceLang === 'auto'"
                        :title="t('view.tools.chat_translator.swap_languages')"
                        :ariaLabel="t('view.tools.chat_translator.swap_languages')"
                        @click="swapLanguages">
                        <ArrowLeftRight class="size-3.5" />
                    </Button>

                    <!-- Target Language -->
                    <div class="flex items-center gap-1.5">
                        <span class="text-muted-foreground">{{ t('view.tools.chat_translator.target_lang') }}</span>
                        <select
                            v-model="prefs.targetLang"
                            :aria-label="t('view.tools.chat_translator.target_lang')"
                            class="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground dark:[color-scheme:dark]"
                            @change="persistPrefs">
                            <option
                                v-for="lang in CHAT_TRANSLATOR_LANGUAGES"
                                :key="lang.code"
                                class="bg-card text-foreground"
                                :value="lang.code">
                                {{ lang.label }}
                            </option>
                        </select>
                    </div>

                    <!-- Chatbox Format -->
                    <div class="flex items-center gap-1.5">
                        <span class="text-muted-foreground">{{ t('view.tools.chat_translator.display_mode') }}</span>
                        <select
                            v-model="prefs.displayMode"
                            :aria-label="t('view.tools.chat_translator.display_mode')"
                            class="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground dark:[color-scheme:dark]"
                            @change="persistPrefs">
                            <option class="bg-card text-foreground" value="translated_only">
                                {{ t('view.tools.chat_translator.mode_translated_only') }}
                            </option>
                            <option class="bg-card text-foreground" value="translated_and_source">
                                {{ t('view.tools.chat_translator.mode_translated_and_source') }}
                            </option>
                            <option class="bg-card text-foreground" value="source_and_translated">
                                {{ t('view.tools.chat_translator.mode_source_and_translated') }}
                            </option>
                            <option class="bg-card text-foreground" value="source_only">
                                {{ t('view.tools.chat_translator.mode_source_only') }}
                            </option>
                        </select>
                    </div>

                    <div class="inline-flex items-center gap-2 select-none ml-auto">
                        <Switch
                            :model-value="prefs.autoTranslateDesktop"
                            :class="TOGGLE_SWITCH_CLASS"
                            :aria-label="t('view.tools.chat_translator.auto_translate_desktop')"
                            @update:model-value="(val) => setBoolPref('autoTranslateDesktop', val)" />
                        <span>{{ t('view.tools.chat_translator.auto_translate_desktop') }}</span>
                    </div>

                    <button
                        v-if="!isTranslationConfigured"
                        type="button"
                        class="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                        @click="isTranslationApiDialogVisible = true">
                        {{ t('view.tools.chat_translator.translate_unconfigured_fallback') }}
                    </button>
                </template>

                <span v-else class="text-muted-foreground">
                    {{ t('view.tools.chat_translator.translate_off_hint') }}
                </span>
            </div>
        </div>

        <!-- Chat & Sync Conversation Feed (oldest at top, latest at bottom; scroll up to auto-load earlier pages of 20) -->
        <div
            ref="messageListRef"
            class="flex-1 overflow-y-auto min-h-0 rounded-xl border border-border/80 bg-muted/15 px-4 py-3.5 space-y-3"
            @scroll.passive="handleMessageListScroll">
            <!-- Initial Empty Guide + Quick Phrases -->
            <div
                v-if="messages.length === 0 && !loadingMessages"
                class="h-full flex flex-col items-center justify-center text-center px-4 py-10 space-y-4">
                <div class="size-12 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                    <MessageSquareText class="size-6" />
                </div>
                <div class="space-y-1 max-w-md">
                    <div class="text-sm font-semibold text-foreground">
                        {{ t('view.tools.chat_translator.empty_title') }}
                    </div>
                    <p class="text-xs text-muted-foreground leading-relaxed">
                        {{ t('view.tools.chat_translator.empty_description') }}
                    </p>
                </div>
                <div class="flex flex-wrap items-center justify-center gap-2 max-w-lg">
                    <button
                        v-for="phrase in quickPhrases"
                        :key="phrase"
                        type="button"
                        class="rounded-full border border-border bg-background/80 px-3 py-1 text-xs text-foreground hover:bg-muted transition-colors"
                        @click="applyQuickPhrase(phrase)">
                        {{ phrase }}
                    </button>
                </div>
            </div>

            <!-- Infinite Scroll Top Sentinel (scroll up to auto-load earlier history) -->
            <div
                v-if="messages.length > 0 && isWebMode"
                ref="loadMoreSentinelRef"
                data-load-more-sentinel="top"
                class="pb-2 pt-0.5 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/75 select-none">
                <template v-if="loadingMoreMessages">
                    <Spinner class="size-3.5" />
                    <span>{{ t('view.tools.chat_translator.loading_more') }}</span>
                </template>
                <button
                    v-else-if="hasMoreMessages"
                    type="button"
                    class="hover:text-foreground transition-colors"
                    @click="loadMoreMessages">
                    {{ t('view.tools.chat_translator.scroll_load_more') }}
                </button>
                <span v-else class="opacity-70">
                    {{ t('view.tools.chat_translator.no_more_messages') }}
                </span>
            </div>

            <!-- Message Bubbles (self messages on the right, peer messages on the left) -->
            <div
                v-for="msg in messages"
                :key="msg.id"
                :data-msg-side="isSelfMessage(msg) ? 'right' : 'left'"
                class="group flex w-full flex-col gap-1"
                :class="isSelfMessage(msg) ? 'items-end' : 'items-start'">
                <div
                    v-if="!isSelfMessage(msg) && msg.senderName"
                    class="px-1 text-[11px] font-medium text-muted-foreground">
                    {{ msg.senderName }}
                </div>

                <div
                    class="flex items-end gap-1.5 max-w-[88%] sm:max-w-[76%]"
                    :class="
                        isSelfMessage(msg)
                            ? 'ml-auto flex-row justify-end'
                            : 'mr-auto flex-row-reverse justify-start'
                    ">
                    <!-- Floating Compact Action Pill (appears on hover/focus on desktop) -->
                    <div
                        class="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-border/70 bg-background/95 p-0.5 shadow-xs transition-opacity duration-150 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                        <button
                            type="button"
                            class="size-6 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                            :disabled="translatingIds.has(msg.id)"
                            :title="t('view.tools.chat_translator.action_translate')"
                            :aria-label="t('view.tools.chat_translator.action_translate')"
                            @click="translateExistingMessage(msg)">
                            <Spinner v-if="translatingIds.has(msg.id)" class="size-3" />
                            <Languages v-else class="size-3.5" />
                        </button>
                        <button
                            v-if="isWebMode"
                            type="button"
                            class="size-6 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                            :disabled="sending"
                            :title="t('view.tools.chat_translator.action_resend')"
                            :aria-label="t('view.tools.chat_translator.action_resend')"
                            @click="resendMessageToVrc(msg)">
                            <RotateCw class="size-3.5" />
                        </button>
                        <button
                            type="button"
                            class="size-6 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            :title="t('view.tools.chat_translator.action_copy')"
                            :aria-label="t('view.tools.chat_translator.action_copy')"
                            @click="copyMessageText(msg)">
                            <Copy class="size-3.5" />
                        </button>
                        <button
                            type="button"
                            class="size-6 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            :title="t('view.tools.chat_translator.action_delete')"
                            :aria-label="t('view.tools.chat_translator.action_delete')"
                            @click="deleteSingleMessage(msg.id)">
                            <X class="size-3.5" />
                        </button>
                    </div>

                    <!-- Adaptive Chat Bubble -->
                    <div
                        class="w-fit min-w-0 max-w-full border px-3.5 py-2 shadow-xs transition-colors"
                        :class="bubbleContainerClass(msg)">
                        <!-- Primary Displayed Text -->
                        <div class="text-[14px] text-foreground whitespace-pre-wrap [overflow-wrap:anywhere] leading-relaxed">
                            {{ msg.sentText || msg.translatedText || msg.sourceText }}
                        </div>

                        <!-- Secondary Parallel Source / Translation Line -->
                        <div
                            v-if="showSecondarySource(msg)"
                            class="mt-1.5 pt-1.5 border-t border-foreground/10 text-xs text-muted-foreground whitespace-pre-wrap break-words leading-relaxed">
                            <span class="opacity-75 mr-1">{{ t('view.tools.chat_translator.source_prefix') }}</span>
                            <span>{{ msg.sourceText }}</span>
                        </div>
                        <div
                            v-else-if="showSecondaryTranslation(msg)"
                            class="mt-1.5 pt-1.5 border-t border-foreground/10 text-xs text-primary whitespace-pre-wrap break-words leading-relaxed">
                            <span
                                v-if="msg.targetLang"
                                class="inline-block mr-1.5 rounded bg-primary/12 px-1 py-0.5 text-[10px] font-medium align-baseline">
                                {{ getChatLanguageLabel(msg.targetLang) }}
                            </span>
                            <span>{{ msg.translatedText }}</span>
                        </div>

                        <!-- Delivery Error Details -->
                        <div
                            v-if="msg.errorMessage"
                            class="mt-1.5 pt-1.5 border-t border-destructive/20 flex items-center gap-1.5 text-[11px] text-destructive">
                            <AlertCircle class="size-3 shrink-0" />
                            <span class="break-words">{{ msg.errorMessage }}</span>
                        </div>
                    </div>
                </div>

                <!-- Compact Subtle Meta Footer (outside bubble) -->
                <div
                    class="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground/80 select-none"
                    :class="isSelfMessage(msg) ? 'ml-auto flex-row-reverse' : 'mr-auto flex-row'"
                    :title="formatMessageMetaTooltip(msg)">
                    <span
                        class="inline-flex items-center gap-1 font-medium"
                        :class="statusTextClass(msg.status)">
                        <CheckCheck v-if="msg.status === 'sent'" class="size-3" />
                        <Check v-else-if="msg.status === 'dispatched'" class="size-3" />
                        <Monitor v-else-if="msg.status === 'synced'" class="size-3" />
                        <AlertCircle v-else-if="msg.status === 'failed'" class="size-3" />
                        <Clock v-else class="size-3" />
                        <span>{{ statusBadgeLabel(msg.status) }}</span>
                    </span>

                    <span class="opacity-40">·</span>
                    <span class="tabular-nums opacity-85">{{ formatDateTime(msg.createdAt) }}</span>

                    <template v-if="msg.targetLang">
                        <span class="opacity-40">·</span>
                        <span class="text-[10px] opacity-80">
                            {{ getChatLanguageLabel(msg.targetLang) }}
                        </span>
                    </template>

                    <template v-if="msg.oscPort && msg.oscPort !== DEFAULT_OSC_SEND_PORT">
                        <span class="opacity-40">·</span>
                        <span class="font-mono text-[10px] opacity-75">:{{ msg.oscPort }}</span>
                    </template>
                </div>
            </div>
        </div>

        <!-- Bottom Composer & Preview Area -->
        <div class="shrink-0 mt-3 rounded-lg border border-border bg-card/70 p-3 space-y-2.5">
            <!-- Translation Preview Strip -->
            <div
                v-if="previewVisible"
                class="rounded-md border border-primary/30 bg-primary/5 p-2.5 space-y-1.5">
                <div class="flex items-center justify-between gap-2 text-xs">
                    <span class="font-medium text-primary">
                        {{ t('view.tools.chat_translator.preview_header') }}
                    </span>
                    <button
                        type="button"
                        class="text-muted-foreground hover:text-foreground"
                        @click="clearPreview">
                        <X class="size-3.5" />
                    </button>
                </div>
                <textarea
                    v-model="previewText"
                    rows="2"
                    class="w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
                <div class="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span :class="previewOscMetrics.truncated ? 'text-amber-600 dark:text-amber-400 font-medium' : ''">
                        {{
                            t('view.tools.chat_translator.osc_counter', {
                                chars: previewOscMetrics.charCount,
                                maxChars: VRC_OSC_MAX_CHARS,
                                lines: previewOscMetrics.lineCount,
                                maxLines: VRC_OSC_MAX_LINES
                            })
                        }}
                    </span>
                    <Button
                        size="sm"
                        class="h-7 px-2.5 text-xs"
                        :disabled="sending || !previewOscMetrics.text"
                        @click="sendPreviewToVrchat">
                        <Spinner v-if="sending" class="size-3" />
                        <Send v-else class="size-3" />
                        <span>{{ t('view.tools.chat_translator.send_preview_btn') }}</span>
                    </Button>
                </div>
            </div>

            <!-- Main Input Textarea -->
            <textarea
                v-model="draftInput"
                rows="2"
                :placeholder="t('view.tools.chat_translator.input_placeholder')"
                class="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                @input="handleDraftInput"
                @keydown="handleComposerKeydown" />

            <!-- Footer Counter & Action Buttons -->
            <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="flex items-center gap-2 text-xs text-muted-foreground">
                    <span :class="draftOscMetrics.truncated ? 'text-amber-600 dark:text-amber-400 font-medium' : ''">
                        {{
                            t('view.tools.chat_translator.osc_counter', {
                                chars: draftOscMetrics.charCount,
                                maxChars: VRC_OSC_MAX_CHARS,
                                lines: draftOscMetrics.lineCount,
                                maxLines: VRC_OSC_MAX_LINES
                            })
                        }}
                    </span>
                    <span v-if="draftOscMetrics.truncated" class="text-[11px] text-amber-600 dark:text-amber-400">
                        {{ t('view.tools.chat_translator.osc_truncate_warning') }}
                    </span>
                </div>

                <div class="flex items-center gap-2">
                    <Button
                        v-if="shouldTranslateOnSend"
                        type="button"
                        size="sm"
                        variant="outline"
                        :disabled="translatingDraft || sending || !draftInput.trim()"
                        @click="handlePreviewTranslate">
                        <Spinner v-if="translatingDraft" class="size-4" />
                        <Languages v-else class="size-4" />
                        <span>{{ t('view.tools.chat_translator.preview_translate_btn') }}</span>
                    </Button>

                    <Button
                        type="button"
                        size="sm"
                        :disabled="sending || translatingDraft || !draftInput.trim()"
                        @click="handleSendMessage">
                        <Spinner v-if="sending" class="size-4" />
                        <Send v-else class="size-4" />
                        <span>
                            {{
                                shouldTranslateOnSend
                                    ? t('view.tools.chat_translator.translate_and_send_btn')
                                    : t('view.tools.chat_translator.send_direct_btn')
                            }}
                        </span>
                    </Button>
                </div>
            </div>
        </div>

        <!-- Cloud OSC Settings Modal Dialog (Zero Local Agent Setup) -->
        <Dialog :open="isOscSettingsDialogVisible" @update:open="isOscSettingsDialogVisible = $event">
            <DialogContent class="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{{ t('view.tools.chat_translator.osc_dialog_title') }}</DialogTitle>
                    <DialogDescription>
                        {{ t('view.tools.chat_translator.osc_dialog_description') }}
                    </DialogDescription>
                </DialogHeader>

                <div class="space-y-4 py-1 text-xs">
                    <!-- Master Switch -->
                    <div class="flex items-center justify-between gap-3 rounded-lg border border-border/80 bg-card/60 px-3 py-2.5">
                        <span class="font-medium text-sm text-foreground">
                            {{ t('view.tools.chat_translator.osc_enabled_label') }}
                        </span>
                        <Switch
                            :model-value="prefs.oscEnabled"
                            :class="TOGGLE_SWITCH_CLASS"
                            :aria-label="t('view.tools.chat_translator.osc_enabled_label')"
                            @update:model-value="(val) => setBoolPref('oscEnabled', val)" />
                    </div>

                    <!-- Target Companion & VRChat Send Port -->
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div class="space-y-1">
                            <div class="text-muted-foreground font-medium">
                                {{ t('view.tools.chat_translator.target_device_label') }}
                            </div>
                            <select
                                v-model="prefs.targetDeviceId"
                                :aria-label="t('view.tools.chat_translator.target_device_label')"
                                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground dark:[color-scheme:dark]"
                                @change="persistPrefs">
                                <option class="bg-card text-foreground" value="">
                                    {{ t('view.tools.chat_translator.target_device_auto') }}
                                </option>
                                <option
                                    v-for="dev in devices"
                                    :key="dev.deviceId"
                                    class="bg-card text-foreground"
                                    :value="dev.deviceId">
                                    {{ dev.deviceName }} ({{ dev.online ? t('view.tools.chat_translator.online_short') : t('view.tools.chat_translator.offline_short') }})
                                </option>
                            </select>
                        </div>

                        <div class="space-y-1">
                            <div class="text-muted-foreground font-medium">
                                {{ t('view.tools.chat_translator.osc_port_label') }}
                            </div>
                            <div class="flex items-center gap-1.5">
                                <span class="font-mono text-muted-foreground">127.0.0.1 :</span>
                                <input
                                    v-model.number="prefs.oscPort"
                                    type="number"
                                    min="1024"
                                    max="65535"
                                    class="h-8 w-24 rounded-md border border-input bg-background px-2 text-xs font-mono text-foreground"
                                    @change="handleOscPortChange" />
                            </div>
                        </div>
                    </div>

                    <!-- Chatbox Delivery Options -->
                    <div class="space-y-2 rounded-lg border border-border/70 px-3 py-2.5">
                        <div class="text-muted-foreground font-medium">
                            {{ t('view.tools.chat_translator.osc_send_options_label') }}
                        </div>
                        <div class="flex items-center justify-between gap-3">
                            <span class="text-foreground">{{ t('view.tools.chat_translator.osc_immediate') }}</span>
                            <Switch
                                :model-value="prefs.immediate"
                                :class="TOGGLE_SWITCH_CLASS"
                                :aria-label="t('view.tools.chat_translator.osc_immediate')"
                                @update:model-value="(val) => setBoolPref('immediate', val)" />
                        </div>
                        <div class="flex items-center justify-between gap-3">
                            <span class="text-foreground">{{ t('view.tools.chat_translator.osc_play_sfx') }}</span>
                            <Switch
                                :model-value="prefs.playSfx"
                                :class="TOGGLE_SWITCH_CLASS"
                                :aria-label="t('view.tools.chat_translator.osc_play_sfx')"
                                @update:model-value="(val) => setBoolPref('playSfx', val)" />
                        </div>
                        <div class="flex items-center justify-between gap-3">
                            <span class="text-foreground">{{ t('view.tools.chat_translator.sync_typing') }}</span>
                            <Switch
                                :model-value="prefs.syncTyping"
                                :class="TOGGLE_SWITCH_CLASS"
                                :aria-label="t('view.tools.chat_translator.sync_typing')"
                                @update:model-value="(val) => setBoolPref('syncTyping', val)" />
                        </div>
                    </div>

                    <!-- Desktop OSC Relay Listener Section -->
                    <div class="rounded-lg border border-border/80 bg-muted/30 p-3 space-y-2.5">
                        <div class="flex items-center justify-between gap-2">
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="font-medium text-foreground">
                                    {{ t('view.tools.chat_translator.osc_listen_enabled_label') }}
                                </span>
                                <Badge variant="outline" class="text-[10px] font-mono">
                                    {{
                                        activeDevice?.osc?.listenEnabled
                                            ? `127.0.0.1:${activeDevice.osc.listenPort}${activeDevice.osc.forwardToVrchat ? ` → ${activeDevice.osc.sendPort}` : ''}`
                                            : prefs.oscListenEnabled
                                              ? t('view.tools.chat_translator.relay_standby')
                                              : t('view.tools.chat_translator.relay_disabled_badge')
                                    }}
                                </Badge>
                            </div>
                            <Switch
                                :model-value="prefs.oscListenEnabled"
                                :class="TOGGLE_SWITCH_CLASS"
                                :aria-label="t('view.tools.chat_translator.osc_listen_enabled_label')"
                                @update:model-value="(val) => setBoolPref('oscListenEnabled', val)" />
                        </div>

                        <div class="flex items-center justify-between gap-3 flex-wrap">
                            <div class="flex items-center gap-1.5">
                                <span class="text-muted-foreground">{{ t('view.tools.chat_translator.osc_listen_port_label') }}</span>
                                <input
                                    v-model.number="prefs.oscListenPort"
                                    type="number"
                                    min="1024"
                                    max="65535"
                                    class="h-7 w-20 rounded-md border border-input bg-background px-2 text-xs font-mono text-foreground"
                                    @change="handleOscListenPortChange" />
                            </div>
                            <div class="inline-flex items-center gap-2 select-none">
                                <span class="text-foreground">{{ t('view.tools.chat_translator.osc_forward_vrc_label') }}</span>
                                <Switch
                                    :model-value="prefs.oscForwardToVrchat"
                                    :class="TOGGLE_SWITCH_CLASS"
                                    :aria-label="t('view.tools.chat_translator.osc_forward_vrc_label')"
                                    @update:model-value="(val) => setBoolPref('oscForwardToVrchat', val)" />
                            </div>
                        </div>

                        <div v-if="hasPortConflict" class="text-[11px] text-destructive font-medium">
                            {{ t('view.tools.chat_translator.osc_port_conflict') }}
                        </div>

                        <p class="text-[11px] leading-relaxed text-muted-foreground">
                            {{ t('view.tools.chat_translator.desktop_relay_hint') }}
                        </p>

                        <div
                            v-if="activeDevice?.osc?.listenError"
                            class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive break-words">
                            {{ t('view.tools.chat_translator.relay_bind_error_prefix') }} {{ activeDevice.osc.listenError }}
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="secondary" size="sm" @click="isOscSettingsDialogVisible = false">
                        {{ t('view.tools.chat_translator.dialog_close') }}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <!-- Reuse Native Translation API Settings Dialog -->
        <TranslationApiDialog v-model:is-translation-api-dialog-visible="isTranslationApiDialogVisible" />
    </div>
</template>

<script setup>
    import {
        AlertCircle,
        ArrowLeft,
        ArrowLeftRight,
        Check,
        CheckCheck,
        Clock,
        Copy,
        Languages,
        MessageSquareText,
        Monitor,
        RefreshCw,
        RotateCw,
        Send,
        SlidersHorizontal,
        Trash2,
        X
    } from 'lucide-vue-next';
    import {
        computed,
        nextTick,
        onActivated,
        onBeforeUnmount,
        onDeactivated,
        onMounted,
        reactive,
        ref,
        watch
    } from 'vue';
    import { storeToRefs } from 'pinia';
    import { toast } from 'vue-sonner';
    import { useI18n } from 'vue-i18n';
    import { useRouter } from 'vue-router';

    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogTitle
    } from '@/components/ui/dialog';
    import { Spinner } from '@/components/ui/spinner';
    import { Switch } from '@/components/ui/switch';
    import {
        cloudFetch,
        connectCloudHubWs,
        onCloudChatEvent,
        onCloudCommandResult
    } from '@/ipc-web/apiClient';
    import { cloudState } from '@/ipc-web/cloudState';
    import configRepository from '@/services/config';
    import { useAdvancedSettingsStore, useModalStore } from '@/stores';
    import TranslationApiDialog from '@/views/Settings/dialogs/TranslationApiDialog.vue';
    import {
        buildChatTranslationPrompt,
        CHAT_TRANSLATOR_LANGUAGES,
        CHAT_TRANSLATOR_PREFS_KEY,
        composeOscChatboxPayload,
        DEFAULT_OSC_LISTEN_PORT,
        DEFAULT_OSC_SEND_PORT,
        getChatLanguageLabel,
        normalizeOscPort,
        sanitizeOscChatboxText,
        VRC_OSC_MAX_CHARS,
        VRC_OSC_MAX_LINES
    } from './chatTranslatorUtils';

    const { t } = useI18n();
    const router = useRouter();
    const advancedSettingsStore = useAdvancedSettingsStore();
    const modalStore = useModalStore();

    const {
        translationApi,
        translationApiKey,
        translationApiType,
        translationApiEndpoint,
        translationApiModel,
        translationApiPrompt
    } = storeToRefs(advancedSettingsStore);

    const isWebMode = typeof WEB !== 'undefined' && WEB;
    const CHAT_PAGE_SIZE = 20;

    // Distinct gray (off) vs green (on) toggle colors with crisp white thumb in both light & dark modes.
    const TOGGLE_SWITCH_CLASS =
        'data-[state=checked]:bg-emerald-500 dark:data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-400/75 dark:data-[state=unchecked]:bg-zinc-600 [&_[data-slot=switch-thumb]]:bg-white dark:[&_[data-slot=switch-thumb]]:bg-white';

    const prefs = reactive({
        oscEnabled: true,
        translateEnabled: false,
        sourceLang: 'auto',
        targetLang: 'en',
        displayMode: 'translated_and_source',
        immediate: true,
        playSfx: true,
        oscPort: DEFAULT_OSC_SEND_PORT,
        oscListenEnabled: false,
        oscListenPort: DEFAULT_OSC_LISTEN_PORT,
        oscForwardToVrchat: true,
        targetDeviceId: '',
        syncTyping: false,
        autoTranslateDesktop: false
    });

    const isTranslationApiDialogVisible = ref(false);
    const isOscSettingsDialogVisible = ref(false);
    const loadingMessages = ref(false);
    const loadingMoreMessages = ref(false);
    const hasMoreMessages = ref(false);
    const nextBefore = ref('');
    const nextBeforeId = ref('');
    const clearingHistory = ref(false);
    const translatingDraft = ref(false);
    const sending = ref(false);
    const chatDbDedicated = ref(true);

    const draftInput = ref('');
    const previewVisible = ref(false);
    const previewText = ref('');
    const previewTranslatedOnly = ref('');

    const messages = ref([]);
    const devices = ref([]);
    const messageListRef = ref(null);
    const loadMoreSentinelRef = ref(null);
    const translatingIds = reactive(new Set());
    const autoTranslatedIds = new Set();

    let pollTimer = null;
    let unsubChatEvent = null;
    let unsubCmdResult = null;
    let loadMoreObserver = null;
    let typingResetTimer = null;
    let isCurrentlyTyping = false;
    let lastTypingSentAt = 0;
    let configSaveGeneration = 0;
    let configSaveInFlight = false;
    let configSavePending = false;
    let suppressRemoteConfigUntil = 0;
    let liveSyncActive = false;
    let suppressTopLoad = false;

    const hasPortConflict = computed(
        () =>
            prefs.oscListenEnabled &&
            prefs.oscForwardToVrchat &&
            normalizeOscPort(prefs.oscListenPort, DEFAULT_OSC_LISTEN_PORT) ===
                normalizeOscPort(prefs.oscPort, DEFAULT_OSC_SEND_PORT)
    );

    const quickPhrases = computed(() => [
        t('view.tools.chat_translator.quick_phrase_1'),
        t('view.tools.chat_translator.quick_phrase_2'),
        t('view.tools.chat_translator.quick_phrase_3'),
        t('view.tools.chat_translator.quick_phrase_4')
    ]);

    const activeDevice = computed(() => {
        if (prefs.targetDeviceId) {
            return devices.value.find((d) => d.deviceId === prefs.targetDeviceId) || null;
        }
        return (
            devices.value.find((d) => d.realtimeConnected) ||
            devices.value.find((d) => d.online) ||
            devices.value[0] ||
            null
        );
    });

    const hasRealtimeDevice = computed(() => Boolean(activeDevice.value?.realtimeConnected));

    const hasOnlineDevice = computed(() => {
        if (activeDevice.value) {
            return Boolean(activeDevice.value.realtimeConnected || activeDevice.value.online);
        }
        return cloudState.agentsOnline.length > 0;
    });

    const isTranslationConfigured = computed(() => {
        if (!translationApi.value) return false;
        const type = translationApiType.value || 'google';
        if (type === 'openai') {
            return Boolean(translationApiEndpoint.value && translationApiModel.value);
        }
        return Boolean(translationApiKey.value);
    });

    const shouldTranslateOnSend = computed(
        () => prefs.translateEnabled && prefs.displayMode !== 'source_only' && isTranslationConfigured.value
    );

    const translationEngineLabel = computed(() => {
        if (!translationApi.value) {
            return t('view.tools.chat_translator.engine_disabled');
        }
        const type = translationApiType.value || 'google';
        if (type === 'openai') {
            return `OpenAI · ${translationApiModel.value || '?'}`;
        }
        return 'Google Translate';
    });

    const draftOscMetrics = computed(() => sanitizeOscChatboxText(draftInput.value));
    const previewOscMetrics = computed(() => sanitizeOscChatboxText(previewText.value));

    function goBack() {
        router.push({ name: 'tools' });
    }

    function openCloudHubDialog() {
        cloudState.hubDialogOpen = true;
    }

    function applyCloudConfig(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        if (typeof cfg.oscEnabled === 'boolean') prefs.oscEnabled = cfg.oscEnabled;
        if (cfg.oscSendPort !== undefined) {
            prefs.oscPort = normalizeOscPort(cfg.oscSendPort, DEFAULT_OSC_SEND_PORT);
        }
        if (typeof cfg.oscListenEnabled === 'boolean') prefs.oscListenEnabled = cfg.oscListenEnabled;
        if (cfg.oscListenPort !== undefined) {
            prefs.oscListenPort = normalizeOscPort(cfg.oscListenPort, DEFAULT_OSC_LISTEN_PORT);
        }
        if (typeof cfg.oscForwardToVrchat === 'boolean') prefs.oscForwardToVrchat = cfg.oscForwardToVrchat;
        if (typeof cfg.translateEnabled === 'boolean') prefs.translateEnabled = cfg.translateEnabled;
        if (typeof cfg.sourceLang === 'string') prefs.sourceLang = cfg.sourceLang;
        if (typeof cfg.targetLang === 'string') prefs.targetLang = cfg.targetLang;
        if (typeof cfg.displayMode === 'string') prefs.displayMode = cfg.displayMode;
        if (typeof cfg.immediate === 'boolean') prefs.immediate = cfg.immediate;
        if (typeof cfg.playSfx === 'boolean') prefs.playSfx = cfg.playSfx;
        if (typeof cfg.targetDeviceId === 'string') prefs.targetDeviceId = cfg.targetDeviceId;
        if (typeof cfg.syncTyping === 'boolean') prefs.syncTyping = cfg.syncTyping;
        if (typeof cfg.autoTranslateDesktop === 'boolean') prefs.autoTranslateDesktop = cfg.autoTranslateDesktop;
    }

    async function loadPrefs() {
        if (isWebMode) {
            // Cloud DB_CHAT is the single source of truth in Web mode (hydrated via /api/chat/messages).
            return;
        }
        try {
            const raw = await configRepository.getString(CHAT_TRANSLATOR_PREFS_KEY, '');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            applyCloudConfig({
                ...parsed,
                oscSendPort: parsed.oscSendPort ?? parsed.oscPort
            });
        } catch {
            // Keep default preferences if stored JSON is corrupted
        }
    }

    function buildCloudConfigPayload() {
        return {
            oscEnabled: prefs.oscEnabled,
            oscSendPort: normalizeOscPort(prefs.oscPort, DEFAULT_OSC_SEND_PORT),
            oscListenEnabled: prefs.oscListenEnabled,
            oscListenPort: normalizeOscPort(prefs.oscListenPort, DEFAULT_OSC_LISTEN_PORT),
            oscForwardToVrchat: prefs.oscForwardToVrchat,
            translateEnabled: prefs.translateEnabled,
            sourceLang: prefs.sourceLang,
            targetLang: prefs.targetLang,
            displayMode: prefs.displayMode,
            immediate: prefs.immediate,
            playSfx: prefs.playSfx,
            syncTyping: prefs.syncTyping,
            autoTranslateDesktop: prefs.autoTranslateDesktop,
            targetDeviceId: prefs.targetDeviceId
        };
    }

    async function drainConfigSaveQueue() {
        if (configSaveInFlight) return;
        configSaveInFlight = true;
        try {
            while (configSavePending) {
                configSavePending = false;
                if (hasPortConflict.value) {
                    toast.warning(t('view.tools.chat_translator.osc_port_conflict'));
                    continue;
                }
                const gen = configSaveGeneration;
                const payload = buildCloudConfigPayload();
                try {
                    const res = await cloudFetch('/api/chat/config', {
                        method: 'PUT',
                        json: payload
                    });
                    // Guard against our own WS echo / concurrent GET poll overwriting the just-saved state.
                    suppressRemoteConfigUntil = Date.now() + 1500;
                    if (typeof res?.chatDbDedicated === 'boolean') {
                        chatDbDedicated.value = res.chatDbDedicated;
                    }
                    if (gen === configSaveGeneration && !configSavePending && res?.config) {
                        applyCloudConfig(res.config);
                    }
                } catch (err) {
                    toast.error(err?.message || t('view.tools.chat_translator.cloud_config_save_failed'));
                    // If no newer local edits are queued, reconcile back to server truth.
                    if (gen === configSaveGeneration && !configSavePending) {
                        try {
                            const latest = await cloudFetch('/api/chat/config');
                            if (gen === configSaveGeneration && !configSavePending && latest?.config) {
                                applyCloudConfig(latest.config);
                            }
                        } catch {
                            // Ignore reconciliation error
                        }
                    }
                }
            }
        } finally {
            configSaveInFlight = false;
            if (configSavePending) {
                void drainConfigSaveQueue();
            }
        }
    }

    function persistPrefs() {
        prefs.oscPort = normalizeOscPort(prefs.oscPort, DEFAULT_OSC_SEND_PORT);
        prefs.oscListenPort = normalizeOscPort(prefs.oscListenPort, DEFAULT_OSC_LISTEN_PORT);
        if (!isWebMode) {
            configRepository.setString(CHAT_TRANSLATOR_PREFS_KEY, JSON.stringify({ ...prefs }));
            return;
        }
        configSaveGeneration++;
        if (hasPortConflict.value) {
            toast.warning(t('view.tools.chat_translator.osc_port_conflict'));
            return;
        }
        configSavePending = true;
        void drainConfigSaveQueue();
    }

    function setBoolPref(key, value) {
        prefs[key] = Boolean(value);
        persistPrefs();
    }

    function handleOscPortChange() {
        prefs.oscPort = normalizeOscPort(prefs.oscPort, DEFAULT_OSC_SEND_PORT);
        persistPrefs();
    }

    function handleOscListenPortChange() {
        prefs.oscListenPort = normalizeOscPort(prefs.oscListenPort, DEFAULT_OSC_LISTEN_PORT);
        persistPrefs();
    }

    function swapLanguages() {
        if (prefs.sourceLang === 'auto') return;
        const prevSource = prefs.sourceLang;
        prefs.sourceLang = prefs.targetLang;
        prefs.targetLang = prevSource;
        persistPrefs();
    }

    function compareMessagesAsc(a, b) {
        const ta = String(a?.createdAt || '');
        const tb = String(b?.createdAt || '');
        if (ta !== tb) return ta < tb ? -1 : 1;
        const ia = String(a?.id || '');
        const ib = String(b?.id || '');
        if (ia === ib) return 0;
        return ia < ib ? -1 : 1;
    }

    function isNearBottom(el = messageListRef.value, threshold = 120) {
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    }

    function scrollToBottomNow() {
        const el = messageListRef.value;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }

    function upsertMessage(incoming, { forceScroll = false } = {}) {
        if (!incoming || !incoming.id) return;
        const idx = messages.value.findIndex((m) => m.id === incoming.id);
        if (idx >= 0) {
            messages.value[idx] = { ...messages.value[idx], ...incoming };
        } else {
            // Sample scroll position before appending so newly added height doesn't falsely fail the check.
            const shouldScroll = forceScroll || isNearBottom();
            messages.value.push(incoming);
            messages.value.sort(compareMessagesAsc);
            if (shouldScroll) {
                nextTick(() => scrollToBottomNow());
            }
        }
        maybeAutoTranslateDesktopMessage(incoming);
    }

    async function fetchMessages({ showLoader = false, reset = false } = {}) {
        if (!isWebMode) return;
        const startSaveGen = configSaveGeneration;
        const wasEmpty = messages.value.length === 0;
        const wasNearBottom = isNearBottom();
        const prevLatestId = messages.value.length > 0 ? messages.value[messages.value.length - 1]?.id || '' : '';
        if (showLoader) loadingMessages.value = true;
        try {
            const data = await cloudFetch(`/api/chat/messages?limit=${CHAT_PAGE_SIZE}`);
            if (Array.isArray(data?.messages)) {
                const incoming = [...data.messages].sort(compareMessagesAsc);
                if (reset || wasEmpty) {
                    // Prevent top-sentinel auto-load from firing while scrollTop is still at 0 before initial scroll-to-bottom.
                    suppressTopLoad = true;
                    teardownLoadMoreObserver();
                    messages.value = incoming;
                    hasMoreMessages.value = Boolean(data?.hasMore);
                    nextBefore.value = typeof data?.nextBefore === 'string' ? data.nextBefore : '';
                    nextBeforeId.value = typeof data?.nextBeforeId === 'string' ? data.nextBeforeId : '';
                    await nextTick();
                    scrollToBottomNow();
                    suppressTopLoad = false;
                    if (liveSyncActive) {
                        setupLoadMoreObserver();
                    }
                } else {
                    // Merge latest 20 items without discarding older pages already loaded via upward scroll.
                    const mergedMap = new Map();
                    for (const item of messages.value) {
                        if (item?.id) mergedMap.set(item.id, item);
                    }
                    for (const item of incoming) {
                        if (item?.id) mergedMap.set(item.id, { ...(mergedMap.get(item.id) || {}), ...item });
                    }
                    const merged = Array.from(mergedMap.values()).sort(compareMessagesAsc);
                    messages.value = merged;
                    if (!hasMoreMessages.value && Boolean(data?.hasMore) && merged.length <= CHAT_PAGE_SIZE) {
                        hasMoreMessages.value = true;
                        nextBefore.value = typeof data?.nextBefore === 'string' ? data.nextBefore : '';
                        nextBeforeId.value = typeof data?.nextBeforeId === 'string' ? data.nextBeforeId : '';
                    }
                    const newLatestId = merged.length > 0 ? merged[merged.length - 1]?.id || '' : '';
                    if (wasNearBottom && newLatestId && newLatestId !== prevLatestId) {
                        await nextTick();
                        scrollToBottomNow();
                    }
                }
                for (const item of incoming) {
                    maybeAutoTranslateDesktopMessage(item);
                }
            }
            if (Array.isArray(data?.devices)) {
                devices.value = data.devices;
            }
            // Never let a stale GET poll overwrite an in-flight or just-completed local switch change.
            if (
                data?.config &&
                typeof data.config === 'object' &&
                startSaveGen === configSaveGeneration &&
                !configSaveInFlight &&
                !configSavePending &&
                Date.now() >= suppressRemoteConfigUntil
            ) {
                applyCloudConfig(data.config);
            }
            if (typeof data?.chatDbDedicated === 'boolean') {
                chatDbDedicated.value = data.chatDbDedicated;
            }
        } catch (err) {
            suppressTopLoad = false;
            if (showLoader) {
                toast.error(err?.message || t('view.tools.chat_translator.fetch_failed'));
            }
        } finally {
            if (showLoader) loadingMessages.value = false;
        }
    }

    async function loadMoreMessages() {
        if (
            !isWebMode ||
            suppressTopLoad ||
            !hasMoreMessages.value ||
            loadingMoreMessages.value ||
            loadingMessages.value
        ) {
            return;
        }
        const oldest = messages.value.length > 0 ? messages.value[0] : null;
        const cursorBefore = nextBefore.value || oldest?.createdAt || '';
        const cursorBeforeId = nextBeforeId.value || oldest?.id || '';
        if (!cursorBefore) {
            hasMoreMessages.value = false;
            return;
        }

        loadingMoreMessages.value = true;
        try {
            const params = new URLSearchParams({
                limit: String(CHAT_PAGE_SIZE),
                before: cursorBefore,
                heartbeat: '0'
            });
            if (cursorBeforeId) {
                params.set('beforeId', cursorBeforeId);
            }
            const data = await cloudFetch(`/api/chat/messages?${params.toString()}`);
            const incoming = Array.isArray(data?.messages) ? data.messages : [];
            if (incoming.length > 0) {
                const existingIds = new Set(messages.value.map((m) => m.id));
                const prepended = incoming.filter((item) => item?.id && !existingIds.has(item.id));
                if (prepended.length > 0) {
                    const listEl = messageListRef.value;
                    const prevScrollHeight = listEl ? listEl.scrollHeight : 0;
                    const prevScrollTop = listEl ? listEl.scrollTop : 0;
                    messages.value = [...prepended, ...messages.value].sort(compareMessagesAsc);
                    await nextTick();
                    // Preserve reading position after prepending earlier messages above the viewport.
                    if (listEl) {
                        const heightDelta = listEl.scrollHeight - prevScrollHeight;
                        if (heightDelta > 0) {
                            listEl.scrollTop = prevScrollTop + heightDelta;
                        }
                    }
                }
                for (const item of prepended) {
                    maybeAutoTranslateDesktopMessage(item);
                }
            }
            hasMoreMessages.value = Boolean(data?.hasMore) && incoming.length > 0;
            nextBefore.value = typeof data?.nextBefore === 'string' ? data.nextBefore : '';
            nextBeforeId.value = typeof data?.nextBeforeId === 'string' ? data.nextBeforeId : '';
        } catch (err) {
            toast.error(err?.message || t('view.tools.chat_translator.fetch_failed'));
        } finally {
            loadingMoreMessages.value = false;
        }
    }

    function setupLoadMoreObserver() {
        teardownLoadMoreObserver();
        if (
            suppressTopLoad ||
            typeof IntersectionObserver === 'undefined' ||
            !messageListRef.value ||
            !loadMoreSentinelRef.value
        ) {
            return;
        }
        loadMoreObserver = new IntersectionObserver(
            (entries) => {
                const el = messageListRef.value;
                if (!el || suppressTopLoad) return;
                // Only auto-load via top sentinel when the container actually scrolls and user reached the top.
                if (el.scrollHeight <= el.clientHeight || el.scrollTop > 80) return;
                if (entries.some((entry) => entry.isIntersecting)) {
                    void loadMoreMessages();
                }
            },
            {
                root: messageListRef.value,
                rootMargin: '80px 0px 0px 0px',
                threshold: 0
            }
        );
        loadMoreObserver.observe(loadMoreSentinelRef.value);
    }

    function teardownLoadMoreObserver() {
        if (loadMoreObserver) {
            loadMoreObserver.disconnect();
            loadMoreObserver = null;
        }
    }

    watch(
        () => loadMoreSentinelRef.value,
        (el) => {
            if (el && liveSyncActive && !suppressTopLoad) {
                setupLoadMoreObserver();
            } else {
                teardownLoadMoreObserver();
            }
        }
    );

    function handleMessageListScroll() {
        const el = messageListRef.value;
        if (
            !el ||
            suppressTopLoad ||
            !hasMoreMessages.value ||
            loadingMoreMessages.value ||
            loadingMessages.value
        ) {
            return;
        }
        if (el.scrollTop <= 80) {
            void loadMoreMessages();
        }
    }

    async function runTranslation(rawText, targetLang = prefs.targetLang) {
        const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
        if (!trimmed) return null;
        const type = translationApiType.value || 'google';
        const overrides =
            type === 'openai'
                ? {
                      type: 'openai',
                      prompt: buildChatTranslationPrompt(prefs.sourceLang, targetLang, translationApiPrompt.value)
                  }
                : { type: 'google' };
        return advancedSettingsStore.translateText(trimmed, targetLang, overrides);
    }

    async function maybeAutoTranslateDesktopMessage(msg) {
        if (!prefs.translateEnabled || !prefs.autoTranslateDesktop || !isTranslationConfigured.value) return;
        if (
            !msg ||
            (msg.direction !== 'desktop_sync' && msg.direction !== 'peer_incoming') ||
            msg.translatedText ||
            !msg.sourceText
        ) {
            return;
        }
        if (autoTranslatedIds.has(msg.id) || translatingIds.has(msg.id)) return;
        autoTranslatedIds.add(msg.id);
        await translateExistingMessage(msg, { silent: true });
    }

    async function translateExistingMessage(msg, { silent = false } = {}) {
        if (!msg?.sourceText || translatingIds.has(msg.id)) return;
        if (!isTranslationConfigured.value) {
            if (!silent) {
                toast.warning(t('view.tools.chat_translator.translation_not_ready_hint'));
                isTranslationApiDialogVisible.value = true;
            }
            return;
        }
        translatingIds.add(msg.id);
        try {
            const translated = await runTranslation(msg.sourceText, prefs.targetLang);
            if (!translated) return;
            if (isWebMode) {
                const res = await cloudFetch(`/api/chat/messages/${encodeURIComponent(msg.id)}`, {
                    method: 'PATCH',
                    json: {
                        translatedText: translated,
                        targetLang: prefs.targetLang
                    }
                });
                if (res?.message) {
                    upsertMessage(res.message);
                }
            } else {
                upsertMessage({ ...msg, translatedText: translated, targetLang: prefs.targetLang });
            }
        } catch (err) {
            if (!silent) {
                toast.error(err?.message || t('view.tools.chat_translator.translate_failed'));
            }
        } finally {
            translatingIds.delete(msg.id);
        }
    }

    async function handlePreviewTranslate() {
        const raw = draftInput.value.trim();
        if (!raw) return;
        if (!isTranslationConfigured.value) {
            toast.warning(t('view.tools.chat_translator.translation_not_ready_hint'));
            isTranslationApiDialogVisible.value = true;
            return;
        }
        translatingDraft.value = true;
        try {
            const translated = await runTranslation(raw, prefs.targetLang);
            if (!translated) return;
            previewTranslatedOnly.value = translated;
            const composed = composeOscChatboxPayload({
                sourceText: raw,
                translatedText: translated,
                displayMode: prefs.displayMode
            });
            previewText.value = composed.text;
            previewVisible.value = true;
        } finally {
            translatingDraft.value = false;
        }
    }

    function clearPreview() {
        previewVisible.value = false;
        previewText.value = '';
        previewTranslatedOnly.value = '';
    }

    async function dispatchChatToCloud({ sourceText, translatedText, sentText, displayMode }) {
        const sanitized = sanitizeOscChatboxText(sentText);
        if (!sanitized.text) return;

        sending.value = true;
        try {
            notifyTypingStopped();
            if (!isWebMode) {
                upsertMessage(
                    {
                        id: `local_${Date.now()}`,
                        direction: 'web_to_vrc',
                        sourceText,
                        translatedText,
                        sentText: sanitized.text,
                        sourceLang: prefs.sourceLang,
                        targetLang: displayMode === 'source_only' ? '' : prefs.targetLang,
                        displayMode,
                        oscPort: prefs.oscPort,
                        status: 'synced',
                        createdAt: new Date().toISOString()
                    },
                    { forceScroll: true }
                );
                draftInput.value = '';
                clearPreview();
                return;
            }

            const data = await cloudFetch('/api/chat/send', {
                method: 'POST',
                json: {
                    sourceText,
                    translatedText,
                    sentText: sanitized.text,
                    sourceLang: prefs.sourceLang,
                    targetLang: displayMode === 'source_only' ? '' : prefs.targetLang,
                    displayMode,
                    immediate: prefs.immediate,
                    playSfx: prefs.playSfx,
                    oscPort: normalizeOscPort(prefs.oscPort, DEFAULT_OSC_SEND_PORT),
                    targetDeviceId: prefs.targetDeviceId || undefined,
                    sendToVrc: true
                }
            });

            if (data?.message) {
                upsertMessage(data.message, { forceScroll: true });
            }
            if (data?.deliveryStatus === 'failed') {
                toast.warning(data?.message?.errorMessage || t('view.tools.chat_translator.agent_offline'));
            } else {
                toast.success(
                    data?.deliveryStatus === 'dispatched'
                        ? t('view.tools.chat_translator.sent_dispatched')
                        : t('view.tools.chat_translator.sent_queued')
                );
            }
            draftInput.value = '';
            clearPreview();
        } catch (err) {
            toast.error(err?.message || t('view.tools.chat_translator.send_failed'));
        } finally {
            sending.value = false;
        }
    }

    async function sendPreviewToVrchat() {
        const sourceText = draftInput.value.trim() || previewText.value.trim();
        await dispatchChatToCloud({
            sourceText,
            translatedText: previewTranslatedOnly.value || previewText.value.trim(),
            sentText: previewText.value,
            displayMode: prefs.displayMode
        });
    }

    async function handleSendMessage() {
        const raw = draftInput.value.trim();
        if (!raw || sending.value) return;

        if (previewVisible.value && previewText.value.trim()) {
            await sendPreviewToVrchat();
            return;
        }

        // Send original text directly whenever translation is disabled, mode is source_only,
        // or no translation API is configured (never block sending to require a translation API).
        if (!shouldTranslateOnSend.value) {
            await dispatchChatToCloud({
                sourceText: raw,
                translatedText: '',
                sentText: raw,
                displayMode: 'source_only'
            });
            return;
        }

        translatingDraft.value = true;
        let translated = null;
        try {
            translated = await runTranslation(raw, prefs.targetLang);
        } finally {
            translatingDraft.value = false;
        }
        if (!translated) return;

        const composed = composeOscChatboxPayload({
            sourceText: raw,
            translatedText: translated,
            displayMode: prefs.displayMode
        });
        await dispatchChatToCloud({
            sourceText: raw,
            translatedText: translated,
            sentText: composed.text,
            displayMode: prefs.displayMode
        });
    }

    async function resendMessageToVrc(msg) {
        if (!msg) return;
        const textToSend = msg.sentText || msg.translatedText || msg.sourceText;
        if (!textToSend) return;
        await dispatchChatToCloud({
            sourceText: msg.sourceText || textToSend,
            translatedText: msg.translatedText || '',
            sentText: textToSend,
            displayMode: msg.displayMode || 'source_only'
        });
    }

    async function copyMessageText(msg) {
        const text = msg?.sentText || msg?.translatedText || msg?.sourceText || '';
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            toast.success(t('view.tools.chat_translator.copied_toast'));
        } catch {
            toast.error(t('view.tools.chat_translator.copy_failed'));
        }
    }

    async function deleteSingleMessage(id) {
        if (!id) return;
        if (isWebMode) {
            try {
                await cloudFetch(`/api/chat/messages?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
            } catch (err) {
                toast.error(err?.message || t('view.tools.chat_translator.delete_failed'));
                return;
            }
        }
        messages.value = messages.value.filter((m) => m.id !== id);
    }

    async function handleClearHistory() {
        if (messages.value.length === 0) return;
        const { ok } = await modalStore.confirm({
            title: t('view.tools.chat_translator.clear_history'),
            description: t('view.tools.chat_translator.clear_history_confirm')
        });
        if (!ok) return;

        clearingHistory.value = true;
        try {
            if (isWebMode) {
                await cloudFetch('/api/chat/messages', { method: 'DELETE' });
            }
            messages.value = [];
            hasMoreMessages.value = false;
            nextBefore.value = '';
            nextBeforeId.value = '';
            autoTranslatedIds.clear();
            toast.success(t('view.tools.chat_translator.history_cleared'));
        } catch (err) {
            toast.error(err?.message || t('view.tools.chat_translator.delete_failed'));
        } finally {
            clearingHistory.value = false;
        }
    }

    function applyQuickPhrase(phrase) {
        draftInput.value = phrase;
        clearPreview();
    }

    function sendTypingFlag(typing) {
        if (!isWebMode || !prefs.syncTyping || !hasOnlineDevice.value) return;
        cloudFetch('/api/chat/typing', {
            method: 'POST',
            json: {
                typing,
                oscPort: normalizeOscPort(prefs.oscPort, DEFAULT_OSC_SEND_PORT),
                targetDeviceId: prefs.targetDeviceId || undefined
            }
        }).catch(() => {});
    }

    function notifyTypingStopped() {
        if (typingResetTimer) {
            clearTimeout(typingResetTimer);
            typingResetTimer = null;
        }
        if (isCurrentlyTyping) {
            isCurrentlyTyping = false;
            sendTypingFlag(false);
        }
    }

    function handleDraftInput() {
        if (previewVisible.value) {
            clearPreview();
        }
        if (!isWebMode || !prefs.syncTyping || !hasOnlineDevice.value) return;
        const hasText = draftInput.value.trim().length > 0;
        if (!hasText) {
            notifyTypingStopped();
            return;
        }
        const now = Date.now();
        if (!isCurrentlyTyping || now - lastTypingSentAt > 4000) {
            isCurrentlyTyping = true;
            lastTypingSentAt = now;
            sendTypingFlag(true);
        }
        if (typingResetTimer) clearTimeout(typingResetTimer);
        typingResetTimer = setTimeout(() => {
            notifyTypingStopped();
        }, 4500);
    }

    function handleComposerKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            handleSendMessage();
        }
    }

    function showSecondarySource(msg) {
        if (!msg?.sourceText) return false;
        const primary = msg.sentText || msg.translatedText || msg.sourceText;
        return primary !== msg.sourceText && !primary.includes(msg.sourceText);
    }

    function showSecondaryTranslation(msg) {
        if (!msg?.translatedText) return false;
        const primary = msg.sentText || msg.sourceText;
        return primary !== msg.translatedText && !primary.includes(msg.translatedText);
    }

    function isSelfMessage(msg) {
        return msg?.direction !== 'peer_incoming';
    }

    function bubbleContainerClass(msg) {
        const self = isSelfMessage(msg);
        if (msg?.status === 'failed') {
            return self
                ? 'rounded-2xl rounded-br-sm border-destructive/45 bg-destructive/10'
                : 'rounded-2xl rounded-bl-sm border-destructive/45 bg-destructive/10';
        }
        if (self) {
            return 'rounded-2xl rounded-br-sm border-primary/25 bg-primary/12 dark:bg-primary/15';
        }
        return 'rounded-2xl rounded-bl-sm border-border/80 bg-card';
    }

    function statusTextClass(status) {
        if (status === 'sent') {
            return 'text-emerald-600 dark:text-emerald-400';
        }
        if (status === 'synced') {
            return 'text-sky-600 dark:text-sky-400';
        }
        if (status === 'dispatched') {
            return 'text-indigo-600 dark:text-indigo-400';
        }
        if (status === 'failed') {
            return 'text-destructive';
        }
        return 'text-amber-600 dark:text-amber-400';
    }

    function statusBadgeLabel(status) {
        if (status === 'sent') return t('view.tools.chat_translator.status_sent');
        if (status === 'synced') return t('view.tools.chat_translator.status_synced');
        if (status === 'dispatched') return t('view.tools.chat_translator.status_dispatched');
        if (status === 'failed') return t('view.tools.chat_translator.status_failed');
        return t('view.tools.chat_translator.status_queued');
    }

    function formatDateTime(iso) {
        if (!iso) return '';
        const dt = new Date(iso);
        if (Number.isNaN(dt.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    }

    function formatDateTimeFull(iso) {
        if (!iso) return '';
        const dt = new Date(iso);
        if (Number.isNaN(dt.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
    }

    function formatMessageMetaTooltip(msg) {
        const parts = [];
        parts.push(
            msg.direction === 'web_to_vrc'
                ? t('view.tools.chat_translator.dir_web_to_vrc')
                : t('view.tools.chat_translator.dir_desktop_sync')
        );
        if (msg.targetLang) {
            parts.push(
                `${getChatLanguageLabel(msg.sourceLang, t('view.tools.chat_translator.lang_auto'))} → ${getChatLanguageLabel(msg.targetLang)}`
            );
        }
        parts.push(`OSC :${msg.oscPort || DEFAULT_OSC_SEND_PORT}`);
        const fullClock = formatDateTimeFull(msg.createdAt);
        if (fullClock) parts.push(fullClock);
        if (msg.errorMessage) parts.push(msg.errorMessage);
        return parts.join(' · ');
    }

    function applyChatAgentStatusEvent(payload) {
        const deviceId = typeof payload?.deviceId === 'string' ? payload.deviceId : '';
        if (!deviceId) return;
        const connected = payload.connected === true;
        const oscPayload = payload.osc && typeof payload.osc === 'object' ? payload.osc : null;
        const idx = devices.value.findIndex((d) => d.deviceId === deviceId);
        if (idx >= 0) {
            const existing = devices.value[idx];
            devices.value[idx] = {
                ...existing,
                deviceName: oscPayload?.deviceName || existing.deviceName,
                realtimeConnected: connected,
                online: connected || existing.online,
                vrcRunning: oscPayload?.vrcRunning !== undefined ? Boolean(oscPayload.vrcRunning) : existing.vrcRunning,
                osc: oscPayload
                    ? {
                          enabled: oscPayload.enabled !== false,
                          sendPort: oscPayload.sendPort ?? existing.osc?.sendPort ?? DEFAULT_OSC_SEND_PORT,
                          listenEnabled: Boolean(oscPayload.listenEnabled),
                          listenPort: oscPayload.listenPort ?? existing.osc?.listenPort ?? DEFAULT_OSC_LISTEN_PORT,
                          forwardToVrchat: oscPayload.forwardToVrchat !== false,
                          listenError: typeof oscPayload.listenError === 'string' ? oscPayload.listenError : ''
                      }
                    : existing.osc
            };
        } else if (connected) {
            devices.value.push({
                deviceId,
                deviceName: oscPayload?.deviceName || deviceId,
                online: true,
                realtimeConnected: true,
                vrcRunning: Boolean(oscPayload?.vrcRunning),
                lastSeenAt: new Date().toISOString(),
                osc: {
                    enabled: oscPayload?.enabled !== false,
                    sendPort: oscPayload?.sendPort ?? DEFAULT_OSC_SEND_PORT,
                    listenEnabled: Boolean(oscPayload?.listenEnabled),
                    listenPort: oscPayload?.listenPort ?? DEFAULT_OSC_LISTEN_PORT,
                    forwardToVrchat: oscPayload?.forwardToVrchat !== false,
                    listenError: typeof oscPayload?.listenError === 'string' ? oscPayload.listenError : ''
                }
            });
        }
    }

    function startLiveSync() {
        if (!isWebMode || liveSyncActive) return;
        stopLiveSync();
        liveSyncActive = true;

        // Proactively connect `/ws/web` so game/desktop OSC input & delivery receipts arrive instantaneously.
        connectCloudHubWs();

        unsubChatEvent = onCloudChatEvent((evt) => {
            if (evt.type === 'chat.message' && evt.payload?.message) {
                upsertMessage(evt.payload.message);
            } else if (evt.type === 'chat.deleted' && evt.payload?.id) {
                messages.value = messages.value.filter((m) => m.id !== evt.payload.id);
            } else if (evt.type === 'chat.cleared') {
                messages.value = [];
                hasMoreMessages.value = false;
                nextBefore.value = '';
                nextBeforeId.value = '';
                autoTranslatedIds.clear();
            } else if (evt.type === 'chat.agent_status' && evt.payload) {
                applyChatAgentStatusEvent(evt.payload);
            } else if (
                evt.type === 'chat.config_updated' &&
                evt.payload?.config &&
                !configSaveInFlight &&
                !configSavePending &&
                Date.now() >= suppressRemoteConfigUntil
            ) {
                applyCloudConfig(evt.payload.config);
            }
        });

        unsubCmdResult = onCloudCommandResult((evt) => {
            const cmdId = evt?.id || evt?.payload?.cmdId;
            const chatMsgId = evt?.payload?.chatMsgId;
            if (!cmdId && !chatMsgId) return;
            const target = messages.value.find(
                (m) => (chatMsgId && m.id === chatMsgId) || (cmdId && m.cmdId === cmdId)
            );
            if (!target) return;
            const ok = evt?.payload?.status === 'succeeded';
            target.status = ok ? 'sent' : 'failed';
            target.errorMessage = ok ? '' : String(evt?.payload?.message || '');
        });

        fetchMessages({ showLoader: messages.value.length === 0 });
        nextTick(() => setupLoadMoreObserver());
        let fallbackTicks = 0;
        pollTimer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
                return;
            }
            if (!cloudState.wsConnected) {
                connectCloudHubWs();
                fetchMessages({ showLoader: false });
                return;
            }
            // When both Web WS and desktop OSC WS are live, only run a light safety sync every 30s.
            fallbackTicks++;
            const intervalTicks = hasRealtimeDevice.value ? 10 : 2;
            if (fallbackTicks >= intervalTicks) {
                fallbackTicks = 0;
                fetchMessages({ showLoader: false });
            }
        }, 3000);
    }

    function stopLiveSync() {
        liveSyncActive = false;
        suppressTopLoad = false;
        teardownLoadMoreObserver();
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (unsubChatEvent) {
            unsubChatEvent();
            unsubChatEvent = null;
        }
        if (unsubCmdResult) {
            unsubCmdResult();
            unsubCmdResult = null;
        }
        notifyTypingStopped();
    }

    onMounted(async () => {
        await loadPrefs();
        startLiveSync();
    });

    onActivated(() => {
        startLiveSync();
    });

    onDeactivated(() => {
        stopLiveSync();
    });

    onBeforeUnmount(() => {
        stopLiveSync();
    });
</script>
