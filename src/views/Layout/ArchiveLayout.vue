<template>
    <div class="arc-stage relative flex flex-col flex-1 h-full min-h-0 min-w-0 overflow-hidden">
        <!-- Geometric Halo Ring Architectural Ornament -->
        <svg
            class="arc-halo-ornament pointer-events-none fixed right-6 top-16 w-[380px] h-[380px] z-0"
            viewBox="0 0 400 400"
            fill="none"
            aria-hidden="true">
            <circle cx="265" cy="120" r="94" stroke="#009FE8" stroke-width="1.8" />
            <circle cx="265" cy="120" r="76" stroke="#009FE8" stroke-width="1" stroke-dasharray="10 6" />
            <line x1="145" y1="120" x2="385" y2="120" stroke="#009FE8" stroke-width="1" opacity="0.45" />
            <line x1="265" y1="0" x2="265" y2="240" stroke="#009FE8" stroke-width="1" opacity="0.45" />
            <polygon points="322,22 354,22 338,46 306,46" fill="#FFC42E" opacity="0.48" />
        </svg>

        <!-- Crisp White & Azure Slanted Official-Site Topbar -->
        <header class="arc-topbar relative z-20 shrink-0 px-3 sm:px-5">
            <div class="max-w-[1600px] mx-auto h-13 flex items-center justify-between gap-2">
                <!-- Left Slanted Brand Badge + Online Strip Toggle -->
                <TooltipWrapper side="bottom" :content="t('view.settings.appearance.appearance.editorial_archive_toggle_strip')">
                    <button
                        type="button"
                        class="arc-brand-badge arc-skew px-3.5 py-1.5 shrink-0 cursor-pointer"
                        :aria-pressed="onlineStripOpen"
                        :aria-label="t('view.settings.appearance.appearance.editorial_archive_toggle_strip')"
                        @click="toggleOnlineStrip">
                        <span class="font-black text-xs sm:text-[13px] tracking-wider">
                            VRCX
                            <span class="hidden 2xl:inline">
                                // {{ t('view.settings.appearance.appearance.editorial_archive_subtitle') }}
                            </span>
                        </span>
                    </button>
                </TooltipWrapper>

                <!-- Center Slanted Navigation Rail (Priority+ Zero-Clipping) -->
                <ContextMenu>
                    <ContextMenuTrigger as-child>
                        <nav
                            ref="navContainerRef"
                            class="relative flex items-center justify-evenly gap-1 flex-1 min-w-0 overflow-hidden px-1 py-1"
                            :aria-label="t('nav_menu.custom_nav.header')">
                            <!-- Off-flow measurement mirror so whole skewed tabs move into More cleanly -->
                            <div
                                ref="navMeasureRef"
                                class="pointer-events-none invisible fixed -top-[9999px] left-0 flex items-center gap-1"
                                aria-hidden="true">
                                <span
                                    v-for="item in menuItems"
                                    :key="`m-${item.index}`"
                                    data-priority-item
                                    class="arc-nav-tab arc-skew inline-flex items-center h-8 px-2.5 text-xs whitespace-nowrap shrink-0">
                                    <span>
                                        <i :class="item.icon" class="text-[14px] leading-none shrink-0" />
                                        <span>{{ getItemLabel(item) }}</span>
                                        <ChevronDown v-if="item.children?.length" class="size-3.5 shrink-0" />
                                    </span>
                                </span>
                                <span
                                    data-priority-more
                                    class="arc-nav-tab arc-skew inline-flex items-center h-8 px-2.5 text-xs whitespace-nowrap shrink-0">
                                    <span>
                                        <span>{{ t('view.settings.appearance.appearance.editorial_nav_more') }}</span>
                                        <ChevronDown class="size-3.5 shrink-0" />
                                    </span>
                                </span>
                            </div>

                            <template v-if="navLayoutReady">
                                <template v-for="item in visibleMenuItems" :key="item.index">
                                    <ContextMenu v-if="!item.children?.length">
                                        <ContextMenuTrigger as-child>
                                            <button
                                                type="button"
                                                class="arc-nav-tab arc-skew relative h-8 px-2.5 text-xs whitespace-nowrap shrink-0 cursor-pointer"
                                                :data-active="activeMenuIndex === item.index"
                                                :title="getItemLabel(item)"
                                                @click="handleMenuItemClick(item)">
                                                <span>
                                                    <i :class="item.icon" class="text-[14px] leading-none shrink-0" />
                                                    <span>{{ getItemLabel(item) }}</span>
                                                </span>
                                                <em
                                                    v-if="isNavItemNotified(item)"
                                                    class="arc-notify-dot"
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
                                                class="arc-nav-tab arc-skew relative h-8 px-2.5 text-xs whitespace-nowrap shrink-0 cursor-pointer"
                                                :data-active="isFolderActive(item)"
                                                :title="getItemLabel(item)">
                                                <span>
                                                    <i :class="item.icon" class="text-[14px] leading-none shrink-0" />
                                                    <span>{{ getItemLabel(item) }}</span>
                                                    <ChevronDown class="size-3.5 opacity-75 shrink-0" />
                                                </span>
                                                <em
                                                    v-if="isNavItemNotified(item)"
                                                    class="arc-notify-dot"
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
                                                    class="inline-flex size-4 items-center justify-center text-base relative" />
                                                <span>{{ entry.titleIsCustom ? entry.label : t(entry.label) }}</span>
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem @select="handleOpenCustomNavDialog">
                                                {{ t('nav_menu.custom_nav.header') }}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </template>

                                <!-- Overflow "More" Slanted Dropdown -->
                                <DropdownMenu v-if="overflowMenuItems.length">
                                    <DropdownMenuTrigger as-child>
                                        <button
                                            type="button"
                                            class="arc-nav-tab arc-skew relative h-8 px-2.5 text-xs whitespace-nowrap shrink-0 cursor-pointer"
                                            :data-active="hasActiveOverflow"
                                            :title="t('view.settings.appearance.appearance.editorial_nav_more')">
                                            <span>
                                                <span>{{ t('view.settings.appearance.appearance.editorial_nav_more') }}</span>
                                                <ChevronDown class="size-3.5 opacity-75 shrink-0" />
                                            </span>
                                            <em
                                                v-if="hasNotifiedOverflow"
                                                class="arc-notify-dot"
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

                <!-- Right Tactical Quick Controls -->
                <div class="flex items-center gap-1.5 shrink-0">
                    <TooltipWrapper side="bottom" :content="t('side_panel.search_placeholder')">
                        <button
                            type="button"
                            class="arc-icon-btn inline-flex items-center justify-center size-8 rounded-md cursor-pointer"
                            :aria-label="t('side_panel.search_placeholder')"
                            @click="openQuickSearch">
                            <Search class="size-4" />
                        </button>
                    </TooltipWrapper>

                    <!-- Sunny-Gold Slanted ONLINE Pill (Toggles Friends Panel) -->
                    <TooltipWrapper
                        v-if="isSideBarTabShow"
                        side="bottom"
                        :content="t('view.settings.appearance.appearance.editorial_archive_toggle_panel')">
                        <button
                            type="button"
                            class="arc-gold-pill arc-skew h-8 px-3 text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer"
                            :data-active="isMobileViewport ? mobileFriendsOpen : friendsPanelOpen"
                            :aria-label="t('view.settings.appearance.appearance.editorial_archive_toggle_panel')"
                            @click="toggleFriendsPanel">
                            <span>
                                <Users class="size-3.5 shrink-0" />
                                <strong class="tabular-nums">{{ onlineFriendCount }}/{{ friends.size }}</strong>
                            </span>
                        </button>
                    </TooltipWrapper>

                    <!-- Quick Theme & Accent Switcher -->
                    <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                            <button
                                type="button"
                                class="arc-icon-btn inline-flex items-center justify-center size-8 rounded-md cursor-pointer"
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
                                        class="arc-swatch-dot size-4.5 rounded-sm cursor-pointer"
                                        :data-active="currentThemeColor === color.key"
                                        :style="{ backgroundColor: color.swatch }"
                                        @click="handleThemeColorSelect(color)" />
                                </TooltipWrapper>
                            </div>
                            <DropdownMenuSeparator />
                            <div class="px-2 pt-1.5 pb-2 flex flex-col gap-1.5" @keydown.stop>
                                <div class="flex items-center justify-between text-xs">
                                    <span class="inline-flex items-center gap-1.5 font-semibold">
                                        <Sun class="size-3.5 text-primary shrink-0" />
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
                                        class="inline-flex items-center justify-center size-5 rounded-md text-muted-foreground hover:text-primary transition-colors cursor-pointer shrink-0"
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
                                        class="inline-flex items-center justify-center size-5 rounded-md text-muted-foreground hover:text-primary transition-colors cursor-pointer shrink-0"
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
                        class="arc-icon-btn hidden md:inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                        @click="cloudState.hubDialogOpen = true">
                        <Cloud class="size-3.5 shrink-0" />
                        <span>{{ t('cloud_hub.short_label') }}</span>
                    </button>

                    <!-- Manage Dropdown (Full Parity) -->
                    <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                            <button
                                type="button"
                                class="arc-icon-btn relative inline-flex items-center justify-center size-8 rounded-md cursor-pointer"
                                :data-active="isSettingsRoute"
                                :title="t('nav_tooltip.manage')"
                                :aria-label="t('nav_tooltip.manage')">
                                <Settings class="size-4" />
                                <em
                                    v-if="pendingVRCXUpdate || pendingVRCXInstall"
                                    class="arc-notify-dot top-0.5 right-0.5"
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
                            <DropdownMenuItem v-if="showNewDashboardButton" @select="handleQuickCreateDashboard">
                                <span>{{ t('dashboard.new_dashboard') }}</span>
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

        <!-- Signature Horizontal Online Friends Halo Strip (Collapsible) -->
        <section v-if="onlineStripOpen" class="relative z-10 shrink-0 px-3 sm:px-5 pt-2.5">
            <div class="arc-strip-card max-w-[1600px] mx-auto px-3.5 py-2 flex items-center gap-3">
                <!-- Current User Quick Anchor -->
                <button
                    type="button"
                    class="flex items-center gap-2 pr-3 border-r border-border shrink-0 text-left cursor-pointer"
                    @click="openCurrentUserProfile">
                    <div class="relative size-8 shrink-0" :class="userStatusClass(currentUser)">
                        <Avatar class="size-full rounded-full">
                            <AvatarImage :src="userImage(currentUser)" class="object-cover" />
                            <AvatarFallback>
                                <User class="size-4 text-muted-foreground" />
                            </AvatarFallback>
                        </Avatar>
                    </div>
                    <div class="hidden sm:flex flex-col leading-tight">
                        <span class="text-[10px] font-black tracking-[0.16em] uppercase text-primary">SCHALE ONLINE</span>
                        <span class="text-xs font-extrabold truncate max-w-[116px]">
                            {{ currentUser.displayName || 'VRChat' }}
                        </span>
                    </div>
                </button>

                <!-- Horizontal Scrollable Online Friends Halo Avatars -->
                <div
                    v-if="stripOnlineFriends.length"
                    class="flex items-center gap-3 flex-1 min-w-0 overflow-x-auto scrollbar-hidden py-0.5">
                    <button
                        v-for="friend in stripOnlineFriends"
                        :key="friend.id"
                        type="button"
                        class="arc-halo-friend flex items-center gap-2 pr-2.5 pl-1 py-1 rounded-full shrink-0 cursor-pointer"
                        :title="friend.ref?.displayName || friend.name"
                        @click="showUserDialog(friend.id)">
                        <div class="relative size-7 shrink-0" :class="userStatusClass(friend.ref)">
                            <Avatar class="size-full rounded-full">
                                <AvatarImage :src="userImage(friend.ref, true)" class="object-cover" />
                                <AvatarFallback>
                                    <User class="size-3.5 text-muted-foreground" />
                                </AvatarFallback>
                            </Avatar>
                        </div>
                        <span class="text-xs font-bold max-w-[84px] truncate">
                            {{ friend.ref?.displayName || friend.name }}
                        </span>
                    </button>
                </div>
                <div v-else class="flex-1 min-w-0 text-xs text-muted-foreground truncate">
                    {{ t('view.settings.appearance.appearance.editorial_archive_online_strip') }} · {{ onlineFriendCount }}/{{ friends.size }}
                </div>

                <!-- Compact Live Status Chips -->
                <div class="hidden xl:flex items-center gap-1.5 shrink-0 pl-2 border-l border-border">
                    <span class="arc-status-chip text-[11px] font-bold">
                        <span
                            class="size-1.5 rounded-full shrink-0"
                            :class="gameStore.isGameRunning ? 'bg-status-online' : 'bg-status-offline-alt'" />
                        <span>
                            {{
                                gameStore.isGameRunning
                                    ? t('view.settings.appearance.appearance.editorial_stat_running')
                                    : t('view.settings.appearance.appearance.editorial_stat_idle')
                            }}
                        </span>
                    </span>
                    <button
                        type="button"
                        class="arc-status-chip text-[11px] font-bold cursor-pointer"
                        @click="vrcStatusStore.openStatusPage()">
                        <span
                            class="size-1.5 rounded-full shrink-0"
                            :class="!vrcStatusStore.hasIssue ? 'bg-status-online' : 'bg-destructive'" />
                        <span>
                            {{
                                vrcStatusStore.hasIssue
                                    ? t('view.settings.appearance.appearance.editorial_stat_issue')
                                    : t('view.settings.appearance.appearance.editorial_stat_ok')
                            }}
                        </span>
                    </button>
                </div>
            </div>
        </section>

        <!-- Asymmetric Blueprint Workspace: Crisp Main Stage + Right Friends Roster -->
        <div class="relative z-10 flex-1 min-h-0 min-w-0 overflow-hidden px-3 sm:px-5 py-2.5">
            <div class="max-w-[1600px] mx-auto h-full flex gap-3 min-h-0 min-w-0">
                <main class="arc-main-stage flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
                    <div
                        v-if="isWeb && cloudState.storageDegraded.active && !cloudState.storageDegraded.dismissed"
                        class="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs border-b border-amber-400/50 bg-amber-50 text-amber-900 shrink-0">
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

                <div
                    v-if="isMobileViewport && isSideBarTabShow && mobileFriendsOpen"
                    class="fixed inset-0 z-40 bg-[#142238]/35 backdrop-blur-xs"
                    @click="mobileFriendsOpen = false" />

                <!-- Single Mounted Friends Panel (v-show preserves Ctrl+K & Notifications) -->
                <aside
                    v-show="isSideBarTabShow && (isMobileViewport ? mobileFriendsOpen : friendsPanelOpen)"
                    :class="[
                        'arc-friends-panel flex flex-col overflow-hidden',
                        isMobileViewport
                            ? 'fixed inset-y-3 right-3 z-50 w-[min(88vw,336px)] max-w-full'
                            : 'relative w-[296px] xl:w-[312px] shrink-0 min-h-0'
                    ]">
                    <div class="flex-1 min-h-0 overflow-hidden">
                        <Sidebar />
                    </div>
                </aside>
            </div>
        </div>

        <div class="arc-statusbar relative z-20 shrink-0">
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

        <!-- Non-interactive viewport dimmer scoped strictly to Archive lifecycle (above all portals/dialogs/toasts) -->
        <Teleport to="body">
            <div
                v-if="dimOverlayOpacity > 0"
                class="arc-brightness-dimmer pointer-events-none fixed inset-0 z-[2147483647]"
                :style="{ backgroundColor: `rgba(14, 24, 38, ${dimOverlayOpacity})`, zIndex: 2147483647 }"
                aria-hidden="true" />
        </Teleport>
    </div>
</template>

<script setup>
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
    import { storeToRefs } from 'pinia';
    import { useI18n } from 'vue-i18n';
    import { useRouter } from 'vue-router';
    import { ChevronDown, Cloud, Heart, Moon, Palette, Search, Settings, Sun, User, Users } from 'lucide-vue-next';

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

    const STRIP_STORAGE_KEY = 'vrcx-archive-online-strip-open';
    const PANEL_STORAGE_KEY = 'vrcx-archive-friends-panel-open';

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
    const { friends, onlineFriends, vipFriends, onlineFriendCount } = storeToRefs(friendStore);

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
    const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1440);
    const isMobileViewport = computed(() => viewportWidth.value <= 900);

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

    const onlineStripOpen = ref(readStoredBoolean(STRIP_STORAGE_KEY, true));
    const friendsPanelOpen = ref(readStoredBoolean(PANEL_STORAGE_KEY, true));
    const mobileFriendsOpen = ref(false);

    const {
        MIN_THEME_BRIGHTNESS,
        MAX_THEME_BRIGHTNESS,
        themeBrightness,
        themeBrightnessSlider,
        dimOverlayOpacity,
        stepThemeBrightness,
        resetThemeBrightness
    } = useThemeBrightness();

    const stripOnlineFriends = computed(() => {
        const seen = new Set();
        const merged = [];
        for (const list of [vipFriends.value || [], onlineFriends.value || []]) {
            for (const f of list) {
                if (!f?.id || seen.has(f.id) || f.state !== 'online') continue;
                seen.add(f.id);
                merged.push(f);
                if (merged.length >= 20) return merged;
            }
        }
        return merged;
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
        gap: 4,
        moreButtonWidth: 74
    });

    const toggleOnlineStrip = () => {
        onlineStripOpen.value = !onlineStripOpen.value;
        try {
            localStorage.setItem(STRIP_STORAGE_KEY, String(onlineStripOpen.value));
        } catch {
            // ignore
        }
    };

    const toggleFriendsPanel = () => {
        if (isMobileViewport.value) {
            mobileFriendsOpen.value = !mobileFriendsOpen.value;
            return;
        }
        friendsPanelOpen.value = !friendsPanelOpen.value;
        try {
            localStorage.setItem(PANEL_STORAGE_KEY, String(friendsPanelOpen.value));
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
            if (!isMobileViewport.value) {
                mobileFriendsOpen.value = false;
            }
        }
    };

    watch(isSideBarTabShow, (show) => {
        if (!show) {
            mobileFriendsOpen.value = false;
        }
    });

    onMounted(async () => {
        handoffEarlyBrightnessOverlay('archive');
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
