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

        expect(enLocale.view.settings.appearance.appearance.theme_mode_kawaii).toBe('Kawaii Pastel');
        expect(zhCnLocale.view.settings.appearance.appearance.theme_mode_kawaii).toBe('二次元少女');
        expect(zhTwLocale.view.settings.appearance.appearance.theme_mode_kawaii).toBe('二次元少女');
        expect(jaLocale.view.settings.appearance.appearance.theme_mode_kawaii).toBe('ゆめかわ');
    });

    it('scopes every selector in kawaii.css strictly under :root[data-theme=\'kawaii\']', () => {
        const cssPath = path.resolve(process.cwd(), 'src/styles/themes/kawaii.css');
        const css = fs.readFileSync(cssPath, 'utf-8');
        // Strip comments and @media wrappers, then ensure every selector block is gated by [data-theme='kawaii']
        const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const selectorLines = withoutComments
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.endsWith('{') && !line.startsWith('@media'));
        expect(selectorLines.length).toBeGreaterThan(15);
        for (const line of selectorLines) {
            expect(line).toContain(":root[data-theme='kawaii']");
        }
    });
});
