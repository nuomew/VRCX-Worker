<template>
    <div class="x-container flex flex-col overflow-hidden">
        <!-- Header with Back to Tools button -->
        <div class="flex items-center justify-between gap-2 ml-2 mb-3 shrink-0 flex-wrap">
            <div class="flex items-center gap-2">
                <Button variant="ghost" size="sm" class="mr-3" @click="goBack">
                    <ArrowLeft />
                    {{ t('nav_tooltip.tools') }}
                </Button>
                <span class="header">{{ t('view.tools.avatar.search') }}</span>
                <Badge variant="outline" class="text-xs font-normal">
                    {{ t('dialog.avatar.tags.public') }}
                </Badge>
            </div>
        </div>

        <!-- Search & Filter Bar -->
        <form
            class="shrink-0 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/60 p-3"
            @submit.prevent="runNewSearch">
            <select
                v-model="searchType"
                :aria-label="t('view.tools.avatar.search_type_label')"
                class="h-9 rounded-md border border-input bg-background px-2.5 text-xs text-foreground dark:[color-scheme:dark]"
                @change="handleFilterChange">
                <option class="bg-card text-foreground" value="all">
                    {{ t('view.tools.avatar.search_type_all') }}
                </option>
                <option class="bg-card text-foreground" value="name">
                    {{ t('view.tools.avatar.search_type_name') }}
                </option>
                <option class="bg-card text-foreground" value="author">
                    {{ t('view.tools.avatar.search_type_author') }}
                </option>
                <option class="bg-card text-foreground" value="id">
                    {{ t('view.tools.avatar.search_type_id') }}
                </option>
            </select>

            <div class="relative flex-1 min-w-[220px]">
                <input
                    v-model="searchInput"
                    type="text"
                    :placeholder="searchPlaceholder"
                    class="h-9 w-full rounded-md border border-input bg-background pl-3 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
                <button
                    v-if="searchInput"
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    :aria-label="t('view.search.clear_results_tooltip')"
                    @click="clearSearch">
                    <X class="size-4" />
                </button>
            </div>

            <select
                v-model="platformFilter"
                :aria-label="t('view.tools.avatar.platform_label')"
                class="h-9 rounded-md border border-input bg-background px-2.5 text-xs text-foreground dark:[color-scheme:dark]"
                @change="handleFilterChange">
                <option class="bg-card text-foreground" value="all">
                    {{ t('view.tools.avatar.platform_all') }}
                </option>
                <option class="bg-card text-foreground" value="pc">PC</option>
                <option class="bg-card text-foreground" value="android">Quest / Android</option>
                <option class="bg-card text-foreground" value="ios">iOS</option>
            </select>

            <Button type="submit" size="sm" class="h-9 px-4" :disabled="loading || !searchInput.trim()">
                <Spinner v-if="loading" class="size-4" />
                <Search v-else class="size-4" />
                <span>{{ t('view.tools.avatar.search_btn') }}</span>
            </Button>
        </form>

        <!-- Results / States (containerRef stays mounted so ResizeObserver knows grid width immediately) -->
        <div ref="avatarSearchContainerRef" class="flex-1 overflow-y-auto min-h-0 pr-2">
            <!-- Initial Empty Guide -->
            <div
                v-if="!hasSearched && !loading"
                class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/30 px-6 py-14 text-center space-y-2.5">
                <Search class="size-8 text-muted-foreground/70" />
                <div class="text-sm font-medium text-foreground">
                    {{ t('view.tools.avatar.empty_guide_title') }}
                </div>
            </div>

            <!-- Loading State -->
            <div v-else-if="loading" class="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
                <Spinner class="text-2xl" />
                <span class="text-xs">{{ t('view.tools.avatar.searching') }}</span>
            </div>

            <!-- Error / Private / Invalid ID Notice -->
            <div
                v-else-if="errorMessage"
                class="flex flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center space-y-3">
                <p class="text-sm text-destructive">{{ errorMessage }}</p>
                <Button v-if="canRetry" size="sm" variant="outline" @click="retryCurrentPage">
                    {{ t('view.tools.avatar.retry_btn') }}
                </Button>
            </div>

            <!-- Public Avatar Cards Grid (aligned with FavoritesAvatarItem compact horizontal cards) -->
            <template v-else-if="results.length > 0">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-2 px-0.5 text-xs text-muted-foreground">
                    <span>
                        {{
                            t('view.tools.avatar.result_summary', {
                                count: results.length,
                                page: pageIndex + 1
                            })
                        }}
                    </span>
                    <span class="text-[11px]">{{ t('view.tools.avatar.click_card_hint') }}</span>
                </div>

                <div class="avatar-search-card-list" :style="avatarSearchGridStyle(results.length)">
                    <ContextMenu v-for="avatar in results" :key="avatar.id">
                        <ContextMenuTrigger as-child>
                            <Item
                                variant="outline"
                                class="favorites-item cursor-pointer hover:bg-muted x-hover-list"
                                :style="itemStyle"
                                @click="openAvatarDetail(avatar)">
                                <ItemMedia variant="image">
                                    <Avatar class="rounded-sm size-full">
                                        <AvatarImage
                                            v-if="getSmallThumbnail(avatar)"
                                            :src="getSmallThumbnail(avatar)"
                                            :alt="avatar.name"
                                            loading="lazy"
                                            decoding="async"
                                            fetchpriority="low"
                                            class="rounded-sm object-cover" />
                                        <AvatarFallback class="rounded-sm">
                                            <Image class="size-4 text-muted-foreground" />
                                        </AvatarFallback>
                                    </Avatar>
                                </ItemMedia>

                                <ItemContent class="min-w-0">
                                    <ItemTitle class="max-w-full" :title="avatar.name">
                                        <span class="truncate">{{ avatar.name }}</span>
                                    </ItemTitle>
                                    <ItemDescription
                                        class="line-clamp-none flex items-center gap-1.5 text-xs min-w-0"
                                        :title="avatar.authorName || avatar.authorId">
                                        <span class="truncate">{{ avatar.authorName || avatar.authorId || '-' }}</span>
                                        <span
                                            v-if="avatar.compatibility?.length"
                                            class="inline-flex items-center gap-1 shrink-0 opacity-80">
                                            <Monitor
                                                v-if="avatar.compatibility.includes('pc')"
                                                class="size-3 text-platform-pc" />
                                            <Smartphone
                                                v-if="avatar.compatibility.includes('android')"
                                                class="size-3 text-platform-quest" />
                                            <Apple
                                                v-if="avatar.compatibility.includes('ios')"
                                                class="size-3 text-platform-ios" />
                                        </span>
                                    </ItemDescription>
                                </ItemContent>

                                <ItemActions>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger as-child>
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                class="rounded-full"
                                                :ariaLabel="t('nav_tooltip.manage')"
                                                @click.stop>
                                                <MoreHorizontal class="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem @click="openAvatarDetail(avatar)">
                                                {{ t('common.actions.view_details') }}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                :disabled="currentUser.currentAvatar === avatar.id"
                                                @click="handleSelectAvatar(avatar)">
                                                {{ t('view.favorite.select_avatar_tooltip') }}
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem @click="handleOpenFavoriteDialog(avatar)">
                                                {{ t('view.favorite.edit_favorite_tooltip') }}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                v-if="avatar.authorName || avatar.authorId"
                                                @click="searchByAuthor(avatar)">
                                                {{ t('view.tools.avatar.filter_by_author_tooltip') }}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </ItemActions>
                            </Item>
                        </ContextMenuTrigger>

                        <ContextMenuContent>
                            <ContextMenuItem @click="openAvatarDetail(avatar)">
                                {{ t('common.actions.view_details') }}
                            </ContextMenuItem>
                            <ContextMenuItem
                                :disabled="currentUser.currentAvatar === avatar.id"
                                @click="handleSelectAvatar(avatar)">
                                {{ t('view.favorite.select_avatar_tooltip') }}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem @click="handleOpenFavoriteDialog(avatar)">
                                {{ t('view.favorite.edit_favorite_tooltip') }}
                            </ContextMenuItem>
                            <ContextMenuItem
                                v-if="avatar.authorName || avatar.authorId"
                                @click="searchByAuthor(avatar)">
                                {{ t('view.tools.avatar.filter_by_author_tooltip') }}
                            </ContextMenuItem>
                        </ContextMenuContent>
                    </ContextMenu>
                </div>
            </template>

            <!-- Empty Filtered Page while Upstream Still Has More Pages -->
            <div
                v-else-if="hasMore"
                class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/30 px-6 py-12 text-center space-y-3">
                <p class="text-xs text-muted-foreground">
                    {{ t('view.tools.avatar.empty_filtered_page') }}
                </p>
                <Button size="sm" variant="outline" :disabled="loading" @click="goNextPage">
                    <span>{{ t('view.tools.avatar.next_page') }}</span>
                    <ChevronRight class="size-4" />
                </Button>
            </div>

            <!-- No Match State -->
            <DataTableEmpty v-else type="nodata" />
        </div>

        <!-- Pagination Bar -->
        <div
            v-if="hasSearched && (pageIndex > 0 || hasMore)"
            class="shrink-0 mt-2 pt-2 border-t border-border flex items-center justify-center gap-3 text-xs">
            <Button size="sm" variant="outline" :disabled="loading || pageIndex === 0" @click="goPrevPage">
                <ChevronLeft class="size-4" />
                <span>{{ t('view.tools.avatar.prev_page') }}</span>
            </Button>
            <span class="font-mono text-muted-foreground tabular-nums">
                {{ t('view.tools.avatar.page_indicator', { page: pageIndex + 1 }) }}
            </span>
            <Button size="sm" variant="outline" :disabled="loading || !hasMore" @click="goNextPage">
                <span>{{ t('view.tools.avatar.next_page') }}</span>
                <ChevronRight class="size-4" />
            </Button>
        </div>
    </div>
</template>

<script setup>
    import {
        Apple,
        ArrowLeft,
        ChevronLeft,
        ChevronRight,
        Image,
        Monitor,
        MoreHorizontal,
        Search,
        Smartphone,
        X
    } from 'lucide-vue-next';
    import { computed, onActivated, onBeforeUnmount, ref } from 'vue';
    import { storeToRefs } from 'pinia';
    import { toast } from 'vue-sonner';
    import { useI18n } from 'vue-i18n';
    import { useRouter } from 'vue-router';

    import { avatarRequest } from '@/api';
    import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import {
        ContextMenu,
        ContextMenuContent,
        ContextMenuItem,
        ContextMenuSeparator,
        ContextMenuTrigger
    } from '@/components/ui/context-menu';
    import { DataTableEmpty } from '@/components/ui/data-table';
    import {
        DropdownMenu,
        DropdownMenuContent,
        DropdownMenuItem,
        DropdownMenuSeparator,
        DropdownMenuTrigger
    } from '@/components/ui/dropdown-menu';
    import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
    import { Spinner } from '@/components/ui/spinner';
    import { applyAvatar, selectAvatarWithConfirmation, showAvatarDialog } from '@/coordinators/avatarCoordinator';
    import { searchPublicAvatars } from '@/ipc-web/publicAvatarSearch';
    import { useAvatarStore, useFavoriteStore, useUserStore } from '@/stores';
    import { useFavoritesCardScaling } from '@/views/Favorites/composables/useFavoritesCardScaling.js';

    const { t } = useI18n();
    const router = useRouter();
    const avatarStore = useAvatarStore();
    const { showFavoriteDialog } = useFavoriteStore();
    const { currentUser } = storeToRefs(useUserStore());

    // Reuse the same card scaling & spacing preferences as Favorites -> Avatars for visual parity.
    const {
        containerRef: avatarSearchContainerRef,
        gridStyle: avatarSearchGridStyle,
        reloadPreferences: reloadCardScalingPreferences
    } = useFavoritesCardScaling({
        configKey: 'VRCX_FavoritesAvatarCardScale',
        spacingConfigKey: 'VRCX_FavoritesAvatarCardSpacing',
        min: 0.6,
        max: 1,
        step: 0.01,
        spacingMin: 0.5,
        spacingMax: 1.5,
        spacingStep: 0.05,
        basePaddingY: 8,
        basePaddingX: 10,
        baseContentGap: 10,
        baseActionGap: 8,
        baseActionGroupGap: 6,
        baseActionMargin: 8,
        baseCheckboxMargin: 10
    });

    const itemStyle = {
        padding: 'var(--favorites-card-padding-y, 8px) var(--favorites-card-padding-x, 10px)',
        gap: 'var(--favorites-card-content-gap, 10px)',
        minWidth: 'var(--favorites-card-min-width, 220px)',
        maxWidth: 'var(--favorites-card-target-width, 220px)',
        width: '100%',
        fontSize: 'calc(0.875rem * var(--favorites-card-scale, 1))'
    };

    const searchType = ref('all');
    const platformFilter = ref('all');
    const searchInput = ref('');

    // Frozen snapshot of the currently displayed search so pagination & retry ignore unsubmitted input edits.
    const activeQuery = ref('');
    const activeSearchType = ref('all');
    const activePlatform = ref('all');

    const loading = ref(false);
    const hasSearched = ref(false);
    const errorMessage = ref('');
    const canRetry = ref(false);
    const results = ref([]);

    // Track exact upstream page cursor per displayed page so Previous/Next stay deterministic under client filters.
    const pageCursorHistory = ref([0]);
    const pageIndex = ref(0);
    const hasMore = ref(false);
    const nextUpstreamCursor = ref(0);

    let activeAbort = null;

    const searchPlaceholder = computed(() => {
        if (searchType.value === 'id') return t('view.tools.avatar.placeholder_id');
        if (searchType.value === 'author') return t('view.tools.avatar.placeholder_author');
        if (searchType.value === 'name') return t('view.tools.avatar.placeholder_name');
        return t('view.tools.avatar.placeholder_all');
    });

    function goBack() {
        router.push({ name: 'tools' });
    }

    function getSmallThumbnail(avatar) {
        const rawUrl = avatar?.thumbnailImageUrl || avatar?.imageUrl || '';
        if (!rawUrl) return '';
        if (rawUrl.includes('vrchat.cloud')) {
            return rawUrl.replace('/256', '/128');
        }
        return rawUrl;
    }

    async function executeSearchPage(targetPageIndex, upstreamCursor) {
        const querySnapshot = activeQuery.value;
        if (!querySnapshot) return;

        activeAbort?.abort();
        const controller = new AbortController();
        activeAbort = controller;

        loading.value = true;
        hasSearched.value = true;
        errorMessage.value = '';
        canRetry.value = false;

        try {
            const res = await searchPublicAvatars({
                query: querySnapshot,
                searchType: activeSearchType.value,
                platform: activePlatform.value,
                upstreamPage: upstreamCursor,
                pageSize: 40,
                signal: controller.signal
            });
            if (activeAbort !== controller) return;

            if (res.invalidAvatarId) {
                results.value = [];
                hasMore.value = false;
                errorMessage.value = t('view.tools.avatar.invalid_id_hint');
                return;
            }
            if (res.privateNotice) {
                results.value = [];
                hasMore.value = false;
                errorMessage.value = t('view.tools.avatar.private_not_public');
                return;
            }

            results.value = res.avatars;
            pageIndex.value = targetPageIndex;
            hasMore.value = res.hasMore;
            nextUpstreamCursor.value = res.nextUpstreamPage;
        } catch (err) {
            if (err?.name === 'AbortError' || activeAbort !== controller) return;
            results.value = [];
            hasMore.value = false;
            canRetry.value = true;
            errorMessage.value = t('view.tools.avatar.search_failed', {
                error: err?.message || String(err)
            });
        } finally {
            if (activeAbort === controller) {
                loading.value = false;
                activeAbort = null;
            }
        }
    }

    function runNewSearch() {
        const trimmed = searchInput.value.trim();
        if (!trimmed) return;
        activeQuery.value = trimmed;
        activeSearchType.value = searchType.value;
        activePlatform.value = platformFilter.value;
        pageCursorHistory.value = [0];
        pageIndex.value = 0;
        hasMore.value = false;
        nextUpstreamCursor.value = 0;
        executeSearchPage(0, 0);
    }

    function retryCurrentPage() {
        if (!activeQuery.value) return;
        const cursor = pageCursorHistory.value[pageIndex.value] ?? 0;
        executeSearchPage(pageIndex.value, cursor);
    }

    function goNextPage() {
        if (loading.value || !hasMore.value || !activeQuery.value) return;
        const nextIdx = pageIndex.value + 1;
        const nextCursor = nextUpstreamCursor.value;
        pageCursorHistory.value[nextIdx] = nextCursor;
        executeSearchPage(nextIdx, nextCursor);
    }

    function goPrevPage() {
        if (loading.value || pageIndex.value <= 0 || !activeQuery.value) return;
        const prevIdx = pageIndex.value - 1;
        const prevCursor = pageCursorHistory.value[prevIdx] ?? 0;
        executeSearchPage(prevIdx, prevCursor);
    }

    function clearSearch() {
        activeAbort?.abort();
        activeAbort = null;
        searchInput.value = '';
        activeQuery.value = '';
        results.value = [];
        hasSearched.value = false;
        errorMessage.value = '';
        canRetry.value = false;
        loading.value = false;
        pageCursorHistory.value = [0];
        pageIndex.value = 0;
        hasMore.value = false;
        nextUpstreamCursor.value = 0;
    }

    function searchByAuthor(avatar) {
        const target = avatar?.authorId || avatar?.authorName || '';
        if (!target) return;
        searchType.value = 'author';
        searchInput.value = target;
        runNewSearch();
    }

    function openAvatarDetail(avatar) {
        if (!avatar?.id) return;
        showAvatarDialog(avatar.id);
    }

    function handleSelectAvatar(avatar) {
        if (!avatar?.id) return;
        selectAvatarWithConfirmation(avatar.id);
    }

    async function handleOpenFavoriteDialog(avatar) {
        if (!avatar?.id) return;
        if (!avatarStore.cachedAvatars.has(avatar.id)) {
            try {
                const res = await avatarRequest.getAvatar({ avatarId: avatar.id });
                const official = res?.json;
                if (!official || (official.releaseStatus !== 'public' && official.authorId !== currentUser.value?.id)) {
                    toast.error(t('message.api_handler.avatar_private_or_deleted'));
                    return;
                }
                applyAvatar(official);
            } catch {
                toast.error(t('message.api_handler.avatar_private_or_deleted'));
                return;
            }
        }
        showFavoriteDialog('avatar', avatar.id);
    }

    function handleFilterChange() {
        if (hasSearched.value && (searchInput.value.trim() || activeQuery.value)) {
            if (!searchInput.value.trim() && activeQuery.value) {
                searchInput.value = activeQuery.value;
            }
            runNewSearch();
        }
    }

    onActivated(() => {
        reloadCardScalingPreferences();
    });

    onBeforeUnmount(() => {
        activeAbort?.abort();
    });
</script>

<style scoped>
    .avatar-search-card-list {
        display: grid;
        grid-template-columns: repeat(
            var(--favorites-grid-columns, 1),
            minmax(var(--favorites-card-min-width, 260px), var(--favorites-card-target-width, 1fr))
        );
        gap: var(--favorites-card-gap, 12px);
        justify-content: start;
        padding: 4px 2px 12px 2px;
    }

    .favorites-item :deep(img) {
        filter: saturate(0.8) contrast(0.8);
        transition: filter 0.2s ease;
    }

    .favorites-item:hover :deep(img) {
        filter: saturate(1) contrast(1);
    }
</style>
