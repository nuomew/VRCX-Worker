import { beforeEach, describe, expect, test, vi } from 'vitest';
import { reactive, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const friends = ref(new Map());
const allFavoriteFriendIds = ref(new Set());
const getAllUserStats = vi.fn().mockResolvedValue(undefined);
const getAllUserMutualCount = vi.fn().mockResolvedValue(undefined);
const getAllUserMutualOptedOut = vi.fn().mockResolvedValue(undefined);
const getAllUserProfiles = vi.fn().mockResolvedValue([]);
const routeState = reactive({ path: '/social/friend-list', name: 'friend-list' });

vi.mock('vue-router', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useRoute: () => routeState
    };
});

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

vi.mock('../../../services/database', () => ({
    database: {
        getAllUserProfiles: (...args) => getAllUserProfiles(...args)
    }
}));

vi.mock('../../../stores', () => ({
    useFriendStore: () => ({
        friends,
        allFavoriteFriendIds,
        getAllUserStats,
        getAllUserMutualCount,
        getAllUserMutualOptedOut
    }),
    useChartsStore: () => ({
        mutualGraphStatus: { isFetching: false },
        fetchMutualGraph: vi.fn()
    }),
    useUserStore: () => ({
        currentUser: { hasSharedConnectionsOptOut: false }
    }),
    useAppearanceSettingsStore: () => ({
        randomUserColours: ref(false),
        tablePageSizes: [10, 25, 50],
        tablePageSize: 25
    }),
    useModalStore: () => ({
        confirm: vi.fn(),
        alert: vi.fn()
    }),
    useSearchStore: () => ({
        stringComparer: ref({ compare: (a, b) => String(a).localeCompare(String(b)) }),
        friendsListSearch: ref('')
    })
}));

vi.mock('../../../api', () => ({
    friendRequest: { deleteFriend: vi.fn() },
    userRequest: { getUser: vi.fn(), getPublicProfile: vi.fn() }
}));

vi.mock('../../../coordinators/userCoordinator', () => ({
    showUserDialog: vi.fn()
}));

vi.mock('../../../coordinators/friendRelationshipCoordinator', () => ({
    confirmDeleteFriend: vi.fn(),
    handleFriendDelete: vi.fn()
}));

vi.mock('../../../composables/useUserDisplay', () => ({
    useUserDisplay: () => ({ userImage: () => '' })
}));

vi.mock('../columns.jsx', () => ({
    createColumns: () => [
        {
            id: 'friendNumber',
            accessorFn: (row) => row?.$friendNumber ?? 0,
            header: 'No',
            cell: ({ row }) => row.original?.displayName ?? ''
        }
    ]
}));

vi.mock('../../../components/ui/data-table', () => ({
    DataTableLayout: {
        name: 'DataTableLayout',
        props: ['table', 'loading', 'totalItems'],
        template:
            '<div data-test="friend-list-table" :data-loading="String(loading)" :data-total="String(totalItems)"></div>'
    }
}));

import FriendList from '../FriendList.vue';
import { watchState } from '../../../services/watchState';

describe('FriendList.vue reload hydration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        friends.value = new Map();
        routeState.path = '/social/friend-list';
        routeState.name = 'friend-list';
        watchState.isLoggedIn = true;
        watchState.isFriendsLoaded = false;
    });

    test('hydrates table rows automatically when watchState.isFriendsLoaded flips true after placeholder entries', async () => {
        // Simulate page reload on #/social/friend-list:
        // 1. refreshFriendsStatus populates placeholder ctx entries (ctx.ref === undefined), fixing friends.size.
        const map = new Map();
        map.set('usr_1', { id: 'usr_1', state: 'online', ref: undefined });
        map.set('usr_2', { id: 'usr_2', state: 'offline', ref: undefined });
        friends.value = map;

        const wrapper = mount(FriendList, {
            global: {
                stubs: {
                    Dialog: true
                }
            }
        });
        await flushPromises();

        const tableEl = wrapper.find('[data-test="friend-list-table"]');
        expect(tableEl.attributes('data-loading')).toBe('true');
        expect(tableEl.attributes('data-total')).toBe('0');

        // 2. refreshFriends finishes populating ctx.ref (friends.size unchanged) and sets isFriendsLoaded = true.
        map.get('usr_1').ref = { id: 'usr_1', displayName: 'Alice', $friendNumber: 1 };
        map.get('usr_2').ref = { id: 'usr_2', displayName: 'Bob', $friendNumber: 2 };
        watchState.isFriendsLoaded = true;
        await flushPromises();

        expect(tableEl.attributes('data-loading')).toBe('false');
        expect(tableEl.attributes('data-total')).toBe('2');
        expect(getAllUserStats).toHaveBeenCalledTimes(1);
    });
});
