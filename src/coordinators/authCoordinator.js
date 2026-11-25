import { i18n } from '../plugins/i18n';

import Noty from 'noty';

import { closeWebSocket, initWebsocket } from '../services/websocket';
import { escapeTag } from '../shared/utils';
import { queryClient } from '../queries';
import { useAuthStore } from '../stores/auth';
import { useInstanceStore } from '../stores/instance';
import { useNotificationStore } from '../stores/notification';
import { useUpdateLoopStore } from '../stores/updateLoop';
import { useUserStore } from '../stores/user';
import { applyCurrentUser } from './userCoordinator';
import { watchState } from '../services/watchState';

import configRepository from '../services/config';
import { resetCloudRssSyncState } from '../ipc-web/cloudRssSync.js';
import { resetCloudDatabaseState } from '../services/database/cloud/index.js';
import webApiService from '../services/webapi';

/**
 * Runs the shared logout side effects (including goodbye notification).
 */
export async function runLogoutFlow() {
    const authStore = useAuthStore();
    const userStore = useUserStore();
    const notificationStore = useNotificationStore();
    const t = i18n.global.t;

    if (watchState.isLoggedIn) {
        new Noty({
            type: 'success',
            text: t('message.auth.logout_greeting', {
                name: `<strong>${escapeTag(userStore.currentUser.displayName)}</strong>`
            })
        }).show();
    }

    userStore.setUserDialogVisible(false);
    watchState.isLoggedIn = false;
    watchState.isFriendsLoaded = false;
    watchState.isFavoritesLoaded = false;
    notificationStore.setNotificationInitStatus(false);
    try {
        await authStore.updateStoredUser(userStore.currentUser);
    } catch (err) {
        console.warn('[auth] Failed to update stored user during logout:', err);
    }
    try {
        await webApiService.clearCookies();
    } catch (err) {
        console.warn('[auth] Failed to clear cookies during logout:', err);
    }
    authStore.loginForm.lastUserLoggedIn = '';
    try {
        await configRepository.remove('lastUserLoggedIn');
    } catch (err) {
        console.warn('[auth] Failed to clear lastUserLoggedIn during logout:', err);
    }
    authStore.setAttemptingAutoLogin(false);
    authStore.autoLoginAttempts.clear();
    closeWebSocket();
    queryClient.clear();
    if (typeof WEB !== 'undefined' && WEB) {
        resetCloudRssSyncState();
        resetCloudDatabaseState();
    }
}

/**
 * Runs post-login side effects after a successful auth response.
 *
 * @param {object} json Current user payload from auth API.
 */
export function runLoginSuccessFlow(json) {
    const updateLoopStore = useUpdateLoopStore();
    const authStore = useAuthStore();
    const instanceStore = useInstanceStore();

    updateLoopStore.setNextCurrentUserRefresh(420); // 7mins
    applyCurrentUser(json);
    initWebsocket();
    void authStore.getPermissions();
    void instanceStore.loadInstanceCategoriesAndVibes();
}
