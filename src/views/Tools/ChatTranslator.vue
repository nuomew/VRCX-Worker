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
                    :variant="showOscSettings ? 'secondary' : 'outline'"
                    size="sm"
                    @click="showOscSettings = !showOscSettings">
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
                    @click="fetchMessages({ showLoader: true })">
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

        <!-- Translation & Display Mode Bar -->
        <div class="shrink-0 mb-3 rounded-lg border border-border bg-card/60 p-3 space-y-2.5">
            <div class="flex flex-wrap items-center gap-2">
                <!-- Source Language -->
                <div class="flex items-center gap-1.5">
                    <span class="text-xs text-muted-foreground">{{ t('view.tools.chat_translator.source_lang') }}</span>
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
                    <span class="text-xs text-muted-foreground">{{ t('view.tools.chat_translator.target_lang') }}</span>
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
                    <span class="text-xs text-muted-foreground">{{ t('view.tools.chat_translator.display_mode') }}</span>
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

                <!-- Quick Toggles -->
                <div class="flex items-center gap-3 ml-auto flex-wrap text-xs">
                    <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                            v-model="prefs.immediate"
                            type="checkbox"
                            class="accent-primary rounded"
                            @change="persistPrefs" />
                        <span>{{ t('view.tools.chat_translator.osc_immediate') }}</span>
                    </label>
                    <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                            v-model="prefs.playSfx"
                            type="checkbox"
                            class="accent-primary rounded"
                            @change="persistPrefs" />
                        <span>{{ t('view.tools.chat_translator.osc_play_sfx') }}</span>
                    </label>
                    <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                            v-model="prefs.autoTranslateDesktop"
                            type="checkbox"
                            class="accent-primary rounded"
                            @change="persistPrefs" />
                        <span>{{ t('view.tools.chat_translator.auto_translate_desktop') }}</span>
                    </label>
                </div>
            </div>

            <!-- Collapsible Cloud-Managed OSC & Companion Bridge Panel (Zero Local Agent Settings) -->
            <div
                v-if="showOscSettings"
                class="pt-2.5 border-t border-border/70 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <!-- Column 1: Master Switch & Target Device -->
                <div class="space-y-2">
                    <label class="inline-flex items-center gap-2 cursor-pointer select-none font-medium text-foreground">
                        <input
                            v-model="prefs.oscEnabled"
                            type="checkbox"
                            class="accent-primary rounded"
                            @change="persistPrefs" />
                        <span>{{ t('view.tools.chat_translator.osc_enabled_label') }}</span>
                    </label>
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
                    <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                            v-model="prefs.syncTyping"
                            type="checkbox"
                            class="accent-primary rounded"
                            @change="persistPrefs" />
                        <span>{{ t('view.tools.chat_translator.sync_typing') }}</span>
                    </label>
                </div>

                <!-- Column 2: Cloud-Controlled Ports & Desktop Relay -->
                <div class="space-y-2">
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

                    <div class="space-y-1.5 pt-0.5">
                        <label class="inline-flex items-center gap-1.5 cursor-pointer select-none font-medium text-foreground">
                            <input
                                v-model="prefs.oscListenEnabled"
                                type="checkbox"
                                class="accent-primary rounded"
                                @change="persistPrefs" />
                            <span>{{ t('view.tools.chat_translator.osc_listen_enabled_label') }}</span>
                        </label>
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-muted-foreground">{{ t('view.tools.chat_translator.osc_listen_port_label') }}</span>
                            <input
                                v-model.number="prefs.oscListenPort"
                                type="number"
                                min="1024"
                                max="65535"
                                class="h-7 w-20 rounded-md border border-input bg-background px-2 text-xs font-mono text-foreground"
                                @change="handleOscListenPortChange" />
                            <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
                                <input
                                    v-model="prefs.oscForwardToVrchat"
                                    type="checkbox"
                                    class="accent-primary rounded"
                                    @change="persistPrefs" />
                                <span>{{ t('view.tools.chat_translator.osc_forward_vrc_label') }}</span>
                            </label>
                        </div>
                        <div v-if="hasPortConflict" class="text-[11px] text-destructive font-medium">
                            {{ t('view.tools.chat_translator.osc_port_conflict') }}
                        </div>
                    </div>
                </div>

                <!-- Column 3: Live Cloud-Synced Relay & Dedicated DB Status -->
                <div class="rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 space-y-1.5">
                    <div class="flex items-center justify-between gap-2 font-medium flex-wrap">
                        <span>{{ t('view.tools.chat_translator.desktop_relay_title') }}</span>
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
                    <p class="text-[11px] leading-relaxed text-muted-foreground">
                        {{ t('view.tools.chat_translator.desktop_relay_hint') }}
                    </p>
                    <p class="text-[11px] leading-relaxed text-muted-foreground/90">
                        {{ t('view.tools.chat_translator.cloud_control_note') }}
                    </p>
                    <div
                        v-if="activeDevice?.osc?.listenError"
                        class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive break-words">
                        {{ t('view.tools.chat_translator.relay_bind_error_prefix') }} {{ activeDevice.osc.listenError }}
                    </div>
                </div>
            </div>

            <!-- Inline Notice when Translation API is Disabled / Unconfigured in Translate Mode -->
            <div
                v-if="needsTranslationConfigNotice"
                class="flex items-center justify-between gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300 flex-wrap">
                <span>{{ t('view.tools.chat_translator.translation_not_ready_hint') }}</span>
                <div class="flex items-center gap-1.5">
                    <Button
                        v-if="!translationApi"
                        size="sm"
                        variant="outline"
                        class="h-7 px-2.5 text-xs"
                        @click="enableTranslationApiQuick">
                        {{ t('view.tools.chat_translator.enable_translation_api') }}
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        class="h-7 px-2.5 text-xs"
                        @click="isTranslationApiDialogVisible = true">
                        {{ t('view.tools.chat_translator.configure_translation_api') }}
                    </Button>
                </div>
            </div>
        </div>

        <!-- Chat & Sync Conversation Feed -->
        <div
            ref="messageListRef"
            class="flex-1 overflow-y-auto min-h-0 rounded-lg border border-border bg-card/30 p-3 space-y-2.5">
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

            <!-- Message Cards -->
            <div
                v-for="msg in messages"
                :key="msg.id"
                class="flex"
                :class="msg.direction === 'web_to_vrc' ? 'justify-end' : 'justify-start'">
                <div
                    class="w-full max-w-[82%] rounded-xl border px-3.5 py-2.5 shadow-xs space-y-1.5"
                    :class="
                        msg.direction === 'web_to_vrc'
                            ? 'border-primary/30 bg-primary/8'
                            : 'border-border bg-card'
                    ">
                    <!-- Top Meta Row -->
                    <div class="flex items-center justify-between gap-2 flex-wrap text-[11px] text-muted-foreground">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <Badge variant="secondary" class="text-[10px] font-normal px-1.5 py-0">
                                {{
                                    msg.direction === 'web_to_vrc'
                                        ? t('view.tools.chat_translator.dir_web_to_vrc')
                                        : t('view.tools.chat_translator.dir_desktop_sync')
                                }}
                            </Badge>
                            <span v-if="msg.targetLang" class="font-mono text-[10px]">
                                {{ getChatLanguageLabel(msg.sourceLang, t('view.tools.chat_translator.lang_auto')) }}
                                →
                                {{ getChatLanguageLabel(msg.targetLang) }}
                            </span>
                            <span class="font-mono text-[10px] opacity-80">
                                OSC :{{ msg.oscPort || 9000 }}
                            </span>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <span
                                class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                :class="statusBadgeClass(msg.status)"
                                :title="msg.errorMessage || ''">
                                {{ statusBadgeLabel(msg.status) }}
                            </span>
                            <span class="tabular-nums opacity-80">{{ formatClock(msg.createdAt) }}</span>
                        </div>
                    </div>

                    <!-- Primary Displayed Text -->
                    <div class="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
                        {{ msg.sentText || msg.translatedText || msg.sourceText }}
                    </div>

                    <!-- Secondary Parallel Source / Translation Line -->
                    <div
                        v-if="showSecondarySource(msg)"
                        class="text-xs text-muted-foreground whitespace-pre-wrap break-words border-t border-border/50 pt-1.5">
                        <span class="font-medium mr-1">{{ t('view.tools.chat_translator.source_prefix') }}</span>
                        {{ msg.sourceText }}
                    </div>
                    <div
                        v-else-if="showSecondaryTranslation(msg)"
                        class="text-xs text-primary whitespace-pre-wrap break-words border-t border-border/50 pt-1.5">
                        <span class="font-medium mr-1">{{ t('view.tools.chat_translator.translated_prefix') }}</span>
                        {{ msg.translatedText }}
                    </div>

                    <!-- Delivery Error Details -->
                    <div v-if="msg.errorMessage" class="text-[11px] text-destructive">
                        {{ msg.errorMessage }}
                    </div>

                    <!-- Per-Message Quick Actions -->
                    <div class="flex items-center justify-end gap-1 pt-0.5">
                        <Button
                            size="sm"
                            variant="ghost"
                            class="h-6 px-2 text-[11px]"
                            :disabled="translatingIds.has(msg.id)"
                            @click="translateExistingMessage(msg)">
                            <Spinner v-if="translatingIds.has(msg.id)" class="size-3" />
                            <Languages v-else class="size-3" />
                            <span>{{ t('view.tools.chat_translator.action_translate') }}</span>
                        </Button>
                        <Button
                            v-if="isWebMode"
                            size="sm"
                            variant="ghost"
                            class="h-6 px-2 text-[11px]"
                            :disabled="sending"
                            @click="resendMessageToVrc(msg)">
                            <Send class="size-3" />
                            <span>{{ t('view.tools.chat_translator.action_resend') }}</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            class="h-6 px-2 text-[11px]"
                            @click="copyMessageText(msg)">
                            <Copy class="size-3" />
                            <span>{{ t('view.tools.chat_translator.action_copy') }}</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            class="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
                            :title="t('view.tools.chat_translator.action_delete')"
                            :ariaLabel="t('view.tools.chat_translator.action_delete')"
                            @click="deleteSingleMessage(msg.id)">
                            <X class="size-3" />
                        </Button>
                    </div>
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
                        v-if="prefs.displayMode !== 'source_only'"
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
                                prefs.displayMode === 'source_only'
                                    ? t('view.tools.chat_translator.send_direct_btn')
                                    : t('view.tools.chat_translator.translate_and_send_btn')
                            }}
                        </span>
                    </Button>
                </div>
            </div>
        </div>

        <!-- Reuse Native Translation API Settings Dialog -->
        <TranslationApiDialog v-model:is-translation-api-dialog-visible="isTranslationApiDialogVisible" />
    </div>
</template>

<script setup>
    import {
        ArrowLeft,
        ArrowLeftRight,
        Copy,
        Languages,
        MessageSquareText,
        RefreshCw,
        Send,
        SlidersHorizontal,
        Trash2,
        X
    } from 'lucide-vue-next';
    import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue';
    import { storeToRefs } from 'pinia';
    import { toast } from 'vue-sonner';
    import { useI18n } from 'vue-i18n';
    import { useRouter } from 'vue-router';

    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import { Spinner } from '@/components/ui/spinner';
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

    const prefs = reactive({
        oscEnabled: true,
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
    const showOscSettings = ref(false);
    const loadingMessages = ref(false);
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
    const translatingIds = reactive(new Set());
    const autoTranslatedIds = new Set();

    let pollTimer = null;
    let unsubChatEvent = null;
    let unsubCmdResult = null;
    let typingResetTimer = null;
    let isCurrentlyTyping = false;
    let lastTypingSentAt = 0;
    let configSaveGeneration = 0;

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

    const needsTranslationConfigNotice = computed(
        () => prefs.displayMode !== 'source_only' && !isTranslationConfigured.value
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

    async function persistPrefs() {
        prefs.oscPort = normalizeOscPort(prefs.oscPort, DEFAULT_OSC_SEND_PORT);
        prefs.oscListenPort = normalizeOscPort(prefs.oscListenPort, DEFAULT_OSC_LISTEN_PORT);
        if (!isWebMode) {
            configRepository.setString(CHAT_TRANSLATOR_PREFS_KEY, JSON.stringify({ ...prefs }));
            return;
        }
        if (hasPortConflict.value) {
            toast.warning(t('view.tools.chat_translator.osc_port_conflict'));
            return;
        }
        const gen = ++configSaveGeneration;
        try {
            const res = await cloudFetch('/api/chat/config', {
                method: 'PUT',
                json: {
                    oscEnabled: prefs.oscEnabled,
                    oscSendPort: prefs.oscPort,
                    oscListenEnabled: prefs.oscListenEnabled,
                    oscListenPort: prefs.oscListenPort,
                    oscForwardToVrchat: prefs.oscForwardToVrchat,
                    sourceLang: prefs.sourceLang,
                    targetLang: prefs.targetLang,
                    displayMode: prefs.displayMode,
                    immediate: prefs.immediate,
                    playSfx: prefs.playSfx,
                    syncTyping: prefs.syncTyping,
                    autoTranslateDesktop: prefs.autoTranslateDesktop,
                    targetDeviceId: prefs.targetDeviceId
                }
            });
            if (gen === configSaveGeneration && res?.config) {
                applyCloudConfig(res.config);
            }
            if (typeof res?.chatDbDedicated === 'boolean') {
                chatDbDedicated.value = res.chatDbDedicated;
            }
        } catch (err) {
            toast.error(err?.message || t('view.tools.chat_translator.cloud_config_save_failed'));
        }
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

    async function enableTranslationApiQuick() {
        if (!translationApi.value) {
            await advancedSettingsStore.setTranslationApi();
        }
        if (!isTranslationConfigured.value) {
            isTranslationApiDialogVisible.value = true;
        }
    }

    function scrollToBottom() {
        nextTick(() => {
            const el = messageListRef.value;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
    }

    function upsertMessage(incoming) {
        if (!incoming || !incoming.id) return;
        const idx = messages.value.findIndex((m) => m.id === incoming.id);
        if (idx >= 0) {
            messages.value[idx] = { ...messages.value[idx], ...incoming };
        } else {
            messages.value.push(incoming);
            if (messages.value.length > 200) {
                messages.value.splice(0, messages.value.length - 200);
            }
            scrollToBottom();
        }
        maybeAutoTranslateDesktopMessage(incoming);
    }

    async function fetchMessages({ showLoader = false } = {}) {
        if (!isWebMode) return;
        if (showLoader) loadingMessages.value = true;
        try {
            const data = await cloudFetch('/api/chat/messages?limit=80');
            const prevCount = messages.value.length;
            const prevLastId = prevCount > 0 ? messages.value[prevCount - 1]?.id : '';
            if (Array.isArray(data?.messages)) {
                messages.value = data.messages;
                const nextLastId = data.messages.length > 0 ? data.messages[data.messages.length - 1]?.id : '';
                if (prevCount === 0 || (nextLastId && nextLastId !== prevLastId)) {
                    scrollToBottom();
                }
                for (const item of data.messages) {
                    maybeAutoTranslateDesktopMessage(item);
                }
            }
            if (Array.isArray(data?.devices)) {
                devices.value = data.devices;
            }
            if (data?.config && typeof data.config === 'object') {
                applyCloudConfig(data.config);
            }
            if (typeof data?.chatDbDedicated === 'boolean') {
                chatDbDedicated.value = data.chatDbDedicated;
            }
        } catch (err) {
            if (showLoader) {
                toast.error(err?.message || t('view.tools.chat_translator.fetch_failed'));
            }
        } finally {
            if (showLoader) loadingMessages.value = false;
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
        if (!prefs.autoTranslateDesktop || !isTranslationConfigured.value) return;
        if (!msg || msg.direction !== 'desktop_sync' || msg.translatedText || !msg.sourceText) return;
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
                upsertMessage({
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
                });
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
                upsertMessage(data.message);
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

        if (prefs.displayMode === 'source_only') {
            await dispatchChatToCloud({
                sourceText: raw,
                translatedText: '',
                sentText: raw,
                displayMode: 'source_only'
            });
            return;
        }

        if (!isTranslationConfigured.value) {
            toast.warning(t('view.tools.chat_translator.translation_not_ready_hint'));
            isTranslationApiDialogVisible.value = true;
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

    function statusBadgeClass(status) {
        if (status === 'sent') {
            return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
        }
        if (status === 'synced') {
            return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
        }
        if (status === 'dispatched') {
            return 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400';
        }
        if (status === 'failed') {
            return 'bg-destructive/15 text-destructive';
        }
        return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    }

    function statusBadgeLabel(status) {
        if (status === 'sent') return t('view.tools.chat_translator.status_sent');
        if (status === 'synced') return t('view.tools.chat_translator.status_synced');
        if (status === 'dispatched') return t('view.tools.chat_translator.status_dispatched');
        if (status === 'failed') return t('view.tools.chat_translator.status_failed');
        return t('view.tools.chat_translator.status_queued');
    }

    function formatClock(iso) {
        if (!iso) return '';
        const dt = new Date(iso);
        if (Number.isNaN(dt.getTime())) return '';
        return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
        if (!isWebMode) return;
        stopLiveSync();

        // Proactively connect `/ws/web` so game/desktop OSC input & delivery receipts arrive instantaneously.
        connectCloudHubWs();

        unsubChatEvent = onCloudChatEvent((evt) => {
            if (evt.type === 'chat.message' && evt.payload?.message) {
                upsertMessage(evt.payload.message);
            } else if (evt.type === 'chat.deleted' && evt.payload?.id) {
                messages.value = messages.value.filter((m) => m.id !== evt.payload.id);
            } else if (evt.type === 'chat.cleared') {
                messages.value = [];
                autoTranslatedIds.clear();
            } else if (evt.type === 'chat.agent_status' && evt.payload) {
                applyChatAgentStatusEvent(evt.payload);
            } else if (evt.type === 'chat.config_updated' && evt.payload?.config) {
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
