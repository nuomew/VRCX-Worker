import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

/**
 * Pure priority-plus split calculator: computes how many navigation items fit
 * completely inside `containerWidth` without ever slicing an item mid-character.
 *
 * @param {number[]} itemWidths - Measured pixel widths of each nav item in order.
 * @param {number} containerWidth - Available inner pixel width of the nav rail.
 * @param {{ gap?: number; moreButtonWidth?: number }} [options]
 * @returns {number} Number of leading items that fit cleanly (0..itemWidths.length).
 */
export function computePriorityNavSplit(itemWidths, containerWidth, { gap = 4, moreButtonWidth = 76 } = {}) {
    const count = Array.isArray(itemWidths) ? itemWidths.length : 0;
    if (count === 0) return 0;
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) return count;

    // First check if every item fits without needing a "More" button at all.
    let totalAll = 0;
    for (let i = 0; i < count; i++) {
        totalAll += itemWidths[i] + (i > 0 ? gap : 0);
    }
    if (totalAll <= containerWidth + 0.5) {
        return count;
    }

    // Otherwise reserve space for the "More" dropdown button and keep only whole items that fit.
    const budget = Math.max(0, containerWidth - moreButtonWidth - gap);
    let used = 0;
    let visible = 0;
    for (let i = 0; i < count; i++) {
        const nextWidth = itemWidths[i] + (visible > 0 ? gap : 0);
        if (used + nextWidth > budget + 0.5) {
            break;
        }
        used += nextWidth;
        visible += 1;
    }
    return visible;
}

/**
 * Measures a hidden mirror row of nav items (plus the live localized "More" button)
 * and splits `menuItems` into `visibleMenuItems` + `overflowMenuItems` whenever
 * the nav container resizes, locale changes, or menu items update.
 *
 * @param {{
 *   menuItems: import('vue').Ref<any[]>;
 *   activeMenuIndex: import('vue').Ref<string>;
 *   isNavItemNotified: (item: any) => boolean;
 *   locale?: import('vue').Ref<string>;
 *   gap?: number;
 *   moreButtonWidth?: number;
 * }} params
 */
export function usePriorityNav({
    menuItems,
    activeMenuIndex,
    isNavItemNotified,
    locale,
    gap = 4,
    moreButtonWidth = 78
}) {
    const navContainerRef = ref(null);
    const navMeasureRef = ref(null);
    const visibleCount = ref(999);
    let resizeObserver = null;
    let disposed = false;

    const recalcVisibleCount = () => {
        if (disposed) return;
        const container = navContainerRef.value;
        const measure = navMeasureRef.value;
        const items = menuItems.value || [];
        if (!items.length) {
            visibleCount.value = 0;
            return;
        }
        if (!container || !measure) {
            visibleCount.value = items.length;
            return;
        }

        // Subtract horizontal padding (clientWidth includes padding) without artificially inflating item widths.
        let padX = 0;
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            const style = window.getComputedStyle(container);
            padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        }
        const available = container.clientWidth - padX;
        if (available <= 0) {
            visibleCount.value = items.length;
            return;
        }

        const itemEls = Array.from(measure.querySelectorAll('[data-priority-item]'));
        if (itemEls.length !== items.length) {
            visibleCount.value = items.length;
            return;
        }

        const moreEl = measure.querySelector('[data-priority-more]');
        const measuredMoreWidth = moreEl ? moreEl.getBoundingClientRect().width : 0;
        const effectiveMoreWidth = measuredMoreWidth > 0 ? measuredMoreWidth : moreButtonWidth;

        const widths = itemEls.map((el) => el.getBoundingClientRect().width);
        visibleCount.value = computePriorityNavSplit(widths, available, {
            gap,
            moreButtonWidth: effectiveMoreWidth
        });
    };

    const scheduleRecalc = async () => {
        await nextTick();
        recalcVisibleCount();
    };

    const visibleMenuItems = computed(() => (menuItems.value || []).slice(0, visibleCount.value));
    const overflowMenuItems = computed(() => (menuItems.value || []).slice(visibleCount.value));

    const hasActiveOverflow = computed(() =>
        overflowMenuItems.value.some(
            (item) =>
                item.index === activeMenuIndex.value ||
                Boolean(item.children?.some((entry) => entry.index === activeMenuIndex.value))
        )
    );

    const hasNotifiedOverflow = computed(() => overflowMenuItems.value.some((item) => isNavItemNotified(item)));

    watch(menuItems, scheduleRecalc, { deep: true });
    if (locale) {
        watch(locale, scheduleRecalc);
    }

    onMounted(() => {
        scheduleRecalc();
        if (typeof ResizeObserver !== 'undefined' && navContainerRef.value) {
            resizeObserver = new ResizeObserver(() => recalcVisibleCount());
            resizeObserver.observe(navContainerRef.value);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', recalcVisibleCount);
        }
        if (typeof document !== 'undefined' && document.fonts?.ready) {
            document.fonts.ready.then(() => recalcVisibleCount()).catch(() => {});
        }
    });

    onUnmounted(() => {
        disposed = true;
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', recalcVisibleCount);
        }
    });

    return {
        navContainerRef,
        navMeasureRef,
        visibleMenuItems,
        overflowMenuItems,
        hasActiveOverflow,
        hasNotifiedOverflow,
        recalcVisibleCount,
        scheduleRecalc
    };
}
