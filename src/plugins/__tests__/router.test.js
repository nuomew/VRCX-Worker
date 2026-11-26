import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockView = vi.hoisted(() => ({ template: '<div />' }));

vi.mock('../../services/watchState', () => ({
    watchState: { isLoggedIn: true }
}));

vi.mock('../../views/Tools/AvatarSearch.vue', () => ({ default: mockView }));
vi.mock('../../views/Tools/ChatTranslator.vue', () => ({ default: mockView }));
vi.mock('../../views/Favorites/FavoritesAvatar.vue', () => ({ default: mockView }));
vi.mock('../../views/Favorites/FavoritesFriend.vue', () => ({ default: mockView }));
vi.mock('../../views/Favorites/FavoritesWorld.vue', () => ({ default: mockView }));
vi.mock('../../views/Feed/Feed.vue', () => ({ default: mockView }));
vi.mock('../../views/FriendList/FriendList.vue', () => ({ default: mockView }));
vi.mock('../../views/FriendLog/FriendLog.vue', () => ({ default: mockView }));
vi.mock('../../views/FriendsLocations/FriendsLocations.vue', () => ({ default: mockView }));
vi.mock('../../views/Dashboard/Dashboard.vue', () => ({ default: mockView }));
vi.mock('../../views/Tools/Gallery.vue', () => ({ default: mockView }));
vi.mock('../../views/GameLog/GameLog.vue', () => ({ default: mockView }));
vi.mock('../../views/Charts/components/HotWorlds.vue', () => ({ default: mockView }));
vi.mock('../../views/Charts/components/InstanceActivity.vue', () => ({ default: mockView }));
vi.mock('../../views/Login/Login.vue', () => ({ default: mockView }));
vi.mock('../../views/Layout/MainLayout.vue', () => ({ default: { template: '<router-view />' } }));
vi.mock('../../views/Moderation/Blacklist.vue', () => ({ default: mockView }));
vi.mock('../../views/Moderation/Moderation.vue', () => ({ default: mockView }));
vi.mock('../../views/Charts/components/MutualFriends.vue', () => ({ default: mockView }));
vi.mock('../../views/MyAvatars/MyAvatars.vue', () => ({ default: mockView }));
vi.mock('../../views/Notifications/Notification.vue', () => ({ default: mockView }));
vi.mock('../../views/PlayerList/PlayerList.vue', () => ({ default: mockView }));
vi.mock('../../views/Tools/ScreenshotMetadata.vue', () => ({ default: mockView }));
vi.mock('../../views/Search/Search.vue', () => ({ default: mockView }));
vi.mock('../../views/Settings/Settings.vue', () => ({ default: mockView }));
vi.mock('../../views/Tools/Tools.vue', () => ({ default: mockView }));
vi.mock('../../views/Tools/VRChatStore.vue', () => ({ default: mockView }));

import { isChunkLoadError, recoverFromChunkLoadError, router } from '../router';

describe('router charts routes and chunk error recovery', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
    });

    test('registers all three charts routes as eager components and navigates directly', async () => {
        for (const name of ['charts-instance', 'charts-mutual', 'charts-hot-worlds']) {
            const resolved = router.resolve({ name });
            const leaf = resolved.matched[resolved.matched.length - 1];
            expect(leaf?.components?.default).toBeTruthy();
            expect(typeof leaf?.components?.default).not.toBe('function');

            await router.push({ name });
            expect(router.currentRoute.value.name).toBe(name);
        }
    });

    test('detects dynamic chunk load failures and reloads at most once within cooldown window', () => {
        expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/HotWorlds.js'))).toBe(
            true
        );
        expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
        expect(isChunkLoadError(new Error('Random unrelated error'))).toBe(false);

        const reloadMock = vi.fn();
        const originalLocation = window.location;
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: {
                ...originalLocation,
                hash: '#/my-avatars',
                reload: reloadMock
            }
        });

        try {
            expect(recoverFromChunkLoadError('/charts/hot-worlds')).toBe(true);
            expect(window.location.hash).toBe('#/charts/hot-worlds');
            expect(reloadMock).toHaveBeenCalledTimes(1);

            // Second attempt within cooldown should be suppressed to prevent reload loops
            expect(recoverFromChunkLoadError('/charts/hot-worlds')).toBe(false);
            expect(reloadMock).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(window, 'location', {
                configurable: true,
                value: originalLocation
            });
        }
    });
});
