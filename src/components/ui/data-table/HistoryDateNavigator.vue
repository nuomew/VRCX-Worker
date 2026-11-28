<template>
    <div class="inline-flex items-center gap-1" data-testid="history-date-navigator">
        <Button
            type="button"
            variant="outline"
            size="icon-sm"
            class="h-8 w-8"
            data-testid="history-date-prev"
            :title="t('table.pagination.date_prev')"
            :aria-label="t('table.pagination.date_prev')"
            :disabled="isBusy || !nav.canGoOlder.value"
            @click="handleGoOlder">
            <ChevronLeftIcon class="size-4" />
        </Button>

        <Popover v-model:open="popoverOpen">
            <PopoverTrigger as-child>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    class="h-8 gap-1.5 px-2.5 text-xs font-normal tabular-nums"
                    data-testid="history-date-trigger"
                    :disabled="disabled || nav.loadingIndex.value">
                    <Spinner v-if="nav.loadingIndex.value || nav.loadingMonth.value" class="size-3.5" />
                    <CalendarIcon v-else class="size-3.5" />
                    <span>{{ triggerLabel }}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent class="w-auto p-3" side="top" align="end">
                <div class="flex items-center justify-between gap-2 pb-2 mb-2 border-b border-border">
                    <div class="inline-flex rounded-md border border-border p-0.5 bg-muted/40">
                        <button
                            type="button"
                            data-testid="history-date-mode-day"
                            :class="[
                                'px-2.5 py-1 text-xs rounded-sm transition-colors cursor-pointer',
                                nav.mode.value === 'day'
                                    ? 'bg-background text-foreground shadow-xs font-medium'
                                    : 'text-muted-foreground hover:text-foreground'
                            ]"
                            :disabled="isBusy"
                            @click="handleModeSwitch('day')">
                            {{ t('table.pagination.date_mode_day') }}
                        </button>
                        <button
                            type="button"
                            data-testid="history-date-mode-month"
                            :class="[
                                'px-2.5 py-1 text-xs rounded-sm transition-colors cursor-pointer',
                                nav.mode.value === 'month'
                                    ? 'bg-background text-foreground shadow-xs font-medium'
                                    : 'text-muted-foreground hover:text-foreground'
                            ]"
                            :disabled="isBusy"
                            @click="handleModeSwitch('month')">
                            {{ t('table.pagination.date_mode_month') }}
                        </button>
                    </div>
                    <Button
                        v-if="!nav.isViewingLatest.value && nav.hasAvailableDates.value"
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="h-7 px-2 text-xs"
                        data-testid="history-date-latest"
                        :disabled="isBusy"
                        @click="handleGoLatest">
                        {{ t('table.pagination.date_latest') }}
                    </Button>
                </div>

                <div v-if="nav.loadingIndex.value && !nav.hasAvailableDates.value" class="py-8 px-6 text-center">
                    <Spinner class="mx-auto mb-2" />
                    <div class="text-xs text-muted-foreground">{{ t('table.pagination.date_loading') }}</div>
                </div>

                <div v-else-if="!nav.hasAvailableDates.value" class="py-6 px-6 text-center text-xs text-muted-foreground">
                    {{ t('table.pagination.date_no_records') }}
                </div>

                <template v-else-if="nav.mode.value === 'day'">
                    <div v-if="nav.months.value.length > 0" class="flex items-center gap-2 mb-2">
                        <span class="text-xs text-muted-foreground shrink-0">
                            {{ t('table.pagination.date_recorded_months') }}
                        </span>
                        <div class="flex-1 min-w-0 [&_[data-slot=native-select-wrapper]]:w-full">
                            <NativeSelect
                                class="h-8 py-0 pl-2.5 pr-9 text-xs leading-normal tabular-nums"
                                data-testid="history-date-month-jump"
                                :model-value="visibleMonthKey"
                                @update:modelValue="handleQuickMonthJump">
                                <NativeSelectOption
                                    v-for="item in nav.months.value"
                                    :key="item.month"
                                    :value="item.month">
                                    {{ item.month }} ({{ formatCompactCount(item.approxRows) }})
                                </NativeSelectOption>
                            </NativeSelect>
                        </div>
                    </div>

                    <Calendar
                        layout="month-and-year"
                        :model-value="calendarModelValue"
                        :placeholder="calendarPlaceholder"
                        :min-value="minCalendarDate"
                        :max-value="maxCalendarDate"
                        :locale="locale"
                        :week-starts-on="weekStartsOn"
                        :is-date-disabled="isCalendarDateDisabled"
                        :prevent-deselect="true"
                        class="p-0"
                        @update:placeholder="handlePlaceholderChange"
                        @update:modelValue="handleDaySelect" />

                    <div class="mt-2 pt-2 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                        <span v-if="nav.loadingMonth.value" class="inline-flex items-center gap-1.5">
                            <Spinner class="size-3" />
                            {{ t('table.pagination.date_loading') }}
                        </span>
                        <span v-else-if="visibleMonthDays.length > 0">
                            {{ t('table.pagination.date_month_days_count', { count: visibleMonthDays.length }) }}
                        </span>
                        <span v-else>
                            {{ t('table.pagination.date_no_records_month') }}
                        </span>
                    </div>
                </template>

                <template v-else>
                    <div class="max-h-72 w-[272px] overflow-y-auto pr-1 space-y-3" data-testid="history-month-list">
                        <div v-for="group in groupedMonthsByYear" :key="group.year">
                            <div class="text-xs font-medium text-muted-foreground mb-1.5 px-0.5">
                                {{ group.year }}
                            </div>
                            <div class="grid grid-cols-3 gap-1.5">
                                <button
                                    v-for="item in group.items"
                                    :key="item.month"
                                    type="button"
                                    :data-testid="`history-month-item-${item.month}`"
                                    :class="[
                                        'flex flex-col items-center justify-center rounded-md border px-2 py-1.5 text-xs transition-colors cursor-pointer',
                                        nav.selectedMonth.value === item.month
                                            ? 'bg-primary text-primary-foreground border-primary font-medium'
                                            : 'border-border bg-background hover:bg-accent hover:text-accent-foreground'
                                    ]"
                                    :disabled="isBusy"
                                    @click="handleMonthSelect(item.month)">
                                    <span>{{ item.monthLabel }}</span>
                                    <span
                                        :class="[
                                            'text-[10px] leading-tight mt-0.5 tabular-nums',
                                            nav.selectedMonth.value === item.month
                                                ? 'text-primary-foreground/80'
                                                : 'text-muted-foreground'
                                        ]">
                                        {{ formatCompactCount(item.approxRows) }}
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                </template>
            </PopoverContent>
        </Popover>

        <Button
            type="button"
            variant="outline"
            size="icon-sm"
            class="h-8 w-8"
            data-testid="history-date-next"
            :title="t('table.pagination.date_next')"
            :aria-label="t('table.pagination.date_next')"
            :disabled="isBusy || !nav.canGoNewer.value"
            @click="handleGoNewer">
            <ChevronRightIcon class="size-4" />
        </Button>
    </div>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { Calendar as CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-vue-next';
    import { CalendarDate, getLocalTimeZone, today } from '@internationalized/date';
    import { storeToRefs } from 'pinia';
    import { useI18n } from 'vue-i18n';

    import { Button } from '../button';
    import { Calendar } from '../calendar';
    import { NativeSelect, NativeSelectOption } from '../native-select';
    import { Popover, PopoverContent, PopoverTrigger } from '../popover';
    import { Spinner } from '../spinner';
    import { useAppearanceSettingsStore } from '@/stores/';

    const props = defineProps({
        nav: {
            type: Object,
            required: true
        },
        disabled: {
            type: Boolean,
            default: false
        }
    });

    const { t, locale } = useI18n();
    const appearanceSettingsStore = useAppearanceSettingsStore();
    const { weekStartsOn } = storeToRefs(appearanceSettingsStore);

    const popoverOpen = ref(false);
    const calendarPlaceholder = ref(today(getLocalTimeZone()));

    const isBusy = computed(() => props.disabled || props.nav.loadingIndex.value || props.nav.loadingMonth.value);

    function pad2(n) {
        return n < 10 ? `0${n}` : String(n);
    }

    function parseYmdToCalendarDate(ymd) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
        if (!m) return null;
        return new CalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
    }

    function parseYmToCalendarDate(ym, day = 1) {
        const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '').trim());
        if (!m) return null;
        return new CalendarDate(Number(m[1]), Number(m[2]), day);
    }

    function calendarDateToYmd(dateVal) {
        if (!dateVal || !Number.isFinite(dateVal.year)) return '';
        return `${dateVal.year}-${pad2(dateVal.month)}-${pad2(dateVal.day)}`;
    }

    function calendarDateToYm(dateVal) {
        if (!dateVal || !Number.isFinite(dateVal.year)) return '';
        return `${dateVal.year}-${pad2(dateVal.month)}`;
    }

    function formatCompactCount(count) {
        const n = Number(count || 0);
        if (!Number.isFinite(n) || n <= 0) return '0';
        if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
        return String(Math.round(n));
    }

    const triggerLabel = computed(() => {
        if (props.nav.mode.value === 'month') {
            return props.nav.selectedMonth.value || props.nav.maxMonth.value || t('table.pagination.date_select');
        }
        return props.nav.selectedDate.value || props.nav.latestDay.value || t('table.pagination.date_select');
    });

    const calendarModelValue = computed(() => parseYmdToCalendarDate(props.nav.selectedDate.value) ?? undefined);

    const minCalendarDate = computed(() => {
        const minDay = parseYmdToCalendarDate(props.nav.earliestDay.value);
        if (minDay) return minDay;
        const minYm = parseYmToCalendarDate(props.nav.minMonth.value, 1);
        return minYm ?? undefined;
    });

    const maxCalendarDate = computed(() => {
        const maxDay = parseYmdToCalendarDate(props.nav.latestDay.value);
        if (maxDay) return maxDay;
        return today(getLocalTimeZone());
    });

    const visibleMonthKey = computed(() => calendarDateToYm(calendarPlaceholder.value));

    const visibleMonthDays = computed(() => {
        const ym = visibleMonthKey.value;
        if (!ym) return [];
        return props.nav.getDaysForMonth(ym);
    });

    const groupedMonthsByYear = computed(() => {
        const groups = new Map();
        for (const item of props.nav.months.value) {
            const year = item.month.slice(0, 4);
            const monthNum = Number(item.month.slice(5, 7));
            const label = String(locale.value || '').startsWith('zh') ? `${monthNum}月` : item.month.slice(5, 7);
            const arr = groups.get(year) ?? [];
            arr.push({
                month: item.month,
                monthLabel: label,
                approxRows: item.approxRows
            });
            groups.set(year, arr);
        }
        return Array.from(groups.entries()).map(([year, items]) => ({ year, items }));
    });

    function isCalendarDateDisabled(dateVal) {
        const ymd = calendarDateToYmd(dateVal);
        if (!ymd) return true;
        return !props.nav.isDayRecorded(ymd);
    }

    function syncPlaceholderToSelected() {
        const target =
            parseYmdToCalendarDate(props.nav.selectedDate.value) ||
            parseYmToCalendarDate(props.nav.activeMonthKey.value, 1) ||
            today(getLocalTimeZone());
        calendarPlaceholder.value = target;
    }

    watch(popoverOpen, async (open) => {
        if (!open) return;
        await props.nav.ensureInitialized();
        syncPlaceholderToSelected();
        const ym = calendarDateToYm(calendarPlaceholder.value);
        if (ym) {
            await props.nav.ensureMonthDays(ym);
        }
    });

    watch(
        () => props.nav.selectedDate.value,
        (nextDay) => {
            const parsed = parseYmdToCalendarDate(nextDay);
            if (parsed) {
                calendarPlaceholder.value = parsed;
            }
        },
        { immediate: true }
    );

    async function handlePlaceholderChange(nextPlaceholder) {
        if (!nextPlaceholder) return;
        calendarPlaceholder.value = nextPlaceholder;
        const ym = calendarDateToYm(nextPlaceholder);
        if (ym) {
            await props.nav.ensureMonthDays(ym);
        }
    }

    async function handleQuickMonthJump(nextYm) {
        const ym = String(nextYm || '').trim();
        const parsed = parseYmToCalendarDate(ym, 1);
        if (!parsed) return;
        calendarPlaceholder.value = parsed;
        await props.nav.ensureMonthDays(ym);
    }

    async function handleDaySelect(dateVal) {
        const ymd = calendarDateToYmd(dateVal);
        if (!ymd || !props.nav.isDayRecorded(ymd)) return;
        popoverOpen.value = false;
        await props.nav.selectDay(ymd);
    }

    async function handleMonthSelect(ym) {
        popoverOpen.value = false;
        await props.nav.selectMonth(ym);
    }

    async function handleModeSwitch(nextMode) {
        await props.nav.setMode(nextMode);
        syncPlaceholderToSelected();
        const ym = calendarDateToYm(calendarPlaceholder.value);
        if (nextMode === 'day' && ym) {
            await props.nav.ensureMonthDays(ym);
        }
    }

    async function handleGoOlder() {
        await props.nav.goOlder();
    }

    async function handleGoNewer() {
        await props.nav.goNewer();
    }

    async function handleGoLatest() {
        popoverOpen.value = false;
        await props.nav.goLatest();
    }
</script>
