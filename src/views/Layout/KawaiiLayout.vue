<template>
    <div
        class="kawaii-stage relative flex flex-col flex-1 h-full min-h-0 min-w-0 overflow-hidden p-2 sm:p-3 gap-2.5 sm:gap-3"
        :style="stageWallpaperStyle">
        <!-- Soft pastel atmosphere veil over the sakura sky illustration so foreground cards stay crisp -->
        <div class="kawaii-stage-veil pointer-events-none absolute inset-0 z-0" aria-hidden="true" />
        <div class="kawaii-sparkle kawaii-sparkle-1 pointer-events-none" aria-hidden="true">✦</div>
        <div class="kawaii-sparkle kawaii-sparkle-2 pointer-events-none" aria-hidden="true">✿</div>
        <div class="kawaii-sparkle kawaii-sparkle-3 pointer-events-none" aria-hidden="true">✧</div>

        <!-- Floating Marshmallow Top Command Dock -->
        <header class="kawaii-dock relative z-20 flex items-center gap-2 px-2.5 py-1.5 shrink-0">
            <!-- Brand + Mascot Rail Toggle -->
            <TooltipWrapper side="bottom" :content="t('view.settings.appearance.appearance.kawaii_toggle_mascot')">
                <button
                    type="button"
                    class="kawaii-brand-pill flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-full shrink-0 cursor-pointer"
                    :aria-pressed="isMascotRailVisible"
                    :aria-label="t('view.settings.appearance.appearance.kawaii_toggle_mascot')"
                    @click="toggleMascotRail">
                    <span class="kawaii-brand-avatar relative size-8 rounded-full overflow-hidden shrink-0">
                        <img
                            :src="kawaiiMascotUrl"
                            alt=""
                            class="size-full object-cover object-[50%_18%]"
                            decoding="async" />
                    </span>
                    <span class="flex flex-col items-start leading-none">
                        <span class="kawaii-brand-title text-[13px] font-extrabold tracking-tight flex items-center gap-1">
                            VRCX
                            <Sparkles class="size-3.5 text-primary" />
                        </span>
                        <span class="hidden sm:inline text-[10px] font-semibold kawaii-brand-sub">
                            {{ t('view.settings.appearance.appearance.kawaii_badge') }}
                        </span>
                    </span>
                    <PanelLeftClose v-if="isMascotRailVisible && !isCompactViewport" class="size-3.5 opacity-70 ml-0.5" />
                    <PanelLeftOpen v-else-if="!isCompactViewport" class="size-3.5 opacity-70 ml-0.5" />
                </button>
            </TooltipWrapper>

            <!-- Horizontal Candy Capsule Navigation Rail -->
            <ContextMenu>
                <ContextMenuTrigger as-child>
                    <nav
                        ref="navRailRef"
                        class="kawaii-nav-rail flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-hidden py-0.5 px-1"
                        :aria-label="t('nav_menu.custom_nav.header')"
                        @wheel="handleNavRailWheel">
                        <template v-if="navLayoutReady">
                            <template v-for="item in menuItems" :key="item.index">
                                <!-- Direct Navigation Capsule -->
                                <ContextMenu v-if="!item.children?.length">
                                    <ContextMenuTrigger as-child>
                                        <button
                                            type="button"
                                            class="kawaii-nav-pill relative inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12.5px] font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                                            :data-active="activeMenuIndex === item.index"
                                            :title="getItemLabel(item)"
                                            @click="handleMenuItemClick(item)">
                                            <i :class="item.icon" class="text-[15px] leading-none shrink-0" />
                                            <span>{{ getItemLabel(item) }}</span>
                                            <span
                                                v-if="isNavItemNotified(item)"
                                                class="kawaii-notify-bead"
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

                                <!-- Folder Dropdown Candy Capsule -->
                                <DropdownMenu v-else>
                                    <DropdownMenuTrigger as-child>
                                        <button
                                            type="button"
                                            class="kawaii-nav-pill relative inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12.5px] font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                                            :data-active="isFolderActive(item)"
                                            :title="getItemLabel(item)">
                                            <i :class="item.icon" class="text-[15px] leading-none shrink-0" />
                                            <span>{{ getItemLabel(item) }}</span>
                                            <ChevronDown class="size-3.5 opacity-75 shrink-0" />
                                            <span
                                                v-if="isNavItemNotified(item)"
                                                class="kawaii-notify-bead"
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
                                                    class="kawaii-notify-bead -top-0.5 -right-0.5"
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

            <!-- Right Quick Action Cluster -->
            <div class="flex items-center gap-1.5 shrink-0">
                <!-- Quick Search -->
                <TooltipWrapper side="bottom" :content="t('side_panel.search_placeholder')">
                    <button
                        type="button"
                        class="kawaii-dock-icon-btn inline-flex items-center justify-center size-8 rounded-full cursor-pointer"
                        :aria-label="t('side_panel.search_placeholder')"
                        @click="openQuickSearch">
                        <Search class="size-4" />
                    </button>
                </TooltipWrapper>

                <!-- Friends Panel Toggle Pill -->
                <TooltipWrapper
                    v-if="isSideBarTabShow"
                    side="bottom"
                    :content="t('view.settings.appearance.appearance.kawaii_toggle_friends')">
                    <button
                        type="button"
                        class="kawaii-friends-toggle inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                        :data-active="isMobileViewport ? mobileFriendsOpen : friendsCardOpen"
                        :aria-label="t('view.settings.appearance.appearance.kawaii_toggle_friends')"
                        @click="toggleFriendsCard">
                        <span class="size-2 rounded-full bg-status-online shrink-0" />
                        <Users class="size-3.5 shrink-0" />
                        <span class="tabular-nums">{{ onlineFriendCount }}/{{ friends.size }}</span>
                    </button>
                </TooltipWrapper>

                <!-- One-Click Theme & Candy Palette Switcher -->
                <DropdownMenu>
                    <TooltipWrapper side="bottom" :content="t('view.settings.appearance.appearance.kawaii_quick_theme')">
                        <DropdownMenuTrigger as-child>
                            <button
                                type="button"
                                class="kawaii-dock-icon-btn inline-flex items-center justify-center size-8 rounded-full cursor-pointer"
                                :aria-label="t('view.settings.appearance.appearance.kawaii_quick_theme')">
                                <Palette class="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                    </TooltipWrapper>
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
                            {{ t('view.settings.appearance.appearance.kawaii_accent_colors') }}
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
                                    class="kawaii-candy-dot size-5 rounded-full cursor-pointer"
                                    :data-active="currentThemeColor === color.key"
                                    :style="{ backgroundColor: color.swatch }"
                                    @click="handleThemeColorSelect(color)" />
                            </TooltipWrapper>
                        </div>
                    </DropdownMenuContent>
                </DropdownMenu>

                <!-- Web Cloud Hub Button -->
                <button
                    v-if="isWeb"
                    type="button"
                    class="kawaii-cloud-pill hidden md:inline-flex items-center gap-1 h-8 px-2.5 rounded-full text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                    @click="cloudState.hubDialogOpen = true">
                    <Cloud class="size-3.5 shrink-0" />
                    <span>{{ t('cloud_hub.short_label') }}</span>
                </button>

                <!-- Manage & Settings Dropdown (full parity with NavMenuFooter) -->
                <DropdownMenu>
                    <TooltipWrapper side="bottom" :content="t('nav_tooltip.manage')">
                        <DropdownMenuTrigger as-child>
                            <button
                                type="button"
                                class="kawaii-dock-icon-btn relative inline-flex items-center justify-center size-8 rounded-full cursor-pointer"
                                :data-active="isSettingsRoute"
                                :aria-label="t('nav_tooltip.manage')">
                                <Settings class="size-4" />
                                <span
                                    v-if="pendingVRCXUpdate || pendingVRCXInstall"
                                    class="kawaii-notify-bead top-0.5 right-0.5"
                                    aria-hidden="true" />
                            </button>
                        </DropdownMenuTrigger>
                    </TooltipWrapper>
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
        </header>

        <!-- Main Floating Bento Workspace: Mascot Rail + Main Stage + Friends Journal Card -->
        <div class="relative z-10 flex flex-1 min-h-0 min-w-0 gap-2.5 sm:gap-3 overflow-hidden">
            <!-- Left Collapsible Anime Mascot & Girl-Diary Bento Rail -->
            <aside
                v-if="isMascotRailVisible && !isCompactViewport"
                class="kawaii-mascot-rail flex flex-col gap-2.5 w-[240px] shrink-0 min-h-0 overflow-y-auto scrollbar-hidden pr-0.5">
                <!-- Anime Mascot Hero Showcase Card -->
                <div class="kawaii-hero-card relative overflow-hidden shrink-0">
                    <img
                        :src="kawaiiMascotUrl"
                        alt="Kawaii mascot"
                        class="w-full h-[226px] object-cover object-top block select-none"
                        decoding="async" />
                    <div class="kawaii-hero-top-badge">
                        <span>✦</span>
                        <span>{{ t('view.settings.appearance.appearance.theme_mode_kawaii') }}</span>
                    </div>
                    <div class="kawaii-hero-bubble">
                        <p class="m-0 text-[11.5px] leading-[1.45] font-semibold">
                            {{ kawaiiGreeting }}
                        </p>
                    </div>
                </div>

                <!-- Current User Polaroid Profile Card -->
                <button
                    type="button"
                    class="kawaii-me-card flex items-center gap-2.5 p-2.5 text-left w-full shrink-0 cursor-pointer"
                    @click="openCurrentUserProfile">
                    <div class="relative size-10 shrink-0" :class="userStatusClass(currentUser)">
                        <Avatar class="size-full rounded-full">
                            <AvatarImage :src="userImage(currentUser)" class="object-cover" />
                            <AvatarFallback>
                                <User class="size-5 text-muted-foreground" />
                            </AvatarFallback>
                        </Avatar>
                    </div>
                    <div class="flex flex-col min-w-0 flex-1">
                        <span class="text-[13px] font-bold truncate leading-tight">
                            {{ currentUser.displayName || 'VRChat' }}
                        </span>
                        <span class="text-[11px] text-muted-foreground truncate mt-0.5">
                            {{ currentUser.statusDescription || t('view.settings.appearance.appearance.kawaii_badge') }}
                        </span>
                    </div>
                    <Heart class="size-3.5 text-primary/80 shrink-0 fill-current" />
                </button>

                <!-- Macaron 3-Tile Live Bento Stats -->
                <div class="grid grid-cols-3 gap-1.5 shrink-0">
                    <button
                        type="button"
                        class="kawaii-bento-tile kawaii-bento-pink flex flex-col items-center justify-center py-2 px-1 cursor-pointer"
                        @click="toggleFriendsCard">
                        <span class="text-[15px] font-extrabold tabular-nums leading-none">
                            {{ onlineFriendCount }}
                        </span>
                        <span class="text-[10px] font-semibold mt-1 truncate max-w-full">
                            {{ t('view.settings.appearance.appearance.kawaii_stat_friends') }}
                        </span>
                    </button>

                    <div class="kawaii-bento-tile kawaii-bento-sky flex flex-col items-center justify-center py-2 px-1">
                        <span class="flex items-center gap-1 text-[11px] font-extrabold leading-none">
                            <span
                                class="size-2 rounded-full shrink-0"
                                :class="gameStore.isGameRunning ? 'bg-status-online' : 'bg-status-offline-alt'" />
                            <span class="truncate">
                                {{
                                    gameStore.isGameRunning
                                        ? t('view.settings.appearance.appearance.kawaii_stat_running')
                                        : t('view.settings.appearance.appearance.kawaii_stat_idle')
                                }}
                            </span>
                        </span>
                        <span class="text-[10px] font-semibold mt-1 truncate max-w-full">
                            {{ t('view.settings.appearance.appearance.kawaii_stat_game') }}
                        </span>
                    </div>

                    <button
                        type="button"
                        class="kawaii-bento-tile kawaii-bento-lavender flex flex-col items-center justify-center py-2 px-1 cursor-pointer"
                        @click="vrcStatusStore.openStatusPage()">
                        <span class="flex items-center gap-1 text-[11px] font-extrabold leading-none">
                            <span
                                class="size-2 rounded-full shrink-0"
                                :class="
                                    !vrcStatusStore.hasIssue
                                        ? 'bg-status-online'
                                        : vrcStatusStore.isMajor
                                          ? 'bg-destructive'
                                          : 'bg-status-askme'
                                " />
                            <span class="truncate">
                                {{
                                    vrcStatusStore.hasIssue
                                        ? t('view.settings.appearance.appearance.kawaii_stat_issue')
                                        : t('view.settings.appearance.appearance.kawaii_stat_ok')
                                }}
                            </span>
                        </span>
                        <span class="text-[10px] font-semibold mt-1 truncate max-w-full">
                            {{ t('view.settings.appearance.appearance.kawaii_stat_servers') }}
                        </span>
                    </button>
                </div>

                <!-- Candy Accent Swatch Bar + Quick New Dashboard -->
                <div class="kawaii-palette-card p-2.5 flex flex-col gap-2 shrink-0">
                    <div class="flex items-center justify-between">
                        <span class="text-[11px] font-bold text-muted-foreground">
                            {{ t('view.settings.appearance.appearance.kawaii_accent_colors') }}
                        </span>
                        <Sparkles class="size-3 text-primary" />
                    </div>
                    <div class="flex items-center justify-between gap-1">
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
                                class="kawaii-candy-dot size-5 rounded-full cursor-pointer"
                                :data-active="currentThemeColor === color.key"
                                :style="{ backgroundColor: color.swatch }"
                                @click="handleThemeColorSelect(color)" />
                        </TooltipWrapper>
                    </div>
                    <button
                        v-if="showNewDashboardButton"
                        type="button"
                        class="kawaii-create-btn mt-0.5 flex items-center justify-center gap-1.5 h-8 w-full rounded-full text-xs font-bold cursor-pointer"
                        @click="handleQuickCreateDashboard">
                        <Plus class="size-3.5" />
                        <span>{{ t('dashboard.new_dashboard') }}</span>
                    </button>
                </div>
            </aside>

            <!-- Center Floating Journal Stage -->
            <main class="kawaii-main-stage relative flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
                <div class="kawaii-stage-ribbon shrink-0" aria-hidden="true" />
                <div
                    v-if="isWeb && cloudState.storageDegraded.active && !cloudState.storageDegraded.dismissed"
                    class="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs border-b border-amber-400/50 bg-amber-100/80 text-amber-900 shrink-0">
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

            <!-- Mobile backdrop when friends drawer is open -->
            <div
                v-if="isMobileViewport && isSideBarTabShow && mobileFriendsOpen"
                class="fixed inset-0 z-40 bg-[#422749]/35 backdrop-blur-xs"
                @click="mobileFriendsOpen = false" />

            <!-- Right Floating Friends Journal Card (single mounted instance keeps Ctrl+K & notifications active) -->
            <aside
                v-show="isSideBarTabShow && (isMobileViewport ? mobileFriendsOpen : friendsCardOpen)"
                :class="[
                    'kawaii-friends-card flex flex-col overflow-hidden',
                    isMobileViewport
                        ? 'fixed inset-y-3 right-3 z-50 w-[min(88vw,332px)] max-w-full'
                        : 'relative w-[296px] xl:w-[314px] shrink-0 min-h-0'
                ]">
                <div class="kawaii-friends-ribbon shrink-0" aria-hidden="true" />
                <div class="flex-1 min-h-0 overflow-hidden">
                    <Sidebar />
                </div>
            </aside>
        </div>

        <!-- Bottom Floating Glass Status Capsule -->
        <div class="kawaii-status-pill relative z-20 shrink-0 overflow-hidden">
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
    </div>
</template>

<script setup>
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
    import { storeToRefs } from 'pinia';
    import { useI18n } from 'vue-i18n';
    import { useRouter } from 'vue-router';
    import {
        ChevronDown,
        Cloud,
        Heart,
        Palette,
        PanelLeftClose,
        PanelLeftOpen,
        Plus,
        Search,
        Settings,
        Sparkles,
        User,
        Users
    } from 'lucide-vue-next';

    import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
    import { Button } from '@/components/ui/button';
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

    import kawaiiBgUrl from '../../assets/themes/kawaii/kawaii-bg.jpg';
    import kawaiiMascotUrl from '../../assets/themes/kawaii/kawaii-mascot.jpg';

    const MASCOT_RAIL_STORAGE_KEY = 'vrcx-kawaii-mascot-rail-open';
    const FRIENDS_CARD_STORAGE_KEY = 'vrcx-kawaii-friends-card-open';

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

    const stageWallpaperStyle = computed(() => ({
        backgroundImage: `url("${kawaiiBgUrl}")`
    }));

    const navRailRef = ref(null);
    const customNavDialogVisible = ref(false);
    const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1440);
    const isMobileViewport = computed(() => viewportWidth.value <= 860);
    const isCompactViewport = computed(() => viewportWidth.value < 1080);

    function readStoredBoolean(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === 'true') return true;
            if (raw === 'false') return false;
        } catch {
            // ignore storage failures
        }
        return fallback;
    }

    const mascotRailOpen = ref(readStoredBoolean(MASCOT_RAIL_STORAGE_KEY, true));
    const friendsCardOpen = ref(readStoredBoolean(FRIENDS_CARD_STORAGE_KEY, true));
    const mobileFriendsOpen = ref(false);
    const isMascotRailVisible = computed(() => mascotRailOpen.value);

    const hasNotifications = computed(() => notifiedMenus.value.length > 0);
    const version = computed(() => appVersion.value?.split('VRCX ')?.[1] || '-');
    const vrcxLogo = new URL('../../../images/VRCX.png', import.meta.url).href;
    const isSettingsRoute = computed(() => router.currentRoute.value?.name === 'settings');

    const kawaiiGreeting = computed(() => {
        const hour = new Date().getHours();
        if (hour >= 5 && hour < 11) {
            return t('view.settings.appearance.appearance.kawaii_greeting_morning');
        }
        if (hour >= 11 && hour < 18) {
            return t('view.settings.appearance.appearance.kawaii_greeting_afternoon');
        }
        if (hour >= 18 && hour < 23) {
            return t('view.settings.appearance.appearance.kawaii_greeting_evening');
        }
        return t('view.settings.appearance.appearance.kawaii_greeting_night');
    });

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

    const handleNavRailWheel = (event) => {
        const el = navRailRef.value;
        if (!el || el.scrollWidth <= el.clientWidth) return;
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            event.preventDefault();
            el.scrollLeft += event.deltaY;
        }
    };

    const toggleMascotRail = () => {
        mascotRailOpen.value = !mascotRailOpen.value;
        try {
            localStorage.setItem(MASCOT_RAIL_STORAGE_KEY, String(mascotRailOpen.value));
        } catch {
            // ignore
        }
    };

    const toggleFriendsCard = () => {
        if (isMobileViewport.value) {
            mobileFriendsOpen.value = !mobileFriendsOpen.value;
            return;
        }
        friendsCardOpen.value = !friendsCardOpen.value;
        try {
            localStorage.setItem(FRIENDS_CARD_STORAGE_KEY, String(friendsCardOpen.value));
        } catch {
            // ignore
        }
    };

    const openQuickSearch = () => {
        quickSearchStore.open();
    };

    const openCurrentUserProfile = () => {
        if (currentUser.value?.id) {
            showUserDialog(currentUser.value.id);
        }
    };

    const handleMenuItemClick = (item) => {
        triggerNavAction(item);
    };

    const handleSubmenuClick = (entry) => {
        triggerNavAction(entry);
    };

    const handleSettingsClick = () => {
        router.push({ name: 'settings' });
    };

    const openGithub = () => {
        openExternalLink(links.github);
    };

    const handleSupportLink = (id) => {
        const target = links[id];
        if (target) {
            openExternalLink(target);
        }
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
        handleResize();
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', handleResize);
        }
        await initThemeColor();
        await dashboardStore.loadDashboards();
        await loadNavMenuConfig();
    });

    onUnmounted(() => {
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', handleResize);
        }
    });
</script>
