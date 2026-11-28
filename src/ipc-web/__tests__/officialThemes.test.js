import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
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
import { computePriorityNavSplit } from '../../views/Layout/composables/usePriorityNav';
import {
    clampThemeBrightness,
    computeDimOverlayOpacity,
    useThemeBrightness
} from '../../views/Layout/composables/useThemeBrightness';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger
} from '../../components/ui/dropdown-menu';
import enLocale from '../../localization/en.json';
import zhCnLocale from '../../localization/zh-CN.json';
import zhTwLocale from '../../localization/zh-TW.json';
import jaLocale from '../../localization/ja.json';

function assertCssStrictlyScoped(relCssPath, expectedRootSelector) {
    const cssPath = path.resolve(process.cwd(), relCssPath);
    const css = fs.readFileSync(cssPath, 'utf-8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectorLines = withoutComments
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('{') && !line.startsWith('@media'));
    expect(selectorLines.length).toBeGreaterThan(20);
    for (const line of selectorLines) {
        expect(line).toContain(expectedRootSelector);
    }
}

describe('Official Anime-Site Dual Themes (Lookbook & Azure Archive) registration & isolation', () => {
    beforeEach(() => {
        document.documentElement.removeAttribute('data-theme');
        document.documentElement.classList.remove('dark');
        document.getElementById('app-theme-mode-style')?.remove();
        globalThis.AppApi = {
            ChangeTheme: vi.fn()
        };
        globalThis.LINUX = false;
    });

    it('registers lookbook and archive as light themes without altering system/light/dark/midnight', () => {
        expect(Object.keys(THEME_CONFIG)).toEqual(['system', 'light', 'dark', 'midnight', 'lookbook', 'archive']);
        expect(THEME_CONFIG.lookbook).toEqual({
            isDark: false,
            name: 'Lookbook Editorial',
            file: 'lookbook.css'
        });
        expect(THEME_CONFIG.archive).toEqual({
            isDark: false,
            name: 'Azure Archive',
            file: 'archive.css'
        });
        expect(THEME_CONFIG.light).toEqual({ isDark: false, name: 'Light' });
        expect(THEME_CONFIG.dark).toEqual({ isDark: true, name: 'Dark' });
        expect(THEME_CONFIG.midnight).toEqual({ isDark: true, name: 'Midnight', file: 'midnight.css' });
    });

    it('detects lookbook/archive as light mode and migrates legacy kawaii cleanly to lookbook', async () => {
        expect(await getThemeMode({ getString: vi.fn(async () => 'lookbook') })).toEqual({
            initThemeMode: 'lookbook',
            isDarkMode: false
        });
        expect(await getThemeMode({ getString: vi.fn(async () => 'archive') })).toEqual({
            initThemeMode: 'archive',
            isDarkMode: false
        });
        expect(await getThemeMode({ getString: vi.fn(async () => 'kawaii') })).toEqual({
            initThemeMode: 'lookbook',
            isDarkMode: false
        });
        expect(await getThemeMode({ getString: vi.fn(async () => 'midnight') })).toEqual({
            initThemeMode: 'midnight',
            isDarkMode: true
        });
    });

    it('switches cleanly between lookbook, archive, and original themes while cleaning up stylesheets', () => {
        expect(changeAppThemeStyle('lookbook')).toEqual({ isDark: false });
        expect(document.documentElement.getAttribute('data-theme')).toBe('lookbook');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(document.getElementById('app-theme-mode-style')).not.toBeNull();

        expect(changeAppThemeStyle('archive')).toEqual({ isDark: false });
        expect(document.documentElement.getAttribute('data-theme')).toBe('archive');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(document.getElementById('app-theme-mode-style')).not.toBeNull();

        // Legacy alias resolves safely without falling back to error
        expect(changeAppThemeStyle('kawaii')).toEqual({ isDark: false });
        expect(document.documentElement.getAttribute('data-theme')).toBe('lookbook');

        // Returning to light/dark removes custom theme stylesheet completely
        expect(changeAppThemeStyle('light')).toEqual({ isDark: false });
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(document.getElementById('app-theme-mode-style')).toBeNull();

        expect(changeAppThemeStyle('dark')).toEqual({ isDark: true });
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.getElementById('app-theme-mode-style')).toBeNull();
    });

    it('allowlists lookbook & archive in pre-auth UI preferences and provides symmetric 4-locale copy', () => {
        expect(normalizePublicUiPreferences({ themeMode: 'lookbook', themeColor: 'rose', appLanguage: 'zh-CN' })).toEqual(
            {
                themeMode: 'lookbook',
                themeColor: 'rose',
                appLanguage: 'zh-CN'
            }
        );
        expect(normalizePublicUiPreferences({ themeMode: 'archive', themeColor: 'blue', appLanguage: 'ja' })).toEqual({
            themeMode: 'archive',
            themeColor: 'blue',
            appLanguage: 'ja'
        });

        const requiredKeys = [
            'theme_mode_lookbook',
            'theme_mode_archive',
            'editorial_lookbook_subtitle',
            'editorial_lookbook_salon',
            'editorial_lookbook_toggle_cover',
            'editorial_lookbook_online_now',
            'editorial_lookbook_other_friends',
            'editorial_lookbook_open_salon',
            'editorial_lookbook_tagline',
            'editorial_archive_subtitle',
            'editorial_archive_online_strip',
            'editorial_archive_toggle_strip',
            'editorial_archive_toggle_panel',
            'editorial_quick_theme',
            'editorial_accent_colors',
            'editorial_theme_brightness',
            'editorial_theme_brightness_reset',
            'editorial_nav_more',
            'editorial_stat_friends',
            'editorial_stat_game',
            'editorial_stat_servers',
            'editorial_stat_running',
            'editorial_stat_idle',
            'editorial_stat_ok',
            'editorial_stat_issue'
        ];
        for (const loc of [enLocale, zhCnLocale, zhTwLocale, jaLocale]) {
            for (const key of requiredKeys) {
                expect(typeof loc.view.settings.appearance.appearance[key]).toBe('string');
                expect(loc.view.settings.appearance.appearance[key].trim().length).toBeGreaterThan(0);
            }
        }
    });

    it('isolates LookbookLayout and ArchiveLayout shells in MainLayout while preserving original shell intact', () => {
        const mainSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/views/Layout/MainLayout.vue'), 'utf-8');
        const lookbookSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/views/Layout/LookbookLayout.vue'), 'utf-8');
        const archiveSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/views/Layout/ArchiveLayout.vue'), 'utf-8');

        expect(mainSrc).toContain(`<LookbookLayout v-if="themeMode === 'lookbook'" />`);
        expect(mainSrc).toContain(`<ArchiveLayout v-else-if="themeMode === 'archive'" />`);
        expect(mainSrc).toContain('<SidebarProvider');
        expect(mainSrc).toContain('<NavMenu />');

        for (const src of [lookbookSrc, archiveSrc]) {
            expect(src).toContain('initThemeColor()');
            expect(src).toContain('loadNavMenuConfig()');
            expect(src).toContain('<Sidebar />');
            expect(src).toContain('<StatusBar />');
            expect(src).toContain('usePriorityNav');
            expect(src).toContain('overflowMenuItems');
            expect(src).toContain('data-priority-item');
            expect(src).toContain('data-priority-more');
            // Regression guard: never wrap DropdownMenuTrigger inside TooltipWrapper (breaks Reka UI pointerdown)
            expect(src).not.toMatch(/<TooltipWrapper[\s\S]{0,200}<DropdownMenuTrigger/);
            // Regression guard: top nav rail must never use horizontal overflow-x-auto that slices labels mid-character
            expect(src).not.toMatch(/<nav[\s\S]{0,220}overflow-x-auto/);
            // Both Lookbook & Archive place Theme Brightness directly below Accent Palette inside the Theme dropdown
            const accentIdx = src.indexOf('editorial_accent_colors');
            const brightnessIdx = src.indexOf('editorial_theme_brightness');
            expect(accentIdx).toBeGreaterThan(-1);
            expect(brightnessIdx).toBeGreaterThan(accentIdx);
            expect(src).toContain('useThemeBrightness');
        }

        expect(lookbookSrc).toContain('lb-brightness-dimmer');
        expect(archiveSrc).toContain('arc-brightness-dimmer');
        // Brightness dimmer must sit above all modals (10000+), dropdowns (12000), cloud overlays (20000), and toasts (999999999)
        expect(lookbookSrc).toContain('z-[2147483647]');
        expect(archiveSrc).toContain('z-[2147483647]');
        // Lookbook left cover card reuses native categorized FriendsSidebar (favorites/subgroups, online, active, offline + virtual scroll)
        expect(lookbookSrc).toContain('<FriendsSidebar hide-me :render-edit-profile-dialog="false"');
        expect(lookbookSrc).toContain('lb-folio-friends-scroll');
        const friendsSidebarSrc = fs.readFileSync(
            path.resolve(process.cwd(), 'src/views/Sidebar/components/FriendsSidebar.vue'),
            'utf-8'
        );
        expect(friendsSidebarSrc).toContain('hideMe');
        expect(friendsSidebarSrc).toContain('renderEditProfileDialog');
    });

    it('clamps theme brightness and computes viewport dimmer opacity accurately', () => {
        expect(clampThemeBrightness(100)).toBe(100);
        expect(clampThemeBrightness(75.4)).toBe(75);
        expect(clampThemeBrightness(10)).toBe(50);
        expect(clampThemeBrightness(150)).toBe(100);
        expect(clampThemeBrightness('invalid')).toBe(100);

        expect(computeDimOverlayOpacity(100)).toBe(0);
        expect(computeDimOverlayOpacity(80)).toBe(0.17);
        expect(computeDimOverlayOpacity(50)).toBe(0.425);

        const ctrl = useThemeBrightness();
        ctrl.resetThemeBrightness();
        expect(ctrl.themeBrightness.value).toBe(100);
        ctrl.stepThemeBrightness(-10);
        expect(ctrl.themeBrightness.value).toBe(90);
        expect(ctrl.dimOverlayOpacity.value).toBe(0.085);
        ctrl.resetThemeBrightness();
        expect(ctrl.themeBrightness.value).toBe(100);
        expect(ctrl.dimOverlayOpacity.value).toBe(0);
    });

    it('splits priority-plus nav items cleanly on whole-item boundaries with zero mid-character clipping', () => {
        const widths = [72, 86, 86, 86, 72, 72, 72, 86, 86, 72, 72, 98];

        // Wide container fits all 12 items without needing the More dropdown
        expect(computePriorityNavSplit(widths, 1100, { gap: 4, moreButtonWidth: 78 })).toBe(12);

        // Constrained container fits only whole leading items plus the More button strictly within containerWidth
        const visible = computePriorityNavSplit(widths, 760, { gap: 4, moreButtonWidth: 78 });
        expect(visible).toBeGreaterThan(0);
        expect(visible).toBeLessThan(widths.length);
        const visibleTotal = widths
            .slice(0, visible)
            .reduce((sum, w, idx) => sum + w + (idx > 0 ? 4 : 0), 0);
        expect(visibleTotal + 4 + 78).toBeLessThanOrEqual(760);
        // Adding one more item would overflow, proving the split is optimal
        expect(visibleTotal + 4 + widths[visible] + 4 + 78).toBeGreaterThan(760);

        // Ultra-narrow container collapses all items into More safely
        expect(computePriorityNavSplit(widths, 90, { gap: 4, moreButtonWidth: 78 })).toBe(0);
        expect(computePriorityNavSplit([], 500)).toBe(0);
    });

    it('opens the theme switcher dropdown on click and switches themes via DropdownMenuTrigger', async () => {
        const selected = ref('lookbook');
        const onSelect = vi.fn((theme) => {
            selected.value = theme;
            changeAppThemeStyle(theme);
        });

        const Harness = defineComponent({
            components: { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem },
            setup() {
                return { selected, onSelect };
            },
            template: `
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <button type="button" data-testid="theme-btn">Theme</button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                        <DropdownMenuCheckboxItem
                            data-testid="opt-archive"
                            :model-value="selected === 'archive'"
                            @select="onSelect('archive')">
                            Archive
                        </DropdownMenuCheckboxItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            `
        });

        const wrapper = mount(Harness, { attachTo: document.body });
        const trigger = wrapper.get('[data-testid="theme-btn"]');

        // Reka UI DropdownMenuTrigger opens on left-button click
        trigger.element.dispatchEvent(new MouseEvent('click', { button: 0, ctrlKey: false, bubbles: true }));
        await nextTick();
        await nextTick();

        expect(trigger.attributes('aria-expanded')).toBe('true');
        const option = document.body.querySelector('[data-testid="opt-archive"]');
        expect(option).not.toBeNull();
        option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await nextTick();

        expect(onSelect).toHaveBeenCalledWith('archive');
        expect(document.documentElement.getAttribute('data-theme')).toBe('archive');
        wrapper.unmount();
    });

    it('strictly scopes every CSS selector in lookbook.css and archive.css to its own data-theme and updates backgrounds for all 7 color palettes', () => {
        assertCssStrictlyScoped('src/styles/themes/lookbook.css', ":root[data-theme='lookbook']");
        assertCssStrictlyScoped('src/styles/themes/archive.css', ":root[data-theme='archive']");

        const lookbookCss = fs.readFileSync(path.resolve(process.cwd(), 'src/styles/themes/lookbook.css'), 'utf-8');
        const archiveCss = fs.readFileSync(path.resolve(process.cwd(), 'src/styles/themes/archive.css'), 'utf-8');
        for (const colorKey of ['blue', 'green', 'orange', 'red', 'rose', 'violet', 'yellow']) {
            expect(lookbookCss).toContain(`:root[data-theme='lookbook'][data-theme-color='${colorKey}']`);
            expect(archiveCss).toContain(`:root[data-theme='archive'][data-theme-color='${colorKey}']`);
        }
        expect((lookbookCss.match(/--lb-cream:/g) ?? []).length).toBeGreaterThanOrEqual(8);
        expect((archiveCss.match(/--arc-sky-bg:/g) ?? []).length).toBeGreaterThanOrEqual(8);
    });
});
