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

        <!-- Results / States -->
        <div class="flex-1 overflow-y-auto min-h-0 pr-0.5">
            <!-- Initial Empty Guide -->
            <div
                v-if="!hasSearched && !loading"
                class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/30 px-6 py-14 text-center space-y-2.5">
                <Search class="size-8 text-muted-foreground/70" />
                <div class="text-sm font-medium text-foreground">
                    {{ t('view.tools.avatar.empty_guide_title') }}
                </div>
                <p class="max-w-lg text-xs text-muted-foreground leading-relaxed">
                    {{ t('view.tools.avatar.empty_guide_desc') }}
                </p>
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

            <!-- Public Avatar Cards Grid -->
            <template v-else-if="results.length > 0">
                <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2 px-0.5 text-xs text-muted-foreground">
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

                <ItemGroup
                    class="grid gap-3 pb-3"
                    style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
                    <Item
                        v-for="avatar in results"
                        :key="avatar.id"
                        variant="outline"
                        size="sm"
                        class="p-0 overflow-hidden cursor-pointer x-hover-card hover:bg-accent/40 hover:shadow-sm transition-colors"
                        as-child>
                        <div class="flex flex-col h-full overflow-hidden rounded-[inherit]" @click="openAvatarDetail(avatar)">
                            <ItemHeader class="relative aspect-4/3 w-full overflow-hidden bg-muted">
                                <img
                                    v-if="(avatar.thumbnailImageUrl || avatar.imageUrl) && !brokenImages.has(avatar.id)"
                                    :src="avatar.thumbnailImageUrl || avatar.imageUrl"
                                    :alt="avatar.name"
                                    loading="lazy"
                                    decoding="async"
                                    class="size-full object-cover transition-transform duration-200 hover:scale-[1.02]"
                                    @error="markImageBroken(avatar.id)" />
                                <div v-else class="flex size-full items-center justify-center bg-muted">
                                    <Image class="size-8 text-muted-foreground/70" />
                                </div>
                                <div class="pointer-events-none absolute top-2 right-2 flex items-center gap-1">
                                    <Badge
                                        variant="secondary"
                                        class="border-transparent bg-black/60 text-[10px] text-white backdrop-blur-xs">
                                        {{ t('dialog.avatar.tags.public') }}
                                    </Badge>
                                    <Badge
                                        v-if="avatar.performance?.hasImpostor"
                                        variant="secondary"
                                        class="border-transparent bg-black/60 text-[10px] text-white backdrop-blur-xs">
                                        {{ t('dialog.avatar.tags.impostor') }}
                                    </Badge>
                                </div>
                            </ItemHeader>

                            <ItemContent class="flex flex-1 flex-col gap-1.5 p-3 min-w-0">
                                <TooltipWrapper side="top" :content="avatar.name">
                                    <ItemTitle class="truncate w-full text-sm font-semibold text-foreground">
                                        {{ avatar.name }}
                                    </ItemTitle>
                                </TooltipWrapper>

                                <div class="flex items-center justify-between gap-1.5 text-xs text-muted-foreground min-w-0">
                                    <button
                                        v-if="avatar.authorId"
                                        type="button"
                                        class="truncate text-left font-mono hover:text-foreground hover:underline"
                                        :title="avatar.authorName || avatar.authorId"
                                        @click.stop="showUserDialog(avatar.authorId)">
                                        {{ avatar.authorName || avatar.authorId }}
                                    </button>
                                    <span v-else class="truncate font-mono">
                                        {{ avatar.authorName || '-' }}
                                    </span>

                                    <TooltipWrapper
                                        v-if="avatar.authorName || avatar.authorId"
                                        side="top"
                                        :content="t('view.tools.avatar.filter_by_author_tooltip')">
                                        <button
                                            type="button"
                                            class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                            :aria-label="t('view.tools.avatar.filter_by_author_tooltip')"
                                            @click.stop="searchByAuthor(avatar)">
                                            <UserSearch class="size-3.5" />
                                        </button>
                                    </TooltipWrapper>
                                </div>

                                <!-- Platform & Performance Badges -->
                                <div v-if="avatar.compatibility?.length" class="flex flex-wrap items-center gap-1 pt-0.5">
                                    <Badge
                                        v-if="avatar.compatibility.includes('pc')"
                                        variant="outline"
                                        class="h-5 gap-1 px-1.5 text-[10px] text-platform-pc border-platform-pc!">
                                        <Monitor class="size-3 text-platform-pc" />
                                        <span v-if="avatar.performance?.pcRating">
                                            {{ formatPerformanceRating(avatar.performance.pcRating) }}
                                        </span>
                                    </Badge>
                                    <Badge
                                        v-if="avatar.compatibility.includes('android')"
                                        variant="outline"
                                        class="h-5 gap-1 px-1.5 text-[10px] text-platform-quest border-platform-quest!">
                                        <Smartphone class="size-3 text-platform-quest" />
                                        <span v-if="avatar.performance?.androidRating">
                                            {{ formatPerformanceRating(avatar.performance.androidRating) }}
                                        </span>
                                    </Badge>
                                    <Badge
                                        v-if="avatar.compatibility.includes('ios')"
                                        variant="outline"
                                        class="h-5 gap-1 px-1.5 text-[10px] text-platform-ios border-platform-ios">
                                        <Apple class="size-3 text-platform-ios" />
                                        <span v-if="avatar.performance?.iosRating">
                                            {{ formatPerformanceRating(avatar.performance.iosRating) }}
                                        </span>
                                    </Badge>
                                </div>

                                <ItemDescription
                                    v-if="avatar.description"
                                    class="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground pt-0.5">
                                    {{ avatar.description }}
                                </ItemDescription>
                            </ItemContent>
                        </div>
                    </Item>
                </ItemGroup>
            </template>

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
        Search,
        Smartphone,
        UserSearch,
        X
    } from 'lucide-vue-next';
    import { computed, onBeforeUnmount, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { useRouter } from 'vue-router';

    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import { DataTableEmpty } from '@/components/ui/data-table';
    import { Item, ItemContent, ItemDescription, ItemGroup, ItemHeader, ItemTitle } from '@/components/ui/item';
    import { Spinner } from '@/components/ui/spinner';
    import { TooltipWrapper } from '@/components/ui/tooltip';
    import { applyAvatar, showAvatarDialog } from '@/coordinators/avatarCoordinator';
    import { showUserDialog } from '@/coordinators/userCoordinator';
    import { searchPublicAvatars } from '@/ipc-web/publicAvatarSearch';
    import { useAvatarStore } from '@/stores';

    const { t, te } = useI18n();
    const router = useRouter();
    const avatarStore = useAvatarStore();

    const searchType = ref('all');
    const platformFilter = ref('all');
    const searchInput = ref('');

    const loading = ref(false);
    const hasSearched = ref(false);
    const errorMessage = ref('');
    const canRetry = ref(false);
    const results = ref([]);
    const brokenImages = ref(new Set());

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

    function markImageBroken(avatarId) {
        const next = new Set(brokenImages.value);
        next.add(avatarId);
        brokenImages.value = next;
    }

    function formatPerformanceRating(rating) {
        if (!rating) return '';
        const key = `dialog.avatar.tags.performanceRating.${String(rating).replace(/\s+/g, '')}`;
        return te(key) ? t(key) : rating;
    }

    async function executeSearchPage(targetPageIndex, upstreamCursor) {
        const trimmed = searchInput.value.trim();
        if (!trimmed) return;

        activeAbort?.abort();
        const controller = new AbortController();
        activeAbort = controller;

        loading.value = true;
        hasSearched.value = true;
        errorMessage.value = '';
        canRetry.value = false;

        try {
            const res = await searchPublicAvatars({
                query: trimmed,
                searchType: searchType.value,
                platform: platformFilter.value,
                upstreamPage: upstreamCursor,
                pageSize: 24,
                signal: controller.signal
            });
            if (activeAbort !== controller) return;

            brokenImages.value = new Set();
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
        if (!searchInput.value.trim()) return;
        pageCursorHistory.value = [0];
        pageIndex.value = 0;
        hasMore.value = false;
        nextUpstreamCursor.value = 0;
        executeSearchPage(0, 0);
    }

    function retryCurrentPage() {
        const cursor = pageCursorHistory.value[pageIndex.value] ?? 0;
        executeSearchPage(pageIndex.value, cursor);
    }

    function goNextPage() {
        if (loading.value || !hasMore.value) return;
        const nextIdx = pageIndex.value + 1;
        const nextCursor = nextUpstreamCursor.value;
        pageCursorHistory.value[nextIdx] = nextCursor;
        executeSearchPage(nextIdx, nextCursor);
    }

    function goPrevPage() {
        if (loading.value || pageIndex.value <= 0) return;
        const prevIdx = pageIndex.value - 1;
        const prevCursor = pageCursorHistory.value[prevIdx] ?? 0;
        executeSearchPage(prevIdx, prevCursor);
    }

    function clearSearch() {
        activeAbort?.abort();
        activeAbort = null;
        searchInput.value = '';
        results.value = [];
        hasSearched.value = false;
        errorMessage.value = '';
        canRetry.value = false;
        loading.value = false;
        pageCursorHistory.value = [0];
        pageIndex.value = 0;
        hasMore.value = false;
        nextUpstreamCursor.value = 0;
        brokenImages.value = new Set();
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
        if (!avatarStore.cachedAvatars.has(avatar.id)) {
            applyAvatar({
                id: avatar.id,
                name: avatar.name,
                authorId: avatar.authorId,
                authorName: avatar.authorName,
                description: avatar.description,
                imageUrl: avatar.imageUrl || avatar.thumbnailImageUrl,
                thumbnailImageUrl: avatar.thumbnailImageUrl || avatar.imageUrl,
                releaseStatus: 'public',
                styles: avatar.styles,
                tags: avatar.tags,
                created_at: avatar.created_at,
                updated_at: avatar.updated_at
            });
        }
        showAvatarDialog(avatar.id);
    }

    function handleFilterChange() {
        if (hasSearched.value && searchInput.value.trim()) {
            runNewSearch();
        }
    }

    onBeforeUnmount(() => {
        activeAbort?.abort();
    });
</script>
