import { computed, ref } from 'vue';

export const MIN_THEME_BRIGHTNESS = 50;
export const MAX_THEME_BRIGHTNESS = 100;
export const THEME_BRIGHTNESS_STORAGE_KEY = 'vrcx-editorial-theme-brightness';
const LEGACY_BRIGHTNESS_STORAGE_KEY = 'vrcx-lookbook-brightness';

/**
 * Clamps a brightness percentage into the readable [50, 100] range.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampThemeBrightness(value) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) {
        return MAX_THEME_BRIGHTNESS;
    }
    return Math.min(MAX_THEME_BRIGHTNESS, Math.max(MIN_THEME_BRIGHTNESS, parsed));
}

/**
 * Computes the non-interactive viewport dimmer opacity from a brightness percentage.
 * Returns 0 at 100% so zero extra overlay DOM is rendered by default.
 *
 * @param {number} brightness
 * @returns {number}
 */
export function computeDimOverlayOpacity(brightness) {
    const safe = clampThemeBrightness(brightness);
    const dimRatio = (MAX_THEME_BRIGHTNESS - safe) / 100;
    return dimRatio > 0 ? Number((dimRatio * 0.85).toFixed(3)) : 0;
}

function readStoredBrightness() {
    try {
        const raw =
            localStorage.getItem(THEME_BRIGHTNESS_STORAGE_KEY) ??
            localStorage.getItem(LEGACY_BRIGHTNESS_STORAGE_KEY);
        if (raw !== null && raw !== '') {
            return clampThemeBrightness(raw);
        }
    } catch {
        // ignore storage access errors
    }
    return MAX_THEME_BRIGHTNESS;
}

const sharedThemeBrightness = ref(readStoredBrightness());

/**
 * Shared theme brightness state for the official anime-site themes (Lookbook & Azure Archive).
 * Persists across sessions and auto-removes the viewport dimmer when switching back to legacy themes.
 */
export function useThemeBrightness() {
    const setThemeBrightness = (value) => {
        const next = clampThemeBrightness(value);
        sharedThemeBrightness.value = next;
        try {
            localStorage.setItem(THEME_BRIGHTNESS_STORAGE_KEY, String(next));
        } catch {
            // ignore storage access errors
        }
    };

    const themeBrightnessSlider = computed({
        get: () => [sharedThemeBrightness.value],
        set: (value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (typeof next === 'number') {
                setThemeBrightness(next);
            }
        }
    });

    const stepThemeBrightness = (delta) => setThemeBrightness(sharedThemeBrightness.value + delta);
    const resetThemeBrightness = () => setThemeBrightness(MAX_THEME_BRIGHTNESS);
    const dimOverlayOpacity = computed(() => computeDimOverlayOpacity(sharedThemeBrightness.value));

    return {
        MIN_THEME_BRIGHTNESS,
        MAX_THEME_BRIGHTNESS,
        themeBrightness: sharedThemeBrightness,
        themeBrightnessSlider,
        dimOverlayOpacity,
        setThemeBrightness,
        stepThemeBrightness,
        resetThemeBrightness
    };
}
