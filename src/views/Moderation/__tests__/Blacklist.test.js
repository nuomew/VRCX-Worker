import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
    sendPlayerModeration: vi.fn(),
    deletePlayerModeration: vi.fn(),
    deletePlayerModerations: vi.fn(),
    refreshPlayerModerations: vi.fn(),
    showUserDialog: vi.fn(),
    confirm: vi.fn(),
    applyPlayerModeration: vi.fn(),
    handlePlayerModerationDelete: vi.fn(),
    toastSuccess: vi.fn(),
    toastWarning: vi.fn(),
    toastError: vi.fn()
}));

const playerModerationTable = ref({
    data: [],
    loading: false,
    filters: []
});
const currentUser = ref({ id: 'usr_me000000-0000-0000-0000-000000000001' });
const shiftHeld = ref(false);

vi.mock('vue-i18n', () => ({
    useI18n: () => ({ t: (key) => key })
}));

vi.mock('pinia', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        storeToRefs: (store) => store
    };
});

vi.mock('vue-sonner', () => ({
    toast: {
        success: (...args) => mocks.toastSuccess(...args),
        warning: (...args) => mocks.toastWarning(...args),
        error: (...args) => mocks.toastError(...args)
    }
}));

vi.mock('../../../api', () => ({
    playerModerationRequest: {
        sendPlayerModeration: (...args) => mocks.sendPlayerModeration(...args),
        deletePlayerModeration: (...args) => mocks.deletePlayerModeration(...args),
        deletePlayerModerations: (...args) => mocks.deletePlayerModerations(...args)
    }
}));

vi.mock('../../../coordinators/moderationCoordinator', () => ({
    runRefreshPlayerModerationsFlow: (...args) => mocks.refreshPlayerModerations(...args)
}));

vi.mock('../../../coordinators/userCoordinator', () => ({
    showUserDialog: (...args) => mocks.showUserDialog(...args)
}));

vi.mock('../../../stores', () => ({
    useModerationStore: () => ({
        playerModerationTable,
        applyPlayerModeration: (...args) => mocks.applyPlayerModeration(...args),
        handlePlayerModerationDelete: (...args) => mocks.handlePlayerModerationDelete(...args)
    }),
    useAppearanceSettingsStore: () => ({
        tablePageSize: 20,
        tablePageSizes: [10, 20, 50]
    }),
    useModalStore: () => ({
        confirm: (...args) => mocks.confirm(...args)
    }),
    useUiStore: () => ({
        shiftHeld
    }),
    useUserStore: () => ({
        currentUser
    })
}));

vi.mock('@/components/ui/dialog', () => ({
    Dialog: {
        name: 'Dialog',
        props: ['open'],
        emits: ['update:open'],
        template: '<div v-if="open" class="mock-blacklist-dialog"><slot /></div>'
    },
    DialogContent: { template: '<div><slot /></div>' },
    DialogHeader: { template: '<div><slot /></div>' },
    DialogTitle: { template: '<h3><slot /></h3>' },
    DialogFooter: { template: '<div><slot /></div>' }
}));

vi.mock('@/components/ui/tooltip', () => ({
    Tooltip: { template: '<span><slot /></span>' },
    TooltipTrigger: { template: '<span><slot /></span>' },
    TooltipContent: { template: '<span><slot /></span>' }
}));

vi.mock('@/components/ui/data-table', async () => {
    const { h } = await import('vue');
    return {
        DataTableLayout: {
            name: 'DataTableLayout',
            props: ['table', 'totalItems'],
            render() {
                const rows = this.table.getRowModel().rows;
                return h(
                    'div',
                    { class: 'mock-table', 'data-total': this.totalItems },
                    rows.map((row) =>
                        h(
                            'div',
                            { key: row.id, class: 'mock-row', 'data-uid': row.original.targetUserId },
                            row.getVisibleCells().map((cell) => {
                                const def = cell.column.columnDef.cell;
                                return h(
                                    'div',
                                    { key: cell.id, 'data-col': cell.column.id },
                                    typeof def === 'function' ? [def({ row })] : []
                                );
                            })
                        )
                    )
                );
            }
        }
    };
});

import Blacklist from '../Blacklist.vue';

describe('Blacklist.vue', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shiftHeld.value = false;
        mocks.confirm.mockResolvedValue({ ok: true });
        playerModerationTable.value = {
            loading: false,
            filters: [],
            data: [
                {
                    id: 'pm_1',
                    type: 'block',
                    sourceUserId: currentUser.value.id,
                    sourceDisplayName: 'Me',
                    targetUserId: 'usr_11111111-1111-1111-1111-111111111111',
                    targetDisplayName: 'BlockedPlayerA',
                    created: '2026-11-26T10:00:00.000Z'
                },
                {
                    id: 'pm_2',
                    type: 'mute',
                    sourceUserId: currentUser.value.id,
                    sourceDisplayName: 'Me',
                    targetUserId: 'usr_22222222-2222-2222-2222-222222222222',
                    targetDisplayName: 'MutedOnlyPlayer',
                    created: '2026-11-26T10:05:00.000Z'
                },
                {
                    id: 'pm_3',
                    type: 'block',
                    sourceUserId: 'usr_99999999-9999-9999-9999-999999999999',
                    sourceDisplayName: 'OtherUser',
                    targetUserId: currentUser.value.id,
                    targetDisplayName: 'Me',
                    created: '2026-11-26T10:10:00.000Z'
                }
            ]
        };
    });

    test('shows only users blocked by currentUser, supports search, opens UserDialog, adds block via URL, and unblocks', async () => {
        const wrapper = mount(Blacklist, {
            global: {
                stubs: {
                    TooltipWrapper: { template: '<div><slot /></div>' }
                }
            }
        });
        await flushPromises();

        // Only self-initiated block rows appear (excludes mute and incoming blocks from other users)
        expect(wrapper.findAll('.mock-row')).toHaveLength(1);
        expect(wrapper.text()).toContain('BlockedPlayerA');
        expect(wrapper.text()).not.toContain('MutedOnlyPlayer');
        expect(wrapper.text()).not.toContain('OtherUser');

        // Clicking username opens UserDialog
        await wrapper.find('[data-col="targetDisplayName"] span').trigger('click');
        expect(mocks.showUserDialog).toHaveBeenCalledWith('usr_11111111-1111-1111-1111-111111111111');

        // Unblocking prompts confirm and calls deletePlayerModeration + handlePlayerModerationDelete
        const unblockArgs = {
            json: { success: true },
            params: { moderated: 'usr_11111111-1111-1111-1111-111111111111', type: 'block' }
        };
        mocks.deletePlayerModeration.mockResolvedValueOnce(unblockArgs);
        await wrapper.find('[data-col="action"] button').trigger('click');
        await flushPromises();
        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        expect(mocks.deletePlayerModeration).toHaveBeenCalledWith({
            moderated: 'usr_11111111-1111-1111-1111-111111111111',
            type: 'block'
        });
        expect(mocks.handlePlayerModerationDelete).toHaveBeenCalledWith(unblockArgs);

        // Adding a block accepts full VRChat user profile URL
        const targetId = 'usr_33333333-3333-3333-3333-333333333333';
        mocks.sendPlayerModeration.mockResolvedValueOnce({
            json: {
                id: 'pm_new',
                type: 'block',
                sourceUserId: currentUser.value.id,
                targetUserId: targetId,
                targetDisplayName: 'NewBlocked',
                created: '2026-11-26T11:00:00.000Z'
            }
        });
        const addBtn = wrapper.findAll('button').find((b) => b.text().includes('view.blacklist.add_block'));
        expect(addBtn).toBeTruthy();
        await addBtn.trigger('click');
        await flushPromises();

        const dialogInput = wrapper.find('.mock-blacklist-dialog input');
        await dialogInput.setValue(`https://vrchat.com/home/user/${targetId}`);
        const confirmBtn = wrapper
            .find('.mock-blacklist-dialog')
            .findAll('button')
            .find((b) => b.text().includes('view.blacklist.confirm_block'));
        await confirmBtn.trigger('click');
        await flushPromises();

        expect(mocks.sendPlayerModeration).toHaveBeenCalledWith({
            moderated: targetId,
            type: 'block'
        });
        expect(mocks.applyPlayerModeration).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'pm_new', targetUserId: targetId })
        );

        wrapper.unmount();
    });
});
