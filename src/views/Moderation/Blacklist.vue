<template>
    <div class="x-container x-container--auto-height">
        <div class="mb-4 flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2">
                <span class="header">{{ t('view.blacklist.header') }}</span>
                <Badge variant="secondary" class="text-xs font-normal tabular-nums">
                    {{ blockedEntries.length }}
                </Badge>
            </div>

            <div class="flex items-center gap-2 flex-wrap">
                <InputGroupField
                    v-model="searchQuery"
                    :placeholder="t('view.blacklist.search_placeholder')"
                    class="w-[210px]" />

                <Button
                    size="sm"
                    variant="outline"
                    :disabled="playerModerationTable.loading"
                    @click="openAddBlockDialog">
                    <UserX class="h-4 w-4" />
                    <span>{{ t('view.blacklist.add_block') }}</span>
                </Button>

                <TooltipWrapper side="bottom" :content="t('view.blacklist.clear_all')">
                    <Button
                        class="rounded-full"
                        variant="ghost"
                        size="icon-sm"
                        :disabled="playerModerationTable.loading || blockedEntries.length === 0 || clearingAll"
                        :aria-label="t('view.blacklist.clear_all')"
                        @click="clearAllBlocks">
                        <Spinner v-if="clearingAll" />
                        <Trash2 v-else class="h-4 w-4" />
                    </Button>
                </TooltipWrapper>

                <TooltipWrapper side="bottom" :content="t('view.blacklist.refresh_tooltip')">
                    <Button
                        class="rounded-full"
                        variant="ghost"
                        size="icon-sm"
                        :disabled="playerModerationTable.loading"
                        :aria-label="t('view.blacklist.refresh_tooltip')"
                        @click="refreshPlayerModerations()">
                        <Spinner v-if="playerModerationTable.loading" />
                        <RefreshCw v-else class="h-4 w-4" />
                    </Button>
                </TooltipWrapper>
            </div>
        </div>

        <DataTableLayout
            :table="table"
            :loading="playerModerationTable.loading"
            auto-height
            :page-sizes="pageSizes"
            :total-items="totalItems"
            :on-page-size-change="handlePageSizeChange" />

        <Dialog :open="addDialogOpen" @update:open="addDialogOpen = $event">
            <DialogContent class="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{{ t('view.blacklist.add_dialog_title') }}</DialogTitle>
                </DialogHeader>
                <div class="py-2">
                    <InputGroupField
                        v-model="blockUserInput"
                        :placeholder="t('view.blacklist.add_input_placeholder')"
                        @keyup.enter="submitAddBlock" />
                </div>
                <DialogFooter>
                    <Button variant="secondary" size="sm" :disabled="submittingBlock" @click="addDialogOpen = false">
                        {{ t('view.blacklist.cancel') }}
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        :disabled="submittingBlock || !blockUserInput.trim()"
                        @click="submitAddBlock">
                        <Spinner v-if="submittingBlock" class="h-3.5 w-3.5" />
                        <span>{{ t('view.blacklist.confirm_block') }}</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>

<script setup>
    import { ArrowUpDown, Copy, RefreshCw, ShieldOff, Trash2, UserX } from 'lucide-vue-next';
    import { computed, h, onActivated, onMounted, ref } from 'vue';
    import { storeToRefs } from 'pinia';
    import { toast } from 'vue-sonner';
    import { useI18n } from 'vue-i18n';

    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import { DataTableLayout } from '@/components/ui/data-table';
    import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
    import { InputGroupField } from '@/components/ui/input-group';
    import { Spinner } from '@/components/ui/spinner';
    import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
    import { playerModerationRequest } from '../../api';
    import { runRefreshPlayerModerationsFlow as refreshPlayerModerations } from '../../coordinators/moderationCoordinator';
    import { showUserDialog } from '../../coordinators/userCoordinator';
    import { useVrcxVueTable } from '../../lib/table/useVrcxVueTable';
    import { copyToClipboard, formatDateFilter } from '../../shared/utils';
    import {
        useAppearanceSettingsStore,
        useModalStore,
        useModerationStore,
        useUiStore,
        useUserStore
    } from '../../stores';

    const USER_ID_PATTERN = /usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    const { t } = useI18n();
    const moderationStore = useModerationStore();
    const { playerModerationTable } = storeToRefs(moderationStore);
    const { applyPlayerModeration, handlePlayerModerationDelete } = moderationStore;
    const appearanceSettingsStore = useAppearanceSettingsStore();
    const modalStore = useModalStore();
    const { shiftHeld } = storeToRefs(useUiStore());
    const { currentUser } = storeToRefs(useUserStore());

    const searchQuery = ref('');
    const addDialogOpen = ref(false);
    const blockUserInput = ref('');
    const submittingBlock = ref(false);
    const clearingAll = ref(false);

    function extractUserId(raw) {
        const text = String(raw || '').trim();
        if (!text) return '';
        const match = USER_ID_PATTERN.exec(text);
        return match ? match[0] : '';
    }

    const blockedEntries = computed(() => {
        const selfId = currentUser.value?.id || '';
        return (playerModerationTable.value.data || []).filter((row) => {
            if (String(row?.type || '').toLowerCase() !== 'block') return false;
            if (selfId && row.sourceUserId && row.sourceUserId !== selfId) return false;
            return true;
        });
    });

    const filteredBlockedEntries = computed(() => {
        const needle = searchQuery.value.trim().toLowerCase();
        if (!needle) return blockedEntries.value;
        return blockedEntries.value.filter((row) => {
            const name = String(row.targetDisplayName || '').toLowerCase();
            const uid = String(row.targetUserId || '').toLowerCase();
            return name.includes(needle) || uid.includes(needle);
        });
    });

    function openAddBlockDialog() {
        blockUserInput.value = '';
        addDialogOpen.value = true;
    }

    async function submitAddBlock() {
        const userId = extractUserId(blockUserInput.value);
        if (!userId) {
            toast.warning(t('view.blacklist.invalid_user_id'));
            return;
        }
        if (currentUser.value?.id && userId === currentUser.value.id) {
            toast.warning(t('view.blacklist.cannot_block_self'));
            return;
        }
        submittingBlock.value = true;
        try {
            const args = await playerModerationRequest.sendPlayerModeration({
                moderated: userId,
                type: 'block'
            });
            if (args?.json) {
                applyPlayerModeration(args.json);
            } else {
                await refreshPlayerModerations();
            }
            addDialogOpen.value = false;
            blockUserInput.value = '';
            toast.success(t('view.blacklist.block_success'));
        } catch (err) {
            toast.error(err?.message || t('view.blacklist.action_failed'));
        } finally {
            submittingBlock.value = false;
        }
    }

    async function unblockUser(row) {
        if (!row?.targetUserId) return;
        try {
            const args = await playerModerationRequest.deletePlayerModeration({
                moderated: row.targetUserId,
                type: 'block'
            });
            handlePlayerModerationDelete(args);
            toast.success(t('view.blacklist.unblock_success'));
        } catch (err) {
            toast.error(err?.message || t('view.blacklist.action_failed'));
        }
    }

    function promptUnblockUser(row) {
        const displayName = row?.targetDisplayName || row?.targetUserId || '';
        modalStore
            .confirm({
                title: t('view.blacklist.unblock_confirm_title'),
                description: t('view.blacklist.unblock_confirm_description', { name: displayName }),
                confirmText: t('view.blacklist.unblock')
            })
            .then(({ ok }) => ok && unblockUser(row))
            .catch(() => {});
    }

    async function clearAllBlocks() {
        if (blockedEntries.value.length === 0) return;
        const { ok } = await modalStore.confirm({
            title: t('view.blacklist.clear_confirm_title'),
            description: t('view.blacklist.clear_confirm_description'),
            confirmText: t('view.blacklist.clear_all'),
            destructive: true
        });
        if (!ok) return;
        clearingAll.value = true;
        try {
            await playerModerationRequest.deletePlayerModerations({ type: 'block' });
            await refreshPlayerModerations();
            toast.success(t('view.blacklist.clear_success'));
        } catch (err) {
            toast.error(err?.message || t('view.blacklist.action_failed'));
        } finally {
            clearingAll.value = false;
        }
    }

    const columns = [
        {
            id: 'spacer',
            header: () => null,
            enableSorting: false,
            size: 16,
            minSize: 0,
            maxSize: 16,
            cell: () => null
        },
        {
            accessorKey: 'created',
            size: 140,
            meta: { label: () => t('view.blacklist.col_date') },
            header: ({ column }) =>
                h(
                    Button,
                    {
                        variant: 'ghost',
                        onClick: () => column.toggleSorting(column.getIsSorted() === 'asc')
                    },
                    () => [t('view.blacklist.col_date'), h(ArrowUpDown, { class: 'ml-1 h-4 w-4' })]
                ),
            cell: ({ row }) => {
                const createdAt = row.getValue('created');
                const shortText = formatDateFilter(createdAt, 'short');
                const longText = formatDateFilter(createdAt, 'long');
                return h(Tooltip, null, {
                    default: () => [
                        h(TooltipTrigger, { asChild: true }, () => h('span', shortText)),
                        h(TooltipContent, { side: 'right' }, () => h('span', longText))
                    ]
                });
            }
        },
        {
            accessorKey: 'targetDisplayName',
            size: 220,
            minSize: 120,
            meta: {
                stretch: true,
                label: () => t('view.blacklist.col_user')
            },
            header: () => t('view.blacklist.col_user'),
            cell: ({ row }) => {
                const original = row.original;
                return h(
                    'span',
                    {
                        class: 'cursor-pointer block w-full whitespace-normal wrap-break-word pr-2.5 hover:underline',
                        onClick: () => showUserDialog(original.targetUserId)
                    },
                    original.targetDisplayName || original.targetUserId
                );
            }
        },
        {
            accessorKey: 'targetUserId',
            size: 260,
            minSize: 140,
            meta: { label: () => t('view.blacklist.col_user_id') },
            header: () => t('view.blacklist.col_user_id'),
            cell: ({ row }) => {
                const uid = String(row.original?.targetUserId || '');
                return h('div', { class: 'inline-flex items-center gap-1 max-w-full' }, [
                    h('span', { class: 'font-mono text-xs text-muted-foreground truncate' }, uid),
                    uid
                        ? h(
                              'button',
                              {
                                  type: 'button',
                                  class: 'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground',
                                  title: t('dialog.user.info.copy_id'),
                                  'aria-label': t('dialog.user.info.copy_id'),
                                  onClick: (e) => {
                                      e.stopPropagation();
                                      copyToClipboard(uid, t('message.user.id_copied'));
                                  }
                              },
                              [h(Copy, { class: 'size-3' })]
                          )
                        : null
                ]);
            }
        },
        {
            id: 'action',
            size: 110,
            minSize: 100,
            maxSize: 120,
            enableSorting: false,
            meta: {
                class: 'text-right',
                label: () => t('view.blacklist.col_action')
            },
            header: () => t('view.blacklist.col_action'),
            cell: ({ row }) => {
                const original = row.original;
                return h('div', { class: 'flex justify-end' }, [
                    h(
                        Button,
                        {
                            variant: 'ghost',
                            size: 'sm',
                            class: 'h-7 px-2 text-xs text-muted-foreground hover:text-destructive',
                            onClick: () => (shiftHeld.value ? unblockUser(original) : promptUnblockUser(original))
                        },
                        () => [h(ShieldOff, { class: 'size-3.5' }), h('span', t('view.blacklist.unblock'))]
                    )
                ]);
            }
        },
        {
            id: 'trailing',
            header: () => null,
            enableSorting: false,
            enableResizing: false,
            size: 8,
            cell: () => null
        }
    ];

    const pageSizes = computed(() => appearanceSettingsStore.tablePageSizes);

    const { table, pagination } = useVrcxVueTable({
        persistKey: 'blacklist',
        get data() {
            return filteredBlockedEntries.value;
        },
        columns,
        getRowId: (row) => row.id ?? `block:${row.sourceUserId}:${row.targetUserId}:${row.created ?? ''}`,
        initialSorting: [{ id: 'created', desc: true }],
        initialPagination: {
            pageIndex: 0,
            pageSize: appearanceSettingsStore.tablePageSize
        }
    });

    const totalItems = computed(() => table.getFilteredRowModel().rows.length);

    function handlePageSizeChange(size) {
        pagination.value = {
            ...pagination.value,
            pageIndex: 0,
            pageSize: size
        };
    }

    function ensureLoaded() {
        if (playerModerationTable.value.data.length === 0 && !playerModerationTable.value.loading) {
            refreshPlayerModerations();
        }
    }

    onMounted(ensureLoaded);
    onActivated(ensureLoaded);
</script>
