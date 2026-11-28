import { computed, markRaw, ref, shallowRef } from 'vue';
import dayjs from 'dayjs';

import { database } from '../services/database';

/**
 * Converts a local calendar day (`YYYY-MM-DD`) into exact UTC ISO start/end bounds.
 *
 * @param {string} dayStr
 * @returns {{ dateFrom: string; dateTo: string } | null}
 */
export function localDayToDateBounds(dayStr) {
    const clean = String(dayStr || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return null;
    const d = dayjs(clean);
    if (!d.isValid()) return null;
    return {
        dateFrom: d.startOf('day').toISOString(),
        dateTo: d.endOf('day').toISOString()
    };
}

/**
 * Converts a local calendar month (`YYYY-MM`) into exact UTC ISO start/end bounds.
 *
 * @param {string} monthStr
 * @returns {{ dateFrom: string; dateTo: string } | null}
 */
export function localMonthToDateBounds(monthStr) {
    const clean = String(monthStr || '').trim();
    if (!/^\d{4}-\d{2}$/.test(clean)) return null;
    const d = dayjs(`${clean}-01`);
    if (!d.isValid()) return null;
    return {
        dateFrom: d.startOf('month').toISOString(),
        dateTo: d.endOf('month').toISOString()
    };
}

/**
 * Shared date-navigation state controller for cloud history tables (`feed`, `gamelog`, `friendlog`, `notifications`).
 * Queries `/api/history/dates` to discover only months & days that actually contain records in the user's database
 * and supports previous/next recorded-day (including cross-month) and month-level switching.
 *
 * @param {'feed' | 'gamelog' | 'friendlog' | 'notifications'} scope
 * @param {(selection: { mode: 'day' | 'month'; value: string; dateFrom: string; dateTo: string }) => Promise<void> | void} onSelectionChange
 */
export function createHistoryDateController(scope, onSelectionChange) {
    const mode = ref(/** @type {'day' | 'month'} */ ('day'));
    const selectedDate = ref('');
    const selectedMonth = ref('');
    const months = shallowRef(/** @type {Array<{ month: string; approxRows: number }>} */ ([]));
    const daysByMonth = ref(/** @type {Record<string, string[]>} */ ({}));
    const minMonth = ref('');
    const maxMonth = ref('');
    const earliestDay = ref('');
    const latestDay = ref('');
    const loadingIndex = ref(false);
    const loadingMonth = ref(false);
    const initialized = ref(false);

    let initInflight = null;
    const monthInflight = new Map();

    const enabled = computed(
        () => Boolean(database.supportsHistoryDateNavigation && typeof database.getHistoryDates === 'function')
    );

    const activeMonthKey = computed(() => {
        if (mode.value === 'month') {
            return selectedMonth.value || maxMonth.value || months.value[0]?.month || '';
        }
        return (selectedDate.value ? selectedDate.value.slice(0, 7) : '') || selectedMonth.value || maxMonth.value || '';
    });

    const currentBounds = computed(() => {
        if (mode.value === 'month' && selectedMonth.value) {
            return localMonthToDateBounds(selectedMonth.value);
        }
        if (mode.value === 'day' && selectedDate.value) {
            return localDayToDateBounds(selectedDate.value);
        }
        return null;
    });

    const hasAvailableDates = computed(() => months.value.length > 0 || Boolean(latestDay.value));

    const isViewingLatest = computed(() => {
        if (mode.value === 'month') {
            return !maxMonth.value || selectedMonth.value === maxMonth.value;
        }
        return !latestDay.value || selectedDate.value === latestDay.value;
    });

    const canGoOlder = computed(() => {
        if (!hasAvailableDates.value) return false;
        if (mode.value === 'month') {
            const cur = selectedMonth.value;
            if (!cur) return false;
            return months.value.some((m) => m.month < cur);
        }
        const cur = selectedDate.value;
        if (!cur) return false;
        const ym = cur.slice(0, 7);
        const days = daysByMonth.value[ym];
        if (Array.isArray(days) && days.some((d) => d < cur)) {
            return true;
        }
        if (months.value.some((m) => m.month < ym)) {
            return true;
        }
        return Boolean(earliestDay.value && cur > earliestDay.value);
    });

    const canGoNewer = computed(() => {
        if (!hasAvailableDates.value) return false;
        if (mode.value === 'month') {
            const cur = selectedMonth.value;
            if (!cur) return false;
            return months.value.some((m) => m.month > cur);
        }
        const cur = selectedDate.value;
        if (!cur) return false;
        const ym = cur.slice(0, 7);
        const days = daysByMonth.value[ym];
        if (Array.isArray(days) && days.some((d) => d > cur)) {
            return true;
        }
        if (months.value.some((m) => m.month > ym)) {
            return true;
        }
        return Boolean(latestDay.value && cur < latestDay.value);
    });

    function reset() {
        mode.value = 'day';
        selectedDate.value = '';
        selectedMonth.value = '';
        months.value = [];
        daysByMonth.value = {};
        minMonth.value = '';
        maxMonth.value = '';
        earliestDay.value = '';
        latestDay.value = '';
        loadingIndex.value = false;
        loadingMonth.value = false;
        initialized.value = false;
        initInflight = null;
        monthInflight.clear();
    }

    function getMaxAllowedDayStr() {
        return dayjs().add(1, 'day').format('YYYY-MM-DD');
    }

    function isValidRecordedDay(dayStr) {
        return (
            typeof dayStr === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(dayStr) &&
            dayStr >= '2014-01-01' &&
            dayStr <= getMaxAllowedDayStr()
        );
    }

    function isValidRecordedMonth(monthStr) {
        return (
            typeof monthStr === 'string' &&
            /^\d{4}-\d{2}$/.test(monthStr) &&
            monthStr >= '2014-01' &&
            monthStr <= getMaxAllowedDayStr().slice(0, 7)
        );
    }

    /**
     * Records a newly arrived local event timestamp so today's date appears immediately without re-fetching index.
     *
     * @param {string} isoTs
     */
    function registerRecordedTimestamp(isoTs) {
        if (!isoTs || !initialized.value) return;
        const d = dayjs(isoTs);
        if (!d.isValid()) return;
        const day = d.format('YYYY-MM-DD');
        if (!isValidRecordedDay(day)) return;
        const ym = day.slice(0, 7);
        if (!latestDay.value || day > latestDay.value) latestDay.value = day;
        if (!earliestDay.value || day < earliestDay.value) earliestDay.value = day;
        if (!maxMonth.value || ym > maxMonth.value) maxMonth.value = ym;
        if (!minMonth.value || ym < minMonth.value) minMonth.value = ym;

        if (!months.value.some((m) => m.month === ym)) {
            months.value = [...months.value, { month: ym, approxRows: 1 }].sort((a, b) =>
                b.month.localeCompare(a.month)
            );
        }
        const existingDays = daysByMonth.value[ym];
        if (Array.isArray(existingDays) && !existingDays.includes(day)) {
            daysByMonth.value = {
                ...daysByMonth.value,
                [ym]: [...existingDays, day].sort()
            };
        }
    }

    async function ensureInitialized(force = false) {
        if (!enabled.value) return null;
        if (initialized.value && !force) {
            return currentBounds.value;
        }
        if (initInflight && !force) {
            return initInflight;
        }
        loadingIndex.value = true;
        const req = (async () => {
            try {
                const res = await database.getHistoryDates(scope, {
                    tzOffsetMinutes: new Date().getTimezoneOffset()
                });
                if (!res || typeof res !== 'object') {
                    return null;
                }
                const nextMonths = Array.isArray(res.months)
                    ? res.months
                          .filter((m) => m && isValidRecordedMonth(m.month))
                          .sort((a, b) => b.month.localeCompare(a.month))
                    : [];
                months.value = nextMonths;
                const rawMinMonth = String(res.minMonth || '');
                const rawMaxMonth = String(res.maxMonth || '');
                minMonth.value =
                    (isValidRecordedMonth(rawMinMonth) ? rawMinMonth : '') ||
                    (nextMonths.length > 0 ? nextMonths[nextMonths.length - 1].month : '');
                maxMonth.value =
                    (isValidRecordedMonth(rawMaxMonth) ? rawMaxMonth : '') ||
                    (nextMonths.length > 0 ? nextMonths[0].month : '');
                const rawEarliest = String(res.earliestDay || '');
                const rawLatest = String(res.latestDay || '');
                earliestDay.value = isValidRecordedDay(rawEarliest) ? rawEarliest : '';
                latestDay.value = isValidRecordedDay(rawLatest) ? rawLatest : '';

                const rawActiveYm = String(res.activeMonth || '');
                const activeYm = (isValidRecordedMonth(rawActiveYm) ? rawActiveYm : '') || maxMonth.value || '';
                let resolvedDays = Array.isArray(res.days)
                    ? res.days.filter((d) => isValidRecordedDay(d)).sort()
                    : [];
                if (activeYm && rawActiveYm !== activeYm) {
                    // Server's activeMonth was a bogus future month; fetch exact days for the newest valid month instead.
                    const monthRes = await database
                        .getHistoryDates(scope, {
                            tzOffsetMinutes: new Date().getTimezoneOffset(),
                            month: activeYm
                        })
                        .catch(() => null);
                    resolvedDays = Array.isArray(monthRes?.days)
                        ? monthRes.days.filter((d) => isValidRecordedDay(d)).sort()
                        : [];
                }
                if (activeYm) {
                    daysByMonth.value = {
                        ...daysByMonth.value,
                        [activeYm]: resolvedDays
                    };
                }
                const todayStr = dayjs().format('YYYY-MM-DD');
                const nonFutureDays = resolvedDays.filter((d) => d <= todayStr);
                const pickedDay =
                    (nonFutureDays.length > 0 ? nonFutureDays[nonFutureDays.length - 1] : '') ||
                    (resolvedDays.length > 0 ? resolvedDays[resolvedDays.length - 1] : '') ||
                    latestDay.value ||
                    '';
                if (pickedDay && (!latestDay.value || pickedDay > latestDay.value)) {
                    latestDay.value = pickedDay;
                }
                if (!selectedDate.value && pickedDay) {
                    selectedDate.value = pickedDay;
                }
                if (!selectedMonth.value && activeYm) {
                    selectedMonth.value = activeYm;
                }
                initialized.value = true;
                return currentBounds.value;
            } catch (err) {
                console.warn(`[historyDateNav:${scope}] Failed to load date index:`, err);
                return null;
            } finally {
                loadingIndex.value = false;
                initInflight = null;
            }
        })();
        initInflight = req;
        return req;
    }

    async function ensureMonthDays(monthStr, force = false) {
        if (!enabled.value) return [];
        const clean = String(monthStr || '').trim();
        if (!isValidRecordedMonth(clean)) return [];
        if (!force && Array.isArray(daysByMonth.value[clean])) {
            return daysByMonth.value[clean];
        }
        const existingInflight = monthInflight.get(clean);
        if (existingInflight && !force) {
            return existingInflight;
        }
        loadingMonth.value = true;
        const req = (async () => {
            try {
                const res = await database.getHistoryDates(scope, {
                    tzOffsetMinutes: new Date().getTimezoneOffset(),
                    month: clean
                });
                const days = Array.isArray(res?.days)
                    ? res.days.filter((d) => isValidRecordedDay(d)).sort()
                    : [];
                daysByMonth.value = {
                    ...daysByMonth.value,
                    [clean]: days
                };
                return days;
            } catch (err) {
                console.warn(`[historyDateNav:${scope}] Failed to load month days (${clean}):`, err);
                return [];
            } finally {
                monthInflight.delete(clean);
                if (monthInflight.size === 0) {
                    loadingMonth.value = false;
                }
            }
        })();
        monthInflight.set(clean, req);
        return req;
    }

    async function selectDay(dayStr, { notify = true } = {}) {
        const bounds = localDayToDateBounds(dayStr);
        if (!bounds) return;
        mode.value = 'day';
        selectedDate.value = dayStr;
        selectedMonth.value = dayStr.slice(0, 7);
        if (notify && typeof onSelectionChange === 'function') {
            await onSelectionChange({
                mode: 'day',
                value: dayStr,
                dateFrom: bounds.dateFrom,
                dateTo: bounds.dateTo
            });
        }
    }

    async function selectMonth(monthStr, { notify = true } = {}) {
        const bounds = localMonthToDateBounds(monthStr);
        if (!bounds) return;
        mode.value = 'month';
        selectedMonth.value = monthStr;
        if (notify && typeof onSelectionChange === 'function') {
            await onSelectionChange({
                mode: 'month',
                value: monthStr,
                dateFrom: bounds.dateFrom,
                dateTo: bounds.dateTo
            });
        }
    }

    async function setMode(nextMode) {
        if (nextMode !== 'day' && nextMode !== 'month') return;
        if (nextMode === mode.value) return;
        await ensureInitialized();
        if (nextMode === 'month') {
            const targetMonth =
                (selectedDate.value ? selectedDate.value.slice(0, 7) : '') ||
                selectedMonth.value ||
                maxMonth.value ||
                months.value[0]?.month ||
                '';
            if (targetMonth) {
                await selectMonth(targetMonth);
            } else {
                mode.value = 'month';
            }
            return;
        }
        // Switching from month -> day: pick the newest recorded day inside the currently selected month
        const targetMonth = selectedMonth.value || maxMonth.value || months.value[0]?.month || '';
        if (targetMonth) {
            const days = await ensureMonthDays(targetMonth);
            const pickedDay =
                (selectedDate.value && selectedDate.value.startsWith(targetMonth) && days.includes(selectedDate.value)
                    ? selectedDate.value
                    : '') ||
                (days.length > 0 ? days[days.length - 1] : '') ||
                latestDay.value ||
                '';
            if (pickedDay) {
                await selectDay(pickedDay);
                return;
            }
        }
        if (latestDay.value) {
            await selectDay(latestDay.value);
        } else {
            mode.value = 'day';
        }
    }

    async function goOlder() {
        await ensureInitialized();
        if (mode.value === 'month') {
            const cur = selectedMonth.value;
            const older = months.value.find((m) => m.month < cur);
            if (older) {
                await selectMonth(older.month);
            }
            return;
        }
        const cur = selectedDate.value;
        if (!cur) return;
        const curYm = cur.slice(0, 7);
        const curDays = await ensureMonthDays(curYm);
        for (let i = curDays.length - 1; i >= 0; i--) {
            if (curDays[i] < cur) {
                await selectDay(curDays[i]);
                return;
            }
        }
        // Step into earlier recorded months until we find a month with actual days
        const olderMonths = months.value.filter((m) => m.month < curYm);
        for (const m of olderMonths) {
            const days = await ensureMonthDays(m.month);
            if (days.length > 0) {
                await selectDay(days[days.length - 1]);
                return;
            }
        }
    }

    async function goNewer() {
        await ensureInitialized();
        if (mode.value === 'month') {
            const cur = selectedMonth.value;
            const newerMonths = months.value.filter((m) => m.month > cur);
            if (newerMonths.length > 0) {
                await selectMonth(newerMonths[newerMonths.length - 1].month);
            }
            return;
        }
        const cur = selectedDate.value;
        if (!cur) return;
        const curYm = cur.slice(0, 7);
        const curDays = await ensureMonthDays(curYm);
        for (let i = 0; i < curDays.length; i++) {
            if (curDays[i] > cur) {
                await selectDay(curDays[i]);
                return;
            }
        }
        // Step into newer recorded months (ascending order)
        const newerMonths = months.value.filter((m) => m.month > curYm).reverse();
        for (const m of newerMonths) {
            const days = await ensureMonthDays(m.month);
            if (days.length > 0) {
                await selectDay(days[0]);
                return;
            }
        }
    }

    async function goLatest() {
        await ensureInitialized(true);
        if (mode.value === 'month') {
            const newest = maxMonth.value || months.value[0]?.month || '';
            if (newest) await selectMonth(newest);
            return;
        }
        if (latestDay.value) {
            await selectDay(latestDay.value);
        }
    }

    function isDayRecorded(dayStr) {
        const ym = String(dayStr || '').slice(0, 7);
        const list = daysByMonth.value[ym];
        if (!Array.isArray(list)) return false;
        return list.includes(dayStr);
    }

    function getDaysForMonth(monthStr) {
        const list = daysByMonth.value[monthStr];
        return Array.isArray(list) ? list : [];
    }

    // Wrap with markRaw so Pinia setup stores do not deeply unwrap the nested refs/computeds via reactive().
    return markRaw({
        scope,
        enabled,
        mode,
        selectedDate,
        selectedMonth,
        activeMonthKey,
        months,
        daysByMonth,
        minMonth,
        maxMonth,
        earliestDay,
        latestDay,
        loadingIndex,
        loadingMonth,
        initialized,
        currentBounds,
        hasAvailableDates,
        isViewingLatest,
        canGoOlder,
        canGoNewer,
        reset,
        registerRecordedTimestamp,
        ensureInitialized,
        ensureMonthDays,
        selectDay,
        selectMonth,
        setMode,
        goOlder,
        goNewer,
        goLatest,
        isDayRecorded,
        getDaysForMonth
    });
}
