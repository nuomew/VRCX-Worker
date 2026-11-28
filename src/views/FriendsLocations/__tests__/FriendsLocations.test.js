import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
    makeRef: (value) => ({ value, __v_isRef: true }),
    onlineFriends: null,
    allFavoriteOnlineFriends: null,
    allFavoriteFriendIds: null,
    activeFriends: null,
    offlineFriends: null,
    friendsInSameInstance: null,
    isSidebarDivideByFriendGroup: null,
    sidebarFavoriteGroups: null,
    sidebarFavoriteGroupOrder: null,
    sidebarSortMethods: null,
    favoriteFriendGroups: null,
    groupedByGroupKeyFavoriteFriends: null,
    localFriendFavorites: null,
    lastLocation: null,
    configGetString: vi.fn(),
    configGetBool: vi.fn(),
    configSetString: vi.fn(),
    configSetBool: vi.fn(),
    virtualMeasure: vi.fn()
}));

mocks.onlineFriends = mocks.makeRef([]);
mocks.allFavoriteOnlineFriends = mocks.makeRef([]);
mocks.allFavoriteFriendIds = mocks.makeRef(new Set());
mocks.activeFriends = mocks.makeRef([]);
mocks.offlineFriends = mocks.makeRef([]);
mocks.friendsInSameInstance = mocks.makeRef([]);
mocks.isSidebarDivideByFriendGroup = mocks.makeRef(false);
mocks.sidebarFavoriteGroups = mocks.makeRef([]);
mocks.sidebarFavoriteGroupOrder = mocks.makeRef([]);
mocks.sidebarSortMethods = mocks.makeRef('status');
mocks.favoriteFriendGroups = mocks.makeRef([]);
mocks.groupedByGroupKeyFavoriteFriends = mocks.makeRef({});
mocks.localFriendFavorites = mocks.makeRef({});
mocks.lastLocation = mocks.makeRef({
    location: 'wrld_home:123',
    friendList: new Map()
});

vi.mock('pinia', () => ({
    storeToRefs: (store) => store
}));

vi.mock('vue-i18n', () => ({
    useI18n: () => ({
        t: (key) => key,
        locale: require('vue').ref('en')
    })
}));

vi.mock('../../../stores', () => ({
    useFriendStore: () => ({
        onlineFriends: mocks.onlineFriends,
        allFavoriteOnlineFriends: mocks.allFavoriteOnlineFriends,
        allFavoriteFriendIds: mocks.allFavoriteFriendIds,
        activeFriends: mocks.activeFriends,
        offlineFriends: mocks.offlineFriends,
        friendsInSameInstance: mocks.friendsInSameInstance
    }),
    useAppearanceSettingsStore: () => ({
        isSidebarDivideByFriendGroup: mocks.isSidebarDivideByFriendGroup,
        sidebarFavoriteGroups: mocks.sidebarFavoriteGroups,
        sidebarFavoriteGroupOrder: mocks.sidebarFavoriteGroupOrder,
        sidebarSortMethods: mocks.sidebarSortMethods
    }),
    useFavoriteStore: () => ({
        favoriteFriendGroups: mocks.favoriteFriendGroups,
        groupedByGroupKeyFavoriteFriends: mocks.groupedByGroupKeyFavoriteFriends,
        localFriendFavorites: mocks.localFriendFavorites
    }),
    useLocationStore: () => ({
        lastLocation: mocks.lastLocation
    })
}));

vi.mock('../../../services/config.js', () => ({
    default: {
        getString: (...args) => mocks.configGetString(...args),
        getBool: (...args) => mocks.configGetBool(...args),
        setString: (...args) => mocks.configSetString(...args),
        setBool: (...args) => mocks.configSetBool(...args)
    }
}));

vi.mock('../../../shared/utils/location.js', () => ({
    getFriendsLocations: (friends) => friends?.[0]?.ref?.location ?? ''
}));

vi.mock('../../../shared/utils', () => ({
    debounce: (fn, delay) => {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    },
    getFriendsSortFunction: () => (a, b) => String(a?.displayName ?? '').localeCompare(String(b?.displayName ?? ''))
}));

vi.mock('@tanstack/vue-virtual', () => ({
    useVirtualizer: (optionsRef) => ({
        value: {
            getVirtualItems: () =>
                Array.from({ length: optionsRef.value.count }, (_, index) => ({
                    index,
                    key: index,
                    start: index * 64
                })),
            getTotalSize: () => optionsRef.value.count * 64,
            measure: (...args) => mocks.virtualMeasure(...args),
            measureElement: vi.fn()
        }
    })
}));

vi.mock('lucide-vue-next', () => ({
    ChevronDown: { template: '<span />' },
    Loader2: { template: '<span />' },
    Settings: { template: '<span />' }
}));

vi.mock('@/components/ui/field', () => ({
    Field: { template: '<div><slot /></div>' },
    FieldContent: { template: '<div><slot /></div>' },
    FieldLabel: { template: '<div><slot /></div>' }
}));

vi.mock('@/components/ui/tabs', () => ({
    Tabs: {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template:
            '<div data-testid="tabs">' +
            '<button data-testid="segment-online" @click="$emit(\'update:modelValue\', \'online\')">online</button>' +
            '<button data-testid="segment-offline" @click="$emit(\'update:modelValue\', \'offline\')">offline</button>' +
            '<slot />' +
            '</div>'
    },
    TabsList: { template: '<div><slot /></div>' },
    TabsTrigger: {
        props: ['value'],
        template: '<button :data-value="value"><slot /></button>'
    }
}));

vi.mock('@/components/ui/button', () => ({
    Button: {
        emits: ['click'],
        template: '<button @click="$emit(\'click\')"><slot /></button>'
    }
}));

vi.mock('@/components/ui/data-table', () => ({
    DataTableEmpty: {
        props: ['type'],
        template: '<div data-testid="empty-state">{{ type }}</div>'
    }
}));

vi.mock('@/components/ui/input-group', () => ({
    InputGroupSearch: {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template:
            '<input data-testid="friend-locations-search" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
    }
}));

vi.mock('../../../components/ui/popover', () => ({
    Popover: { template: '<div><slot /></div>' },
    PopoverContent: { template: '<div><slot /></div>' },
    PopoverTrigger: { template: '<div><slot /></div>' }
}));

vi.mock('../../../components/ui/slider', () => ({
    Slider: {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template: '<button data-testid="set-scale" @click="$emit(\'update:modelValue\', [0.8])">set-scale</button>'
    }
}));

vi.mock('../../../components/ui/switch', () => ({
    Switch: {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template:
            '<button data-testid="toggle-same-instance" @click="$emit(\'update:modelValue\', !modelValue)">toggle</button>'
    }
}));

vi.mock('../components/FriendsLocationsCard.vue', () => ({
    default: {
        props: ['friend'],
        template: '<div data-testid="friend-card">{{ friend.displayName }}</div>'
    }
}));

import FriendsLocations from '../FriendsLocations.vue';

function makeFriend(id, displayName, location = 'wrld_1:instance') {
    return {
        id,
        displayName,
        signature: '',
        worldName: '',
        ref: {
            location
        }
    };
}

async function flushSettings() {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
    await nextTick();
}

describe('FriendsLocations.vue', () => {
    beforeEach(() => {
        mocks.onlineFriends.value = [];
        mocks.allFavoriteOnlineFriends.value = [];
        mocks.allFavoriteFriendIds.value = new Set();
        mocks.activeFriends.value = [];
        mocks.offlineFriends.value = [];
        mocks.friendsInSameInstance.value = [];
        mocks.isSidebarDivideByFriendGroup.value = false;
        mocks.sidebarFavoriteGroups.value = [];
        mocks.sidebarFavoriteGroupOrder.value = [];
        mocks.sidebarSortMethods.value = 'status';
        mocks.favoriteFriendGroups.value = [];
        mocks.groupedByGroupKeyFavoriteFriends.value = {};
        mocks.localFriendFavorites.value = {};
        mocks.lastLocation.value = {
            location: 'wrld_home:123',
            friendList: new Map()
        };

        mocks.configGetString.mockReset();
        mocks.configGetBool.mockReset();
        mocks.configSetString.mockReset();
        mocks.configSetBool.mockReset();
        mocks.virtualMeasure.mockReset();

        mocks.configGetString.mockImplementation((_key, defaultValue) => Promise.resolve(defaultValue ?? '1'));
        mocks.configGetBool.mockResolvedValue(false);
    });

    test('renders online friend cards after initial settings load', async () => {
        mocks.onlineFriends.value = [makeFriend('usr_1', 'Alice'), makeFriend('usr_2', 'Bob')];
        const wrapper = mount(FriendsLocations);
        await flushSettings();

        const cards = wrapper.findAll('[data-testid="friend-card"]');
        expect(cards.map((node) => node.text())).toEqual(['Alice', 'Bob']);
    });

    test('filters cards by search text in DOM', async () => {
        mocks.onlineFriends.value = [makeFriend('usr_1', 'Alice'), makeFriend('usr_2', 'Bob')];
        const wrapper = mount(FriendsLocations);
        await flushSettings();

        await wrapper.get('[data-testid="friend-locations-search"]').setValue('bob');
        await flushSettings();

        const cards = wrapper.findAll('[data-testid="friend-card"]');
        expect(cards.map((node) => node.text())).toEqual(['Bob']);
    });

    test('switches to offline segment and renders offline cards', async () => {
        mocks.onlineFriends.value = [makeFriend('usr_1', 'Alice')];
        mocks.offlineFriends.value = [makeFriend('usr_3', 'Carol')];
        const wrapper = mount(FriendsLocations);
        await flushSettings();

        await wrapper.get('[data-testid="segment-offline"]').trigger('click');
        await flushSettings();

        const cards = wrapper.findAll('[data-testid="friend-card"]');
        expect(cards.map((node) => node.text())).toEqual(['Carol']);
    });

    test('persists card scale and same-instance preferences', async () => {
        vi.useFakeTimers();
        const wrapper = mount(FriendsLocations);
        await flushSettings();
        mocks.configSetString.mockClear();
        mocks.configSetBool.mockClear();

        await wrapper.get('[data-testid="set-scale"]').trigger('click');
        await wrapper.get('[data-testid="toggle-same-instance"]').trigger('click');
        vi.advanceTimersByTime(500);

        expect(mocks.configSetString).toHaveBeenCalledWith('VRCX_FriendLocationCardScale', '0.8');
        expect(mocks.configSetBool).toHaveBeenCalledWith('VRCX_FriendLocationShowSameInstance', true);
        vi.useRealTimers();
    });

    test('coalesces repeated virtualizer measure requests in the same tick', async () => {
        const wrapper = mount(FriendsLocations);
        await flushSettings();
        mocks.virtualMeasure.mockClear();

        wrapper.vm.searchTerm = 'alice';
        wrapper.vm.activeSegment = 'offline';
        await nextTick();
        await nextTick();

        expect(mocks.virtualMeasure).toHaveBeenCalledTimes(1);
    });

    test('renders empty state when no rows match', async () => {
        const wrapper = mount(FriendsLocations);
        await flushSettings();

        expect(wrapper.get('[data-testid="empty-state"]').text()).toBe('nomatch');
    });

    test('flattens same-instance and other online friends into a single 4-per-row grid on Online tab', async () => {
        const f1 = makeFriend('usr_1', 'Futon', 'wrld_mizi:1');
        const f2 = makeFriend('usr_2', 'Lumia', 'wrld_mizi:1');
        const f3 = makeFriend('usr_3', 'Baibuhe', 'wrld_yoinagi:2');
        const f4 = makeFriend('usr_4', 'Aiaidis', 'private');
        const f5 = makeFriend('usr_5', 'Eris', 'wrld_other:3');
        const f6 = makeFriend('usr_6', 'Momo', 'private');

        mocks.friendsInSameInstance.value = [[f1, f2]];
        mocks.onlineFriends.value = [f1, f2, f3, f4, f5, f6];

        const wrapper = mount(FriendsLocations);
        await flushSettings();

        // No same-instance header or divider splits the Online tab into 2+2 rows
        expect(wrapper.find('.friend-view__instance-header').exists()).toBe(false);
        expect(wrapper.find('.friend-view__divider').exists()).toBe(false);

        const rows = wrapper.findAll('.friend-view__row');
        expect(rows).toHaveLength(2);
        expect(rows[0].findAll('[data-testid="friend-card"]').map((n) => n.text())).toEqual([
            'Futon',
            'Lumia',
            'Baibuhe',
            'Aiaidis'
        ]);
        expect(rows[1].findAll('[data-testid="friend-card"]').map((n) => n.text())).toEqual(['Eris', 'Momo']);

        const virtualEl = wrapper.get('.friend-view__virtual');
        expect(virtualEl.attributes('style')).toContain('--friend-grid-columns: 4');
    });

    test('keeps 4 columns across desktop container widths without horizontal overflow', async () => {
        mocks.onlineFriends.value = Array.from({ length: 5 }, (_, i) => makeFriend(`usr_${i + 1}`, `Friend${i + 1}`));
        const wrapper = mount(FriendsLocations);
        await flushSettings();

        for (const width of [760, 1112, 1680]) {
            wrapper.vm.gridWidth = width;
            await nextTick();

            const rows = wrapper.findAll('.friend-view__row');
            expect(rows).toHaveLength(2);
            expect(rows[0].findAll('[data-testid="friend-card"]')).toHaveLength(4);
            expect(rows[1].findAll('[data-testid="friend-card"]')).toHaveLength(1);

            const style = wrapper.get('.friend-view__virtual').attributes('style') || '';
            expect(style).toContain('--friend-grid-columns: 4');
            const targetMatch = style.match(/--friend-card-target-width:\s*(\d+)px/);
            const gapMatch = style.match(/--friend-card-gap:\s*(\d+)px/);
            expect(targetMatch).not.toBeNull();
            expect(gapMatch).not.toBeNull();
            const cardW = Number(targetMatch[1]);
            const gap = Number(gapMatch[1]);
            expect(cardW * 4 + gap * 3 + 12).toBeLessThanOrEqual(width);
        }
    });
});
