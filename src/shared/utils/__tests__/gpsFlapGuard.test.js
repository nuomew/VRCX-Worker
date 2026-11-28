import { beforeEach, describe, expect, test } from 'vitest';
import {
    clearFriendGpsFlapState,
    normalizeLocationForFlapGuard,
    resetAllFriendGpsFlapState,
    shouldSuppressFriendGpsFeed
} from '../gpsFlapGuard';

describe('gpsFlapGuard (client-side silent dual-box protection)', () => {
    const locX = 'wrld_00000000-0000-0000-0000-000000000000:10~public';
    const locA = 'wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1001~friends(usr_a)~region(jp)';
    const locB = 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:2002~friends(usr_b)~region(jp)';
    const locC = 'wrld_cccccccc-cccc-cccc-cccc-cccccccccccc:3003~public~region(jp)';
    const t0 = Date.parse('2026-11-28T01:50:00.000Z');
    const atMin = (m) => t0 + m * 60_000;

    beforeEach(() => {
        resetAllFriendGpsFlapState();
    });

    test('strips transient ~nonce tokens while preserving distinct instance IDs', () => {
        expect(normalizeLocationForFlapGuard(`${locA}~nonce(abcdef01)`)).toBe(locA);
        expect(normalizeLocationForFlapGuard('private')).toBe('private');
        expect(normalizeLocationForFlapGuard('offline')).toBe('');
        expect(normalizeLocationForFlapGuard('traveling')).toBe('');
    });

    test('allows normal world hopping and single A -> B -> A round-trips without false positives', () => {
        expect(shouldSuppressFriendGpsFeed('usr_norm', { location: locA, previousLocation: locX, nowMs: atMin(0) })).toBe(false);
        expect(shouldSuppressFriendGpsFeed('usr_norm', { location: locB, previousLocation: locA, nowMs: atMin(2) })).toBe(false);
        expect(shouldSuppressFriendGpsFeed('usr_norm', { location: locA, previousLocation: locB, nowMs: atMin(4) })).toBe(false);
        expect(shouldSuppressFriendGpsFeed('usr_norm', { location: locC, previousLocation: locA, nowMs: atMin(6) })).toBe(false);
    });

    test('suppresses A <-> B ping-pong from 3rd alternating hop, extends on flip, recovers on 3rd room C, cooldown expiry, or offline', () => {
        // 1st hop A -> B (allowed)
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(1) })).toBe(false);
        // 2nd hop B -> A (allowed)
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locA, previousLocation: locB, nowMs: atMin(2) })).toBe(false);
        // 3rd alternating hop A -> B -> locked & suppressed
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(3) })).toBe(true);
        // Ongoing flips extend 30m TTL and stay suppressed
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locA, previousLocation: locB, nowMs: atMin(4) })).toBe(true);
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(5) })).toBe(true);

        // Jumping to genuine 3rd room C unlocks immediately
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locC, previousLocation: locA, nowMs: atMin(6) })).toBe(false);

        // Lock again and test steady cooldown expiry (no flips for 30m)
        resetAllFriendGpsFlapState();
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(0) })).toBe(false);
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locA, previousLocation: locB, nowMs: atMin(1) })).toBe(false);
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(2) })).toBe(true);
        // Steady in B at +15m (still suppressed, no TTL renewal)
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(15) })).toBe(true);
        // After +33m (> 30m since last flip at +2m), unlocked cleanly
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(33) })).toBe(false);

        // Offline clear resets immediately
        resetAllFriendGpsFlapState();
        shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(0) });
        shouldSuppressFriendGpsFeed('usr_dual', { location: locA, previousLocation: locB, nowMs: atMin(1) });
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(2) })).toBe(true);
        clearFriendGpsFlapState('usr_dual');
        expect(shouldSuppressFriendGpsFeed('usr_dual', { location: locB, previousLocation: locA, nowMs: atMin(3) })).toBe(false);
    });

    test('deduplicates same normalized instance within 3 minutes and caps burst writes at 6 per 10 minutes', () => {
        expect(shouldSuppressFriendGpsFeed('usr_dupe', { location: locA, previousLocation: locX, nowMs: atMin(0) })).toBe(false);
        expect(
            shouldSuppressFriendGpsFeed('usr_dupe', {
                location: `${locA}~nonce(9999)`,
                previousLocation: locB,
                nowMs: atMin(2)
            })
        ).toBe(true);

        for (let i = 0; i < 6; i++) {
            const suppressed = shouldSuppressFriendGpsFeed('usr_burst', {
                location: `wrld_11111111-1111-1111-1111-11111111111${i}:${100 + i}`,
                previousLocation: i === 0 ? locX : `wrld_11111111-1111-1111-1111-11111111111${i - 1}:${99 + i}`,
                nowMs: atMin(i)
            });
            expect(suppressed).toBe(false);
        }
        // 7th distinct room inside 10 min is rate-limited
        expect(
            shouldSuppressFriendGpsFeed('usr_burst', {
                location: locC,
                previousLocation: 'wrld_11111111-1111-1111-1111-111111111115:105',
                nowMs: atMin(7)
            })
        ).toBe(true);
        // After 10 min window slides past initial event, writes resume
        expect(
            shouldSuppressFriendGpsFeed('usr_burst', {
                location: locC,
                previousLocation: 'wrld_11111111-1111-1111-1111-111111111115:105',
                nowMs: atMin(11)
            })
        ).toBe(false);
    });
});
