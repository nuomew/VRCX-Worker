import { beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick, shallowReactive } from 'vue';
import { mount } from '@vue/test-utils';

const cachedWorlds = shallowReactive(new Map());

vi.mock('../../../stores', () => ({
    useWorldStore: () => ({
        cachedWorlds
    })
}));

vi.mock('../../../composables/useUserDisplay', () => ({
    useUserDisplay: () => ({
        userImage: () => 'https://example.com/avatar.png',
        userStatusClass: () => ({ online: true })
    })
}));

vi.mock('../../../coordinators/userCoordinator', () => ({
    showUserDialog: vi.fn()
}));

vi.mock('@/components/IconFrame.vue', () => ({
    default: { template: '<span />' }
}));

vi.mock('@/components/ProfileEffect.vue', () => ({
    default: { template: '<span />' }
}));

vi.mock('../../../components/Location.vue', () => ({
    default: { template: '<div class="mock-location" />' }
}));

vi.mock('../../../components/UserContextMenu.vue', () => ({
    default: { template: '<div><slot /></div>' }
}));

import FriendsLocationsCard from '../components/FriendsLocationsCard.vue';

function makeFriend(location, travelingToLocation = '') {
    return {
        id: 'usr_friend_1',
        name: 'aiaidis',
        state: 'online',
        pendingOffline: false,
        worldName: 'Forge Warband',
        ref: {
            location,
            travelingToLocation,
            statusDescription: '',
            profileEffect: '',
            iconFrame: ''
        }
    };
}

describe('FriendsLocationsCard.vue', () => {
    beforeEach(() => {
        cachedWorlds.clear();
    });

    test('renders translucent world cover background for public/friends+ instances and reacts when cachedWorlds populates', async () => {
        const worldId = 'wrld_11111111-1111-1111-1111-111111111111';
        const wrapper = mount(FriendsLocationsCard, {
            props: {
                friend: makeFriend(`${worldId}:56789~hidden(usr_host)~region(jp)`),
                displayInstanceInfo: true
            }
        });

        // Initially absent before world metadata resolves
        expect(wrapper.find('[data-world-bg]').exists()).toBe(false);

        // Once Location resolves world metadata into cachedWorlds, background appears reactively
        cachedWorlds.set(worldId, {
            id: worldId,
            name: 'Forge Warband',
            thumbnailImageUrl: 'https://api.vrchat.cloud/api/1/image/file_world_cover/1/256'
        });
        await nextTick();

        const bg = wrapper.find('[data-world-bg]');
        expect(bg.exists()).toBe(true);
        expect(bg.find('img').attributes('src')).toBe('https://api.vrchat.cloud/api/1/image/file_world_cover/1/256');
        wrapper.unmount();
    });

    test('hides world cover background for private rooms, offline friends, or when instance info is hidden', () => {
        const worldId = 'wrld_22222222-2222-2222-2222-222222222222';
        cachedWorlds.set(worldId, {
            id: worldId,
            thumbnailImageUrl: 'https://api.vrchat.cloud/api/1/image/file_world_2/1/256'
        });

        const privateWrapper = mount(FriendsLocationsCard, {
            props: {
                friend: makeFriend('private'),
                displayInstanceInfo: true
            }
        });
        expect(privateWrapper.find('[data-world-bg]').exists()).toBe(false);
        privateWrapper.unmount();

        const offlineWrapper = mount(FriendsLocationsCard, {
            props: {
                friend: makeFriend('offline'),
                displayInstanceInfo: true
            }
        });
        expect(offlineWrapper.find('[data-world-bg]').exists()).toBe(false);
        offlineWrapper.unmount();

        const hiddenInstanceWrapper = mount(FriendsLocationsCard, {
            props: {
                friend: makeFriend(`${worldId}:12345`),
                displayInstanceInfo: false
            }
        });
        expect(hiddenInstanceWrapper.find('[data-world-bg]').exists()).toBe(false);
        hiddenInstanceWrapper.unmount();
    });

    test('uses travelingToLocation world cover while friend is traveling to a public/friends instance', () => {
        const worldId = 'wrld_33333333-3333-3333-3333-333333333333';
        cachedWorlds.set(worldId, {
            id: worldId,
            thumbnailImageUrl: 'https://api.vrchat.cloud/api/1/image/file_travel_cover/1/256'
        });

        const wrapper = mount(FriendsLocationsCard, {
            props: {
                friend: makeFriend('traveling', `${worldId}:99999`),
                displayInstanceInfo: true
            }
        });
        expect(wrapper.find('[data-world-bg] img').attributes('src')).toBe(
            'https://api.vrchat.cloud/api/1/image/file_travel_cover/1/256'
        );
        wrapper.unmount();
    });
});
