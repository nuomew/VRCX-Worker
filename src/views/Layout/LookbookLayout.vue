<template>
    <div class="lb-stage relative flex flex-col flex-1 h-full min-h-0 min-w-0 overflow-hidden">
        <!-- Subtle champagne-gold starlight ornament -->
        <svg
            class="lb-ornament pointer-events-none fixed right-6 top-16 w-[360px] h-[360px] z-0"
            viewBox="0 0 320 320"
            fill="none"
            aria-hidden="true">
            <circle cx="195" cy="125" r="112" stroke="#C4A066" stroke-width="0.8" stroke-dasharray="3 6" />
            <circle cx="195" cy="125" r="88" stroke="#D87A96" stroke-width="0.6" />
            <path
                d="M195 45 L199 116 L270 125 L199 134 L195 205 L191 134 L120 125 L191 116 Z"
                fill="rgba(196, 160, 102, 0.14)"
                stroke="#C4A066"
                stroke-width="0.8" />
        </svg>

        <!-- Borderless High-Fashion Editorial Topbar -->
        <header class="lb-topbar relative z-20 shrink-0 px-3 sm:px-6">
            <div class="max-w-[1600px] mx-auto h-14 flex items-center justify-between gap-2">
                <!-- Left Serif Brand + Cover Toggle -->
                <TooltipWrapper side="bottom" :content="t('view.settings.appearance.appearance.editorial_lookbook_toggle_cover')">
                    <button
                        type="button"
                        class="lb-brand-btn flex items-baseline gap-2 shrink-0 cursor-pointer"
                        :aria-pressed="coverOpen"
                        :aria-label="t('view.settings.appearance.appearance.editorial_lookbook_toggle_cover')"
                        @click="toggleCover">
                        <span class="lb-serif text-[21px] font-bold tracking-[0.14em] leading-none">VRCX</span>
                        <span class="hidden 2xl:inline text-[10px] font-semibold tracking-[0.22em] uppercase lb-gold-text">
                            {{ t('view.settings.appearance.appearance.editorial_lookbook_subtitle') }}
                        </span>
                    </button>
                </TooltipWrapper>

                <!-- Center Underline Editorial Navigation Rail (Priority+ Zero-Clipping) -->
                <ContextMenu>
                    <ContextMenuTrigger as-child>
                        <nav
                            ref="navContainerRef"
                            class="relative flex items-center justify-evenly gap-0.5 flex-1 min-w-0 overflow-hidden"
                            :aria-label="t('nav_menu.custom_nav.header')">
                            <!-- Off-flow measurement mirror matching live nav item typography & padding exactly -->
                            <div
                                ref="navMeasureRef"
                                class="pointer-events-none invisible fixed -top-[9999px] left-0 flex items-center gap-0.5"
                                aria-hidden="true">
                                <span
                                    v-for="item in menuItems"
                                    :key="`m-${item.index}`"
                                    data-priority-item
                                    class="lb-nav-link inline-flex items-center gap-1 h-9 px-2 text-[13px] whitespace-nowrap shrink-0">
                                    <i :class="item.icon" class="text-[14px] leading-none shrink-0" />
                                    <span>{{ getItemLabel(item) }}</span>
                                    <ChevronDown v-if="item.children?.length" class="size-3.5 shrink-0" />
                                </span>
                                <span
                                    data-priority-more
                                    class="lb-nav-link inline-flex items-center gap-1 h-9 px-2 text-[13px] whitespace-nowrap shrink-0">
                                    <span>{{ t('view.settings.appearance.appearance.editorial_nav_more') }}</span>
                                    <ChevronDown class="size-3.5 shrink-0" />
                                </span>
                            </div>

                            <template v-if="navLayoutReady">
                                <template v-for="item in visibleMenuItems" :key="item.index">
                                    <ContextMenu v-if="!item.children?.length">
                                        <ContextMenuTrigger as-child>
                                            <button
                                                type="button"
                                                class="lb-nav-link relative inline-flex items-center gap-1 h-9 px-2 text-[13px] whitespace-nowrap shrink-0 cursor-pointer"
                                                :data-active="activeMenuIndex === item.index"
                                                :title="getItemLabel(item)"
                                                @click="handleMenuItemClick(item)">
                                                <i :class="item.icon" class="text-[14px] leading-none opacity-80 shrink-0" />
                                                <span>{{ getItemLabel(item) }}</span>
                                                <span
                                                    v-if="isNavItemNotified(item)"
                                                    class="lb-notify-dot"
                                                    aria-hidden="true" />
                                            </button>
                                        </ContextMenuTrigger>
                                        <ContextMenuContent>
                                            <ContextMenuItem v-if="hasNotifications" @click="clearAllNotifications">
                                                {{ t('nav_menu.mark_all_read') }}
                                            </ContextMenuItem>
                                            <ContextMenuSeparator v-if="hasNotifications" />
                                            <template v-if="isDashboardItem(item)">
                                                <ContextMenuItem @click="handleEditDashboard(item)">
                                                    {{ t('nav_menu.edit_dashboard') }}
                                                </ContextMenuItem>
                                                <ContextMenuItem
                                                    variant="destructive"
                                                    @click="handleDeleteDashboard(item)">
                                                    {{ t('nav_menu.delete_dashboard') }}
                                                </ContextMenuItem>
                                                <ContextMenuSeparator />
                                            </template>
                                            <ContextMenuItem
                                                v-if="isToolItem(item)"
                                                @click="handleUnpinToolItem(item)">
                                                {{ t('nav_menu.custom_nav.unpin_from_nav') }}
                                            </ContextMenuItem>
                                            <ContextMenuSeparator v-if="isToolItem(item)" />
                                            <ContextMenuItem @click="handleOpenCustomNavDialog">
                                                {{ t('nav_menu.custom_nav.header') }}
                                            </ContextMenuItem>
                                        </ContextMenuContent>
                                    </ContextMenu>

                                    <DropdownMenu v-else>
                                        <DropdownMenuTrigger as-child>
                                            <button
                                                type="button"
                                                class="lb-nav-link relative inline-flex items-center gap-1 h-9 px-2 text-[13px] whitespace-nowrap shrink-0 cursor-pointer"
                                                :data-active="isFolderActive(item)"
                                                :title="getItemLabel(item)">
                                                <i :class="item.icon" class="text-[14px] leading-none opacity-80 shrink-0" />
                                                <span>{{ getItemLabel(item) }}</span>
                                                <ChevronDown class="size-3.5 opacity-70 shrink-0" />
                                                <span
                                                    v-if="isNavItemNotified(item)"
                                                    class="lb-notify-dot"
                                                    aria-hidden="true" />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent side="bottom" align="start" class="w-56">
                                            <DropdownMenuItem
                                                v-for="entry in item.children"
                                                :key="entry.index"
                                                :class="
                                                    activeMenuIndex === entry.index
                                                        ? 'bg-secondary text-secondary-foreground font-semibold'
                                                        : ''
                                                "
                                                @select="handleSubmenuClick(entry)">
                                                <i
                                                    v-if="entry.icon"
                                                    :class="entry.icon"
                                                    class="inline-flex size-4 items-center justify-center text-base relative">
                                                    <span
                                                        v-if="isEntryNotified(entry)"
                                                        class="lb-notify-dot -top-0.5 -right-0.5"
                                                        aria-hidden="true" />
                                                </i>
                                                <span>{{ entry.titleIsCustom ? entry.label : t(entry.label) }}</span>
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem @select="handleOpenCustomNavDialog">
                                                {{ t('nav_menu.custom_nav.header') }}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </template>

                                <!-- Overflow "More" Dropdown -->
                                <DropdownMenu v-if="overflowMenuItems.length">
                                    <DropdownMenuTrigger as-child>
                                        <button
                                            type="button"
                                            class="lb-nav-link relative inline-flex items-center gap-1 h-9 px-2 text-[13px] whitespace-nowrap shrink-0 cursor-pointer"
                                            :data-active="hasActiveOverflow"
                                            :title="t('view.settings.appearance.appearance.editorial_nav_more')">
                                            <span>{{ t('view.settings.appearance.appearance.editorial_nav_more') }}</span>
                                            <ChevronDown class="size-3.5 opacity-70 shrink-0" />
                                            <span
                                                v-if="hasNotifiedOverflow"
                                                class="lb-notify-dot"
                                                aria-hidden="true" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent side="bottom" align="end" class="w-56">
                                        <template v-for="item in overflowMenuItems" :key="`ov-${item.index}`">
                                            <DropdownMenuItem
                                                v-if="!item.children?.length"
                                                :class="
                                                    activeMenuIndex === item.index
                                                        ? 'bg-secondary text-secondary-foreground font-semibold'
                                                        : ''
                                                "
                                                @select="handleMenuItemClick(item)">
                                                <i :class="item.icon" class="inline-flex size-4 items-center justify-center text-base" />
                                                <span>{{ getItemLabel(item) }}</span>
                                            </DropdownMenuItem>
                                            <DropdownMenuSub v-else>
                                                <DropdownMenuSubTrigger>
                                                    <i :class="item.icon" class="inline-flex size-4 items-center justify-center text-base mr-1.5" />
                                                    <span>{{ getItemLabel(item) }}</span>
                                                </DropdownMenuSubTrigger>
                                                <DropdownMenuSubContent side="left" align="start" class="w-52">
                                                    <DropdownMenuItem
                                                        v-for="entry in item.children"
                                                        :key="entry.index"
                                                        :class="
                                                            activeMenuIndex === entry.index
                                                                ? 'bg-secondary text-secondary-foreground font-semibold'
                                                                : ''
                                                        "
                                                        @select="handleSubmenuClick(entry)">
                                                        <i
                                                            v-if="entry.icon"
                                                            :class="entry.icon"
                                                            class="inline-flex size-4 items-center justify-center text-base" />
                                                        <span>{{ entry.titleIsCustom ? entry.label : t(entry.label) }}</span>
                                                    </DropdownMenuItem>
                                                </DropdownMenuSubContent>
                                            </DropdownMenuSub>
                                        </template>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </template>
                        </nav>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem v-if="hasNotifications" @click="clearAllNotifications">
                            {{ t('nav_menu.mark_all_read') }}
                        </ContextMenuItem>
                        <ContextMenuSeparator v-if="hasNotifications" />
                        <ContextMenuItem @click="handleQuickCreateDashboard">
                            {{ t('dashboard.new_dashboard') }}
                        </ContextMenuItem>
                        <ContextMenuItem @click="handleOpenCustomNavDialog">
                            {{ t('nav_menu.custom_nav.header') }}
                        </ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>

                <!-- Right Editorial Action Cluster -->
                <div class="flex items-center gap-1.5 shrink-0">
                    <TooltipWrapper side="bottom" :content="t('side_panel.search_placeholder')">
                        <button
                            type="button"
                            class="lb-icon-btn inline-flex items-center justify-center size-8 rounded-full cursor-pointer"
                            :aria-label="t('side_panel.search_placeholder')"
                            @click="openQuickSearch">
                            <Search class="size-4" />
                        </button>
                    </TooltipWrapper>

                    <!-- Slide-over Friends Salon Drawer Trigger -->
                    <button
                        v-if="isSideBarTabShow"
                        type="button"
                        class="lb-salon-pill inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                        :data-active="salonDrawerOpen"
                        @click="salonDrawerOpen = !salonDrawerOpen">
                        <Sparkles class="size-3.5 lb-gold-text shrink-0" />
                        <span class="hidden sm:inline">
                            {{ t('view.settings.appearance.appearance.editorial_lookbook_salon') }}
                        </span>
                        <span class="tabular-nums font-bold">{{ onlineFriendCount }}/{{ friends.size }}</span>
                    </button>

                    <!-- Quick Theme & Accent Switcher -->
                    <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                            <button
                                type="button"
                                class="lb-icon-btn inline-flex items-center justify-center size-8 rounded-full cursor-pointer"
                                :title="t('view.settings.appearance.appearance.editorial_quick_theme')"
                                :aria-label="t('view.settings.appearance.appearance.editorial_quick_theme')">
                                <Palette class="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="bottom" align="end" class="w-56">
                            <DropdownMenuLabel>{{ t('view.settings.appearance.appearance.theme_mode') }}</DropdownMenuLabel>
                            <DropdownMenuCheckboxItem
                                v-for="theme in themes"
                                :key="theme"
                                :model-value="themeMode === theme"
                                indicator-position="right"
                                @select="handleThemeSelect(theme)">
                                <span>{{ themeDisplayName(theme) }}</span>
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel class="text-xs font-semibold">
                                {{ t('view.settings.appearance.appearance.editorial_accent_colors') }}
                            </DropdownMenuLabel>
                            <div class="flex items-center justify-around px-2 pb-2 pt-1">
                                <TooltipWrapper
                                    v-for="color in themeColors"
                                    :key="color.key"
                                    side="top"
                                    :content="themeColorDisplayName(color)"
                                    :delay-duration="400">
                                    <button
                                        type="button"
                                        :disabled="isApplyingThemeColor"
                                        :aria-pressed="currentThemeColor === color.key"
                                        :aria-label="themeColorDisplayName(color)"
                                        class="lb-swatch-dot size-4.5 rounded-full cursor-pointer"
                                        :data-active="currentThemeColor === color.key"
                                        :style="{ backgroundColor: color.swatch }"
                                        @click="handleThemeColorSelect(color)" />
                                </TooltipWrapper>
                            </div>
                            <DropdownMenuSeparator />
                            <div class="px-2 pt-1.5 pb-2 flex flex-col gap-1.5" @keydown.stop>
                                <div class="flex items-center justify-between text-xs">
                                    <span class="inline-flex items-center gap-1.5 font-semibold">
                                        <Sun class="size-3.5 lb-gold-text shrink-0" />
                                        <span>{{ t('view.settings.appearance.appearance.editorial_theme_brightness') }}</span>
                                    </span>
                                    <button
                                        type="button"
                                        class="text-[11px] font-bold tabular-nums cursor-pointer transition-colors"
                                        :class="
                                            themeBrightness < 100
                                                ? 'text-primary hover:underline'
                                                : 'text-muted-foreground'
                                        "
                                        :title="t('view.settings.appearance.appearance.editorial_theme_brightness_reset')"
                                        @click="resetThemeBrightness">
                                        {{ themeBrightness }}%
                                    </button>
                                </div>
                                <div class="flex items-center gap-2">
                                    <button
                                        type="button"
                                        class="inline-flex items-center justify-center size-5 rounded-full text-muted-foreground hover:text-primary transition-colors cursor-pointer shrink-0"
                                        :aria-label="t('view.settings.appearance.appearance.editorial_theme_brightness')"
                                        @click="stepThemeBrightness(-10)">
                                        <Moon class="size-3.5" />
                                    </button>
                                    <Slider
                                        v-model="themeBrightnessSlider"
                                        class="flex-1"
                                        :min="MIN_THEME_BRIGHTNESS"
                                        :max="MAX_THEME_BRIGHTNESS"
                                        :step="1"
                                        :aria-label="t('view.settings.appearance.appearance.editorial_theme_brightness')" />
                                    <button
                                        type="button"
                                        class="inline-flex items-center justify-center size-5 rounded-full text-muted-foreground hover:text-primary transition-colors cursor-pointer shrink-0"
                                        :aria-label="t('view.settings.appearance.appearance.editorial_theme_brightness')"
                                        @click="stepThemeBrightness(10)">
                                        <Sun class="size-3.5" />
                                    </button>
                                </div>
                            </div>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <button
                        v-if="isWeb"
                        type="button"
                        class="lb-icon-btn hidden md:inline-flex items-center gap-1 h-8 px-2.5 rounded-full text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                        @click="cloudState.hubDialogOpen = true">
                        <Cloud class="size-3.5 shrink-0" />
                        <span>{{ t('cloud_hub.short_label') }}</span>
                    </button>

                    <!-- Manage Dropdown (Full Parity with NavMenuFooter) -->
                    <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                            <button
                                type="button"
                                class="lb-icon-btn relative inline-flex items-center justify-center size-8 rounded-full cursor-pointer"
                                :data-active="isSettingsRoute"
                                :title="t('nav_tooltip.manage')"
                                :aria-label="t('nav_tooltip.manage')">
                                <Settings class="size-4" />
                                <span
                                    v-if="pendingVRCXUpdate || pendingVRCXInstall"
                                    class="lb-notify-dot top-0.5 right-0.5"
                                    aria-hidden="true" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="bottom" align="end" class="w-58">
                            <div class="flex items-center gap-2 px-2 py-1.5">
                                <img
                                    class="h-6 w-6 cursor-pointer"
                                    :src="vrcxLogo"
                                    alt="VRCX"
                                    @click="openGithub" />
                                <div class="flex min-w-0 flex-col">
                                    <button
                                        type="button"
                                        class="text-left text-sm font-semibold truncate flex items-center gap-1 cursor-pointer"
                                        @click="openGithub">
                                        VRCX
                                        <Heart class="size-3.5 text-primary fill-current stroke-none" />
                                    </button>
                                    <span class="text-xs text-muted-foreground">{{ version }}</span>
                                </div>
                            </div>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                v-if="pendingVRCXUpdate || pendingVRCXInstall"
                                @select="showVRCXUpdateDialog">
                                <span>{{ t('nav_menu.update_available') }}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator v-if="pendingVRCXUpdate || pendingVRCXInstall" />
                            <DropdownMenuItem @select="handleSettingsClick">
                                <span>{{ t('nav_tooltip.settings') }}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem v-if="isWeb" @select="cloudState.hubDialogOpen = true">
                                <span>{{ t('cloud_hub.short_label') }}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <span>{{ t('view.settings.appearance.appearance.table_density') }}</span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent side="left" align="start" class="w-48">
                                    <DropdownMenuCheckboxItem
                                        :model-value="tableDensity === 'standard'"
                                        indicator-position="right"
                                        @select="handleTableDensitySelect('standard')">
                                        <span>{{ t('view.settings.appearance.appearance.table_density_comfortable') }}</span>
                                    </DropdownMenuCheckboxItem>
                                    <DropdownMenuCheckboxItem
                                        :model-value="tableDensity === 'comfortable'"
                                        indicator-position="right"
                                        @select="handleTableDensitySelect('comfortable')">
                                        <span>{{ t('view.settings.appearance.appearance.table_density_standard') }}</span>
                                    </DropdownMenuCheckboxItem>
                                    <DropdownMenuCheckboxItem
                                        :model-value="tableDensity === 'compact'"
                                        indicator-position="right"
                                        @select="handleTableDensitySelect('compact')">
                                        <span>{{ t('view.settings.appearance.appearance.table_density_compact') }}</span>
                                    </DropdownMenuCheckboxItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuItem @select="handleOpenCustomNavDialog">
                                <span>{{ t('nav_menu.custom_nav.header') }}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <span>{{ t('nav_tooltip.help_support') }}</span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent side="left" align="start" class="w-48">
                                    <DropdownMenuItem v-if="!isWeb" @select="showChangeLogDialog">
                                        <span>{{ t('nav_menu.changelog') }}</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem @select="handleSupportLink('wiki')">
                                        <span>{{ t('nav_menu.wiki') }}</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem @select="handleSupportLink('github')">
                                        <span>{{ t('nav_menu.github') }}</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem v-if="!isWeb" @select="handleSupportLink('discord')">
                                        <span>{{ t('nav_menu.discord') }}</span>
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" @select="logout">
                                <span>{{ t('dialog.user.actions.logout') }}</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </header>

        <!-- Centered Editorial Lookbook 2-Column Workspace -->
        <div class="relative z-10 flex-1 min-h-0 min-w-0 overflow-hidden px-3 sm:px-6 py-3">
            <div class="max-w-[1600px] mx-auto h-full flex gap-4 min-h-0 min-w-0">
                <!-- Left Collapsible Lookbook Cover & Profile Folio -->
                <aside
                    v-if="coverOpen && !isCompactViewport"
                    class="lb-cover-rail w-[296px] shrink-0 h-full min-h-0 flex flex-col">
                    <div class="lb-folio-card flex-1 min-h-0 p-3.5 sm:p-4 flex flex-col gap-3 overflow-hidden">
                        <div class="flex items-center justify-between text-[10px] font-semibold tracking-[0.22em] uppercase lb-gold-text shrink-0">
                            <span>{{ issueLabel }}</span>
                            <span>✦ ONLINE</span>
                        </div>

                        <!-- Editorial Cover Atmospheric Frame -->
                        <button
                            type="button"
                            class="lb-cover-art relative rounded-xl p-4 text-left overflow-hidden cursor-pointer shrink-0"
                            @click="openCurrentUserProfile">
                            <svg
                                class="pointer-events-none absolute -right-5 -top-5 w-36 h-36 opacity-55"
                                viewBox="0 0 180 180"
                                fill="none"
                                aria-hidden="true">
                                <circle cx="96" cy="84" r="62" fill="rgba(255,255,255,0.52)" stroke="#C4A066" stroke-width="0.8" />
                                <path
                                    d="M96 34 L99 77 L142 84 L99 91 L96 134 L93 91 L50 84 L93 77 Z"
                                    fill="rgba(184,87,120,0.20)"
                                    stroke="#C4A066"
                                    stroke-width="0.9" />
                            </svg>
                            <div class="relative z-10 flex items-center gap-3">
                                <div class="relative size-11 shrink-0" :class="userStatusClass(currentUser)">
                                    <Avatar class="size-full rounded-full">
                                        <AvatarImage :src="userImage(currentUser)" class="object-cover" />
                                        <AvatarFallback>
                                            <User class="size-5 text-muted-foreground" />
                                        </AvatarFallback>
                                    </Avatar>
                                </div>
                                <div class="min-w-0 flex-1">
                                    <div class="text-[10px] tracking-[0.18em] uppercase lb-gold-text">WELCOME BACK</div>
                                    <div class="lb-serif text-lg font-bold truncate leading-tight">
                                        {{ currentUser.displayName || 'VRChat' }}
                                    </div>
                                </div>
                            </div>
                            <p class="relative z-10 m-0 mt-3 text-[11.5px] leading-relaxed text-muted-foreground line-clamp-2">
                                {{
                                    currentUser.statusDescription ||
                                    t('view.settings.appearance.appearance.editorial_lookbook_tagline')
                                }}
                            </p>
                        </button>

                        <!-- 3-Column Editorial Metrics Strip -->
                        <div class="lb-metrics-grid grid grid-cols-3 text-center py-2.5 shrink-0">
                            <button
                                type="button"
                                class="cursor-pointer px-1"
                                @click="salonDrawerOpen = true">
                                <div class="lb-serif text-lg font-bold text-primary tabular-nums leading-none">
                                    {{ onlineFriendCount }}
                                </div>
                                <div class="text-[10.5px] text-muted-foreground mt-1 truncate">
                                    {{ t('view.settings.appearance.appearance.editorial_stat_friends') }}
                                </div>
                            </button>
                            <div class="px-1">
                                <div class="lb-serif text-[13px] font-bold leading-5 truncate">
                                    {{
                                        gameStore.isGameRunning
                                            ? t('view.settings.appearance.appearance.editorial_stat_running')
                                            : t('view.settings.appearance.appearance.editorial_stat_idle')
                                    }}
                                </div>
                                <div class="text-[10.5px] text-muted-foreground mt-0.5 truncate">
                                    {{ t('view.settings.appearance.appearance.editorial_stat_game') }}
                                </div>
                            </div>
                            <button
                                type="button"
                                class="cursor-pointer px-1"
                                @click="vrcStatusStore.openStatusPage()">
                                <div
                                    class="lb-serif text-[13px] font-bold leading-5 truncate"
                                    :class="vrcStatusStore.hasIssue ? 'text-destructive' : 'text-emerald-700'">
                                    {{
                                        vrcStatusStore.hasIssue
                                            ? t('view.settings.appearance.appearance.editorial_stat_issue')
                                            : t('view.settings.appearance.appearance.editorial_stat_ok')
                                    }}
                                </div>
                                <div class="text-[10.5px] text-muted-foreground mt-0.5 truncate">
                                    {{ t('view.settings.appearance.appearance.editorial_stat_servers') }}
                                </div>
                            </button>
                        </div>

                        <!-- Full Categorized Friends Roster (Reuses Native FriendsSidebar with Groups, Online, Active & Offline) -->
                        <div v-if="isSideBarTabShow" class="flex-1 min-h-0 flex flex-col overflow-hidden">
                            <div class="flex items-center justify-between text-xs pb-1.5 border-b border-border/50 shrink-0">
                                <span class="font-semibold">
                                    {{ t('side_panel.friends') }}
                                    <span class="text-muted-foreground font-normal tabular-nums ml-0.5">
                                        ({{ onlineFriendCount }}/{{ friends.size }})
                                    </span>
                                </span>
                            </div>
                            <div class="lb-folio-friends-scroll flex-1 min-h-0 flex flex-col overflow-hidden -mx-1.5">
                                <FriendsSidebar hide-me :render-edit-profile-dialog="false" class="flex-1 min-h-0" />
                            </div>
                        </div>

                        <!-- Quick New Dashboard Action -->
                        <div v-if="showNewDashboardButton" class="pt-2 border-t border-border/70 shrink-0">
                            <button
                                type="button"
                                class="lb-create-btn flex items-center justify-center gap-1.5 h-8 w-full rounded-full text-xs font-semibold cursor-pointer"
                                @click="handleQuickCreateDashboard">
                                <Plus class="size-3.5" />
                                <span>{{ t('dashboard.new_dashboard') }}</span>
                            </button>
                        </div>
                    </div>
                </aside>

                <!-- Right Main Double-Gold-Framed Lookbook Stage -->
                <main class="lb-main-stage flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
                    <div
                        v-if="isWeb && cloudState.storageDegraded.active && !cloudState.storageDegraded.dismissed"
                        class="flex flex-wrap items-center justify-between gap-2 px-4 py-1.5 text-xs border-b border-amber-400/50 bg-amber-50/90 text-amber-900 shrink-0">
                        <span class="min-w-0 truncate">
                            {{
                                cloudState.storageDegraded.reason === 'external_db_unavailable'
                                    ? t('cloud_hub.storage_degraded.banner_mysql_down')
                                    : t('cloud_hub.storage_degraded.banner_full')
                            }}
                        </span>
                        <div class="flex items-center gap-1.5 shrink-0">
                            <Button
                                size="sm"
                                variant="outline"
                                class="h-6 px-2 text-[11px]"
                                @click="router.push({ name: 'settings', query: { tab: 'storage' } })">
                                {{ t('cloud_hub.storage_degraded.open_storage_btn') }}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                class="h-6 w-6 p-0 text-xs"
                                :aria-label="t('cloud_hub.storage_degraded.dismiss_btn')"
                                @click="cloudState.storageDegraded.dismissed = true">
                                ×
                            </Button>
                        </div>
                    </div>
                    <div class="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
                        <RouterView v-slot="{ Component }">
                            <KeepAlive exclude="ChartsInstance, ChartsMutual">
                                <component :is="Component" />
                            </KeepAlive>
                        </RouterView>
                    </div>
                </main>
            </div>
        </div>

        <!-- Slide-Over Friends Salon Drawer Backdrop -->
        <div
            v-if="isSideBarTabShow && salonDrawerOpen"
            class="fixed inset-0 z-40 bg-[#2D2228]/25 backdrop-blur-xs"
            @click="salonDrawerOpen = false" />

        <!-- Single Mounted Friends Salon Drawer (v-show keeps Ctrl+K & Notifications alive) -->
        <aside
            v-show="isSideBarTabShow && salonDrawerOpen"
            class="lb-salon-drawer fixed inset-y-0 right-0 z-50 w-[min(90vw,360px)] max-w-full flex flex-col overflow-hidden">
            <div class="flex items-center justify-between px-4 py-3 border-b border-border/80 shrink-0">
                <div>
                    <div class="text-[10px] font-semibold tracking-[0.22em] uppercase lb-gold-text">FRIENDS SALON</div>
                    <div class="lb-serif text-base font-bold leading-tight">
                        {{ t('view.settings.appearance.appearance.editorial_lookbook_salon') }}
                        <span class="text-xs font-normal text-muted-foreground ml-1 tabular-nums">
                            ({{ onlineFriendCount }}/{{ friends.size }})
                        </span>
                    </div>
                </div>
                <button
                    type="button"
                    class="lb-icon-btn inline-flex items-center justify-center size-7 rounded-full cursor-pointer"
                    :aria-label="t('common.actions.close')"
                    @click="salonDrawerOpen = false">
                    <X class="size-3.5" />
                </button>
            </div>
            <div class="flex-1 min-h-0 overflow-hidden">
                <Sidebar />
            </div>
        </aside>

        <!-- Minimal Champagne-Bordered Bottom StatusBar -->
        <div class="lb-statusbar relative z-20 shrink-0">
            <StatusBar />
        </div>

        <CustomNavDialog
            v-model:visible="customNavDialogVisible"
            :layout="navLayout"
            :hidden-keys="navHiddenKeys"
            :default-hidden-keys="defaultHiddenKeys"
            :default-layout="defaultNavLayout"
            :definitions="allNavDefinitions"
            @save="handleCustomNavSave"
            @dashboard-created="handleDashboardCreated" />

        <!-- Non-interactive viewport dimmer scoped strictly to Lookbook lifecycle (above all portals/dialogs/toasts) -->
        <Teleport to="body">
            <div
                v-if="dimOverlayOpacity > 0"
                class="lb-brightness-dimmer pointer-events-none fixed inset-0 z-[2147483647]"
                :style="{ backgroundColor: `rgba(22, 16, 20, ${dimOverlayOpacity})`, zIndex: 2147483647 }"
                aria-hidden="true" />
        </Teleport>
    </div>
</template>

<script setup>
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
    import { storeToRefs } from 'pinia';
    import { useI18n } from 'vue-i18n';
    import { useRouter } from 'vue-router';
    import { ChevronDown, Cloud, Heart, Moon, Palette, Plus, Search, Settings, Sparkles, Sun, User, X } from 'lucide-vue-next';

    import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
    import { Button } from '@/components/ui/button';
    import { Slider } from '@/components/ui/slider';
    import {
        ContextMenu,
        ContextMenuContent,
        ContextMenuItem,
        ContextMenuSeparator,
        ContextMenuTrigger
    } from '@/components/ui/context-menu';
    import {
        DropdownMenu,
        DropdownMenuCheckboxItem,
        DropdownMenuContent,
        DropdownMenuItem,
        DropdownMenuLabel,
        DropdownMenuSeparator,
        DropdownMenuSub,
        DropdownMenuSubContent,
        DropdownMenuSubTrigger,
        DropdownMenuTrigger
    } from '@/components/ui/dropdown-menu';
    import { TooltipWrapper } from '@/components/ui/tooltip';

    import { useNavLayout } from '../../components/nav-menu/composables/useNavLayout';
    import { useNavTheme } from '../../components/nav-menu/composables/useNavTheme';
    import { usePriorityNav } from './composables/usePriorityNav';
    import { handoffEarlyBrightnessOverlay, useThemeBrightness } from './composables/useThemeBrightness';
    import { isEntryNotified as checkEntryNotified } from '../../components/nav-menu/navMenuUtils';
    import { useToolActions } from '../../composables/useToolActions';
    import { useToolNavPinning } from '../../composables/useToolNavPinning';
    import { useUserDisplay } from '../../composables/useUserDisplay';
    import { showUserDialog } from '../../coordinators/userCoordinator';
    import { cloudState } from '../../ipc-web/cloudState';
    import { DASHBOARD_NAV_KEY_PREFIX, links } from '../../shared/constants';
    import { openExternalLink } from '../../shared/utils';
    import {
        useAppearanceSettingsStore,
        useAuthStore,
        useDashboardStore,
        useFriendStore,
        useGameStore,
        useModalStore,
        useSearchStore,
        useUiStore,
        useUserStore,
        useVrcStatusStore,
        useVRCXUpdaterStore
    } from '../../stores';
    import { useQuickSearchStore } from '../../stores/quickSearch';

    import CustomNavDialog from '../../components/dialogs/CustomNavDialog.vue';
    import StatusBar from '../../components/StatusBar.vue';
    import Sidebar from '../Sidebar/Sidebar.vue';
    import FriendsSidebar from '../Sidebar/components/FriendsSidebar.vue';

    const COVER_STORAGE_KEY = 'vrcx-lookbook-cover-open';

    const { t, locale } = useI18n();
    const router = useRouter();
    const isWeb = typeof WEB !== 'undefined' && WEB;

    const appearanceSettingsStore = useAppearanceSettingsStore();
    const { themeMode, tableDensity, showNewDashboardButton, isSideBarTabShow } =
        storeToRefs(appearanceSettingsStore);

    const VRCXUpdaterStore = useVRCXUpdaterStore();
    const { pendingVRCXUpdate, pendingVRCXInstall, appVersion } = storeToRefs(VRCXUpdaterStore);
    const { showVRCXUpdateDialog, showChangeLogDialog } = VRCXUpdaterStore;

    const dashboardStore = useDashboardStore();
    const { dashboards } = storeToRefs(dashboardStore);

    const uiStore = useUiStore();
    const { notifiedMenus } = storeToRefs(uiStore);
    const { clearAllNotifications } = uiStore;

    const friendStore = useFriendStore();
    const { friends, onlineFriendCount } = storeToRefs(friendStore);

    const userStore = useUserStore();
    const { currentUser } = storeToRefs(userStore);
    const { userImage, userStatusClass } = useUserDisplay();

    const gameStore = useGameStore();
    const vrcStatusStore = useVrcStatusStore();
    const quickSearchStore = useQuickSearchStore();

    const { directAccessPaste } = useSearchStore();
    const { triggerTool } = useToolActions();
    const { unpinToolFromNav } = useToolNavPinning();
    const { logout } = useAuthStore();
    const modalStore = useModalStore();

    const {
        themes,
        themeColors,
        currentThemeColor,
        isApplyingThemeColor,
        initThemeColor,
        themeDisplayName,
        themeColorDisplayName,
        handleThemeSelect,
        handleTableDensitySelect,
        handleThemeColorSelect
    } = useNavTheme({
        t,
        appearanceSettingsStore
    });

    const {
        navLayout,
        navLayoutReady,
        navHiddenKeys,
        defaultHiddenKeys,
        menuItems,
        activeMenuIndex,
        allNavDefinitions,
        defaultNavLayout,
        sanitizeLayoutLocal,
        saveNavLayout,
        applyCustomNavLayout,
        loadNavMenuConfig,
        triggerNavAction
    } = useNavLayout({
        t,
        locale,
        router,
        dashboardStore,
        dashboards,
        directAccessPaste,
        triggerTool
    });

    const customNavDialogVisible = ref(false);
    const salonDrawerOpen = ref(false);
    const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1440);
    const isCompactViewport = computed(() => viewportWidth.value < 1120);

    function readStoredBoolean(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === 'true') return true;
            if (raw === 'false') return false;
        } catch {
            // ignore
        }
        return fallback;
    }

    const coverOpen = ref(readStoredBoolean(COVER_STORAGE_KEY, true));

    const {
        MIN_THEME_BRIGHTNESS,
        MAX_THEME_BRIGHTNESS,
        themeBrightness,
        themeBrightnessSlider,
        dimOverlayOpacity,
        stepThemeBrightness,
        resetThemeBrightness
    } = useThemeBrightness();

    const issueLabel = computed(() => {
        const now = new Date();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `VOL.${m} · ISSUE ${d}`;
    });

    const hasNotifications = computed(() => notifiedMenus.value.length > 0);
    const version = computed(() => appVersion.value?.split('VRCX ')?.[1] || '-');
    const vrcxLogo = new URL('../../../images/VRCX.png', import.meta.url).href;
    const isSettingsRoute = computed(() => router.currentRoute.value?.name === 'settings');

    const getItemLabel = (item) => (item.titleIsCustom ? item.title : t(item.title || ''));
    const isEntryNotified = (entry) => checkEntryNotified(entry, notifiedMenus.value);
    const isFolderActive = (item) => Boolean(item?.children?.some((entry) => entry.index === activeMenuIndex.value));

    const isNavItemNotified = (item) => {
        if (!item) return false;
        if (notifiedMenus.value.includes(item.index)) return true;
        if (item.children?.length) {
            return item.children.some((entry) => isEntryNotified(entry));
        }
        return false;
    };

    const isDashboardItem = (item) => item?.index?.startsWith(DASHBOARD_NAV_KEY_PREFIX);
    const isToolItem = (item) => item?.index?.startsWith('tool-');

    const {
        navContainerRef,
        navMeasureRef,
        visibleMenuItems,
        overflowMenuItems,
        hasActiveOverflow,
        hasNotifiedOverflow,
        scheduleRecalc
    } = usePriorityNav({
        menuItems,
        activeMenuIndex,
        isNavItemNotified,
        locale,
        gap: 2,
        moreButtonWidth: 66
    });

    const toggleCover = () => {
        coverOpen.value = !coverOpen.value;
        try {
            localStorage.setItem(COVER_STORAGE_KEY, String(coverOpen.value));
        } catch {
            // ignore
        }
    };

    const openQuickSearch = () => quickSearchStore.open();
    const openCurrentUserProfile = () => {
        if (currentUser.value?.id) {
            showUserDialog(currentUser.value.id);
        }
    };

    const handleMenuItemClick = (item) => triggerNavAction(item);
    const handleSubmenuClick = (entry) => triggerNavAction(entry);
    const handleSettingsClick = () => router.push({ name: 'settings' });
    const openGithub = () => openExternalLink(links.github);
    const handleSupportLink = (id) => {
        const target = links[id];
        if (target) openExternalLink(target);
    };
    const handleOpenCustomNavDialog = () => {
        customNavDialogVisible.value = true;
    };

    const handleUnpinToolItem = async (item) => {
        if (!isToolItem(item)) return;
        await unpinToolFromNav(item.index.replace(/^tool-/, ''));
    };

    const handleQuickCreateDashboard = async () => {
        const dashboard = await dashboardStore.createDashboard(t('dashboard.default_name'));
        const dashboardKey = `${DASHBOARD_NAV_KEY_PREFIX}${dashboard.id}`;
        const currentLayout = [...navLayout.value];
        const directAccessIdx = currentLayout.findIndex(
            (entry) => entry.type === 'item' && entry.key === 'direct-access'
        );
        const newEntry = { type: 'item', key: dashboardKey };
        if (directAccessIdx !== -1) {
            currentLayout.splice(directAccessIdx, 0, newEntry);
        } else {
            currentLayout.push(newEntry);
        }
        const nextHiddenKeys = navHiddenKeys.value.filter((key) => key !== dashboardKey);
        const sanitized = sanitizeLayoutLocal(currentLayout, nextHiddenKeys);
        navLayout.value = sanitized;
        navHiddenKeys.value = nextHiddenKeys;
        await saveNavLayout(sanitized, nextHiddenKeys);
        await router.push({ name: 'dashboard', params: { id: dashboard.id } });
        dashboardStore.setEditingDashboardId(dashboard.id);
    };

    const handleEditDashboard = async (item) => {
        if (!isDashboardItem(item)) return;
        const dashboardId = item.index.replace(DASHBOARD_NAV_KEY_PREFIX, '');
        const currentRoute = router.currentRoute.value;
        if (currentRoute?.name !== 'dashboard' || String(currentRoute?.params?.id || '') !== dashboardId) {
            await router.push({ name: 'dashboard', params: { id: dashboardId } });
        }
        dashboardStore.setEditingDashboardId(dashboardId);
    };

    const handleDeleteDashboard = async (item) => {
        if (!isDashboardItem(item)) return;
        const { ok } = await modalStore.confirm({
            title: t('dashboard.confirmations.delete_title'),
            description: t('dashboard.confirmations.delete_description'),
            destructive: true
        });
        if (!ok) return;
        const dashboardId = item.index.replace(DASHBOARD_NAV_KEY_PREFIX, '');
        await dashboardStore.deleteDashboard(dashboardId);
        const currentRoute = router.currentRoute.value;
        if (currentRoute?.name === 'dashboard' && String(currentRoute?.params?.id || '') === dashboardId) {
            router.replace({ name: 'feed' });
        }
    };

    const handleCustomNavSave = async (layout, hiddenKeys) => {
        await applyCustomNavLayout(layout, hiddenKeys);
        customNavDialogVisible.value = false;
    };

    const handleDashboardCreated = async (dashboardId, layout, hiddenKeys) => {
        await handleCustomNavSave(layout, hiddenKeys);
        await router.push({ name: 'dashboard', params: { id: dashboardId } });
        dashboardStore.setEditingDashboardId(dashboardId);
    };

    const handleResize = () => {
        if (typeof window !== 'undefined') {
            viewportWidth.value = window.innerWidth;
        }
    };

    watch(isSideBarTabShow, (show) => {
        if (!show) {
            salonDrawerOpen.value = false;
        }
    });

    onMounted(async () => {
        handoffEarlyBrightnessOverlay('lookbook');
        handleResize();
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', handleResize);
        }
        await initThemeColor();
        await dashboardStore.loadDashboards();
        await loadNavMenuConfig();
        await scheduleRecalc();
    });

    onUnmounted(() => {
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', handleResize);
        }
    });
</script>
