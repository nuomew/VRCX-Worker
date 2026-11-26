import { createRouter, createWebHashHistory } from 'vue-router';

import { watchState } from '../services/watchState';

import AvatarSearch from './../views/Tools/AvatarSearch.vue';
import ChatTranslator from './../views/Tools/ChatTranslator.vue';
import FavoritesAvatar from './../views/Favorites/FavoritesAvatar.vue';
import FavoritesFriend from './../views/Favorites/FavoritesFriend.vue';
import FavoritesWorld from './../views/Favorites/FavoritesWorld.vue';
import Feed from './../views/Feed/Feed.vue';
import FriendList from './../views/FriendList/FriendList.vue';
import FriendLog from './../views/FriendLog/FriendLog.vue';
import FriendsLocations from './../views/FriendsLocations/FriendsLocations.vue';
import Dashboard from './../views/Dashboard/Dashboard.vue';
import Gallery from './../views/Tools/Gallery.vue';
import GameLog from './../views/GameLog/GameLog.vue';
import HotWorlds from './../views/Charts/components/HotWorlds.vue';
import InstanceActivity from './../views/Charts/components/InstanceActivity.vue';
import Login from './../views/Login/Login.vue';
import MainLayout from '../views/Layout/MainLayout.vue';
import Blacklist from './../views/Moderation/Blacklist.vue';
import Moderation from './../views/Moderation/Moderation.vue';
import MutualFriends from './../views/Charts/components/MutualFriends.vue';
import MyAvatars from './../views/MyAvatars/MyAvatars.vue';
import Notification from './../views/Notifications/Notification.vue';
import PlayerList from './../views/PlayerList/PlayerList.vue';
import ScreenshotMetadata from './../views/Tools/ScreenshotMetadata.vue';
import Search from './../views/Search/Search.vue';
import Settings from './../views/Settings/Settings.vue';
import Tools from './../views/Tools/Tools.vue';
import VRChatStore from './../views/Tools/VRChatStore.vue';

const routes = [
    {
        path: '/login',
        name: 'login',
        component: Login,
        meta: { public: true }
    },
    {
        path: '/',
        component: MainLayout,
        meta: { requiresAuth: true },
        children: [
            { path: '', redirect: { name: 'feed' } },
            { path: 'feed', name: 'feed', component: Feed },
            {
                path: 'friends-locations',
                name: 'friends-locations',
                component: FriendsLocations
            },
            { path: 'game-log', name: 'game-log', component: GameLog },
            { path: 'player-list', name: 'player-list', component: PlayerList },
            { path: 'search', name: 'search', component: Search },
            {
                path: 'dashboard/:id',
                name: 'dashboard',
                component: Dashboard,
                props: true,
                meta: { navKey: 'dashboard' }
            },
            {
                path: 'favorites/friends',
                name: 'favorite-friends',
                component: FavoritesFriend
            },
            {
                path: 'favorites/worlds',
                name: 'favorite-worlds',
                component: FavoritesWorld
            },
            {
                path: 'favorites/avatars',
                name: 'favorite-avatars',
                component: FavoritesAvatar
            },
            {
                path: 'social/friend-log',
                name: 'friend-log',
                component: FriendLog
            },
            {
                path: 'social/moderation',
                name: 'moderation',
                component: Moderation
            },
            {
                path: 'social/blacklist',
                name: 'blacklist',
                component: Blacklist
            },
            {
                path: 'my-avatars',
                name: 'my-avatars',
                component: MyAvatars
            },
            {
                path: 'notification',
                name: 'notification',
                component: Notification
            },
            {
                path: 'social/friend-list',
                name: 'friend-list',
                component: FriendList
            },
            {
                path: 'charts',
                name: 'charts',
                redirect: { name: 'charts-instance' }
            },
            {
                path: 'charts/instance',
                name: 'charts-instance',
                component: InstanceActivity
            },
            {
                path: 'charts/mutual',
                name: 'charts-mutual',
                component: MutualFriends
            },
            {
                path: 'charts/hot-worlds',
                name: 'charts-hot-worlds',
                component: HotWorlds
            },
            { path: 'tools', name: 'tools', component: Tools },
            {
                path: 'tools/gallery',
                name: 'gallery',
                component: Gallery,
                meta: { navKeys: ['tool-gallery', 'tools'] }
            },
            {
                path: 'tools/avatar-search',
                name: 'avatar-search',
                component: AvatarSearch,
                meta: { navKeys: ['tool-avatar-search', 'tools'] }
            },
            {
                path: 'tools/chat-translator',
                name: 'chat-translator',
                component: ChatTranslator,
                meta: { navKeys: ['tool-chat-translator', 'tools'] }
            },
            {
                path: 'tools/screenshot-metadata',
                name: 'screenshot-metadata',
                component: ScreenshotMetadata,
                meta: { navKeys: ['tool-screenshot-metadata', 'tools'] }
            },
            {
                path: 'tools/vrchat-store',
                name: 'vrchat-store',
                component: VRChatStore,
                meta: { navKeys: ['tool-vrchat-store', 'tools'] }
            },
            {
                path: 'settings',
                name: 'settings',
                component: Settings,
                meta: { navKey: 'manage', hidesActiveMenuItem: true }
            }
        ]
    }
];

export const router = createRouter({
    history: createWebHashHistory(),
    // @ts-ignore
    routes
});

const CHUNK_RELOAD_GUARD_KEY = 'vrcx:chunk-reload-guard';
const CHUNK_RELOAD_COOLDOWN_MS = 15000;

/**
 * Detects stale hashed dynamic chunk load errors after a new Web deployment.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isChunkLoadError(error) {
    const message = String(error?.message || error || '');
    return (
        message.includes('Failed to fetch dynamically imported module') ||
        message.includes('Importing a module script failed') ||
        message.includes('error loading dynamically imported module') ||
        message.includes('Unable to preload CSS')
    );
}

/**
 * Reloads once with a short cooldown when a stale async chunk fails to load,
 * preventing silent dead clicks after Cloudflare Workers redeploys.
 *
 * @param {string} [targetFullPath]
 * @returns {boolean}
 */
export function recoverFromChunkLoadError(targetFullPath = '') {
    if (typeof window === 'undefined') {
        return false;
    }
    try {
        const now = Date.now();
        const raw = window.sessionStorage?.getItem(CHUNK_RELOAD_GUARD_KEY);
        if (raw) {
            const prev = JSON.parse(raw);
            if (prev && now - Number(prev.ts || 0) < CHUNK_RELOAD_COOLDOWN_MS) {
                return false;
            }
        }
        window.sessionStorage?.setItem(CHUNK_RELOAD_GUARD_KEY, JSON.stringify({ ts: now, path: targetFullPath }));
    } catch {
        // Ignore storage restrictions and still attempt reload once.
    }
    if (targetFullPath && typeof window.location?.hash === 'string') {
        const nextHash = targetFullPath.startsWith('#') ? targetFullPath : `#${targetFullPath}`;
        if (window.location.hash !== nextHash) {
            window.location.hash = nextHash;
        }
    }
    window.location.reload();
    return true;
}

let preloadErrorListenerAttached = false;

export function initRouter(app) {
    app.use(router);
    if (!preloadErrorListenerAttached && typeof window !== 'undefined') {
        preloadErrorListenerAttached = true;
        window.addEventListener('vite:preloadError', (event) => {
            if (recoverFromChunkLoadError()) {
                event.preventDefault();
            }
        });
    }
}

router.onError((error, to) => {
    if (isChunkLoadError(error)) {
        recoverFromChunkLoadError(to?.fullPath || '');
    }
});

router.beforeEach((to) => {
    if (to.path === '/social') {
        return false;
    }

    if (to.name === 'login' && watchState.isLoggedIn) {
        return { name: 'feed' };
    }

    const requiresAuth = to.matched.some((record) => record.meta?.requiresAuth);
    if (requiresAuth && !watchState.isLoggedIn) {
        const redirect = to.fullPath;
        if (redirect && redirect !== '/feed') {
            return { name: 'login', query: { redirect } };
        }
        return { name: 'login' };
    }

    return true;
});
