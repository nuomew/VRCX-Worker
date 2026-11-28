import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../plugins/router', () => ({
    router: { push: vi.fn() }
}));
vi.mock('../../plugins/i18n', () => ({
    i18n: { global: { t: (k) => k } }
}));
vi.mock('../../services/config.js', () => ({
    default: {
        getString: vi.fn(async () => ''),
        setString: vi.fn(async () => {})
    }
}));

import { THEME_CONFIG } from '../../shared/constants/themes';
import { changeAppThemeStyle, getThemeMode } from '../../shared/utils/base/ui';
import { normalizePublicUiPreferences } from '../cloudState';
import enLocale from '../../localization/en.json';
import zhCnLocale from '../../localization/zh-CN.json';
import zhTwLocale from '../../localization/zh-TW.json';
import jaLocale from '../../localization/ja.json';

describe('Kawaii Pastel theme registration, switching & isolation', () => {
    beforeEach(() => {
        document.documentElement.removeAttribute('data-theme');
        document.documentElement.classList.remove('dark');
        document.getElementById('app-theme-mode-style')?.remove();
        globalThis.AppApi = {
            ChangeTheme: vi.fn()
        };
        globalThis.LINUX = false;
    });

    it('registers kawaii as a light theme backed by kawaii.css without altering existing themes', () => {
        expect(Object.keys(THEME_CONFIG)).toEqual(['system', 'light', 'dark', 'midnight', 'kawaii']);
        expect(THEME_CONFIG.kawaii).toEqual({
            isDark: false,
            name: 'Kawaii Pastel',
            file: 'kawaii.css'
        });
        expect(THEME_CONFIG.light).toEqual({ isDark: false, name: 'Light' });
        expect(THEME_CONFIG.dark).toEqual({ isDark: true, name: 'Dark' });
        expect(THEME_CONFIG.midnight).toEqual({ isDark: true, name: 'Midnight', file: 'midnight.css' });
    });

    it('detects kawaii as light mode in getThemeMode instead of misclassifying as dark', async () => {
        const mockRepo = {
            getString: vi.fn(async () => 'kawaii')
        };
        const result = await getThemeMode(mockRepo);
        expect(result).toEqual({ initThemeMode: 'kawaii', isDarkMode: false });

        const midnightRepo = {
            getString: vi.fn(async () => 'midnight')
        };
        expect(await getThemeMode(midnightRepo)).toEqual({ initThemeMode: 'midnight', isDarkMode: true });
    });

    it('switches cleanly to kawaii and removes its stylesheet when returning to light or dark', () => {
        const kawaiiRes = changeAppThemeStyle('kawaii');
        expect(kawaiiRes).toEqual({ isDark: false });
        expect(document.documentElement.getAttribute('data-theme')).toBe('kawaii');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        const link = document.getElementById('app-theme-mode-style');
        expect(link).not.toBeNull();
        expect(link?.getAttribute('rel')).toBe('stylesheet');
        expect(link?.getAttribute('href')).toBeTruthy();
        expect(globalThis.AppApi.ChangeTheme).toHaveBeenCalledWith(0);

        const lightRes = changeAppThemeStyle('light');
        expect(lightRes).toEqual({ isDark: false });
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(document.getElementById('app-theme-mode-style')).toBeNull();

        const darkRes = changeAppThemeStyle('dark');
        expect(darkRes).toEqual({ isDark: true });
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.getElementById('app-theme-mode-style')).toBeNull();

        const midnightRes = changeAppThemeStyle('midnight');
        expect(midnightRes).toEqual({ isDark: true });
        expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.getElementById('app-theme-mode-style')).not.toBeNull();
    });

    it('allowlists kawaii in pre-auth UI preferences and provides symmetric translations', () => {
        expect(normalizePublicUiPreferences({ themeMode: 'kawaii', themeColor: 'rose', appLanguage: 'zh-CN' })).toEqual(
            {
                themeMode: 'kawaii',
                themeColor: 'rose',
                appLanguage: 'zh-CN'
            }
        );

        const requiredKeys = [
            'theme_mode_kawaii',
            'kawaii_badge',
            'kawaii_toggle_mascot',
            'kawaii_toggle_friends',
            'kawaii_quick_theme',
            'kawaii_accent_colors',
            'kawaii_greeting_morning',
            'kawaii_greeting_afternoon',
            'kawaii_greeting_evening',
            'kawaii_greeting_night',
            'kawaii_stat_friends',
            'kawaii_stat_game',
            'kawaii_stat_servers',
            'kawaii_stat_running',
            'kawaii_stat_idle',
            'kawaii_stat_ok',
            'kawaii_stat_issue'
        ];
        for (const loc of [enLocale, zhCnLocale, zhTwLocale, jaLocale]) {
            for (const key of requiredKeys) {
                expect(typeof loc.view.settings.appearance.appearance[key]).toBe('string');
                expect(loc.view.settings.appearance.appearance[key].trim().length).toBeGreaterThan(0);
            }
        }
        expect(enLocale.view.settings.appearance.appearance.theme_mode_kawaii).toBe('Kawaii Pastel');
        expect(zhCnLocale.view.settings.appearance.appearance.theme_mode_kawaii).toBe('二次元少女');
        expect(zhTwLocale.view.settings.appearance.appearance.theme_mode_kawaii).toBe('二次元少女');
        expect(jaLocale.view.settings.appearance.appearance.theme_mode_kawaii).toBe('ゆめかわ');
    });

    it('isolates KawaiiLayout shell behind isKawaiiTheme and keeps original shell untouched', () => {
        const mainLayoutPath = path.resolve(process.cwd(), 'src/views/Layout/MainLayout.vue');
        const kawaiiLayoutPath = path.resolve(process.cwd(), 'src/views/Layout/KawaiiLayout.vue');
        const mainLayoutSrc = fs.readFileSync(mainLayoutPath, 'utf-8');
        const kawaiiLayoutSrc = fs.readFileSync(kawaiiLayoutPath, 'utf-8');

        expect(mainLayoutSrc).toContain("const isKawaiiTheme = computed(() => themeMode.value === 'kawaii')");
        expect(mainLayoutSrc).toContain('<KawaiiLayout v-if="isKawaiiTheme" />');
        expect(mainLayoutSrc).toContain('<SidebarProvider');
        expect(mainLayoutSrc).toContain('<NavMenu />');

        expect(kawaiiLayoutSrc).toContain('kawaii-bg.jpg');
        expect(kawaiiLayoutSrc).toContain('kawaii-mascot.jpg');
        expect(kawaiiLayoutSrc).toContain('initThemeColor()');
        expect(kawaiiLayoutSrc).toContain('loadNavMenuConfig()');
        expect(kawaiiLayoutSrc).toContain('<Sidebar />');
        expect(kawaiiLayoutSrc).toContain('<StatusBar />');

        const bgPath = path.resolve(process.cwd(), 'src/assets/themes/kawaii/kawaii-bg.jpg');
        const mascotPath = path.resolve(process.cwd(), 'src/assets/themes/kawaii/kawaii-mascot.jpg');
        expect(fs.statSync(bgPath).size).toBeGreaterThan(10000);
        expect(fs.statSync(mascotPath).size).toBeGreaterThan(10000);
    });

    it('scopes every style rule in kawaii.css strictly under :root[data-theme=\'kawaii\']', () => {
        const cssPath = path.resolve(process.cwd(), 'src/styles/themes/kawaii.css');
        const css = fs.readFileSync(cssPath, 'utf-8');
        const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
        // Remove @keyframes blocks after verifying their names are namespaced to kawaii-*
        const keyframeNames = [...withoutComments.matchAll(/@keyframes\s+([a-zA-Z0-9_-]+)\s*\{/g)].map((m) => m[1]);
        for (const name of keyframeNames) {
            expect(name.startsWith('kawaii-')).toBe(true);
        }
        const withoutKeyframes = withoutComments.replace(/@keyframes\s+[a-zA-Z0-9_-]+\s*\{[\s\S]*?\}\s*\}/g, '');
        const selectorLines = withoutKeyframes
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.endsWith('{') && !line.startsWith('@media'));
        expect(selectorLines.length).toBeGreaterThan(30);
        for (const line of selectorLines) {
            expect(line).toContain(":root[data-theme='kawaii']");
        }
    });
});
