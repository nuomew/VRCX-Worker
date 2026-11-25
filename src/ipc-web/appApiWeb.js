import { cloudFetch, onCloudGameLogEvent } from './apiClient.js';
import { bootstrapCache, flushStorageNow, scheduleStoragePatch } from './bootstrapCache.js';
import {
    cloudState,
    getAggregatedGameState,
    getPrimaryAgentState,
    isAnyAgentOnline,
    syncGameRunningBridge
} from './cloudState.js';
import {
    clearActiveCloudGameLogRowMeta,
    clearCloudActivitySyncStateCache,
    setActiveCloudGameLogRowMeta,
    setSuppressCloudGameLogWrites
} from '../services/database/cloud/index.js';

/**
 * Lightweight RFC 1321 MD5 returning Base64 (used by imageUploadCoordinator for VRChat file uploads).
 *
 * @param {Uint8Array} input
 * @returns {string}
 */
function md5Base64(input) {
    const k = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
        k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    }
    const s = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
        20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
        10, 15, 21
    ];

    const bitLen = input.length * 8;
    const paddedLen = (((input.length + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(paddedLen);
    buf.set(input);
    buf[input.length] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(paddedLen - 8, bitLen >>> 0, true);
    view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < paddedLen; offset += 64) {
        const m = new Uint32Array(16);
        for (let j = 0; j < 16; j++) {
            m[j] = view.getUint32(offset + j * 4, true);
        }
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let i = 0; i < 64; i++) {
            let f;
            let g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const temp = d;
            d = c;
            c = b;
            const sum = (a + f + k[i] + m[g]) >>> 0;
            const rot = ((sum << s[i]) | (sum >>> (32 - s[i]))) >>> 0;
            b = (b + rot) >>> 0;
            a = temp;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    const digest = new Uint8Array(16);
    const dv = new DataView(digest.buffer);
    dv.setUint32(0, a0, true);
    dv.setUint32(4, b0, true);
    dv.setUint32(8, c0, true);
    dv.setUint32(12, d0, true);
    return btoa(String.fromCharCode(...digest));
}

function base64ToBytes(b64) {
    const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

function bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(bin);
}

const MASK64 = 0xffffffffffffffffn;
const BLAKE2B_IV = [
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n,
    0x9b05688c2b3e6c1fn,
    0x1f83d9abfb41bd6bn,
    0x5be0cd19137e2179n
];
const BLAKE2B_SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]
];

/**
 * @param {bigint} x
 * @param {bigint} n
 * @returns {bigint}
 */
function rotr64(x, n) {
    return ((x >> n) | ((x << (64n - n)) & MASK64)) & MASK64;
}

/**
 * Pure-JS RFC 7693 BLAKE2b-256 hash (32-byte digest, unkeyed).
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
function blake2b256(input) {
    const outlen = 32;
    const h = BLAKE2B_IV.slice();
    h[0] ^= 0x01010000n ^ BigInt(outlen);

    /** @type {bigint[]} */
    const v = new Array(16).fill(0n);
    /** @type {bigint[]} */
    const m = new Array(16).fill(0n);
    const block = new Uint8Array(128);
    const blockView = new DataView(block.buffer);

    /**
     * @param {number} a
     * @param {number} b
     * @param {number} c
     * @param {number} d
     * @param {bigint} x
     * @param {bigint} y
     */
    const mix = (a, b, c, d, x, y) => {
        v[a] = (v[a] + v[b] + x) & MASK64;
        v[d] = rotr64(v[d] ^ v[a], 32n);
        v[c] = (v[c] + v[d]) & MASK64;
        v[b] = rotr64(v[b] ^ v[c], 24n);
        v[a] = (v[a] + v[b] + y) & MASK64;
        v[d] = rotr64(v[d] ^ v[a], 16n);
        v[c] = (v[c] + v[d]) & MASK64;
        v[b] = rotr64(v[b] ^ v[c], 63n);
    };

    const compress = (bytesRead, isLast) => {
        for (let i = 0; i < 16; i++) {
            m[i] = blockView.getBigUint64(i * 8, true);
        }
        for (let i = 0; i < 8; i++) {
            v[i] = h[i];
            v[i + 8] = BLAKE2B_IV[i];
        }
        v[12] ^= BigInt(bytesRead) & MASK64;
        if (isLast) {
            v[14] ^= MASK64;
        }
        for (let r = 0; r < 12; r++) {
            const s = BLAKE2B_SIGMA[r % 10];
            mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
            mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
            mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
            mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
            mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
            mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
            mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
            mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
        }
        for (let i = 0; i < 8; i++) {
            h[i] ^= v[i] ^ v[i + 8];
        }
    };

    let offset = 0;
    while (input.length - offset > 128) {
        block.set(input.subarray(offset, offset + 128));
        offset += 128;
        compress(offset, false);
    }
    block.fill(0);
    const remaining = input.length - offset;
    if (remaining > 0) {
        block.set(input.subarray(offset));
    }
    compress(input.length, true);

    const out = new Uint8Array(outlen);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) {
        outView.setBigUint64(i * 8, h[i], true);
    }
    return out;
}

/**
 * Computes a byte-identical librsync BLAKE2b signature matching desktop `librsync.net.dll`
 * (`RS_BLAKE2_SIG_MAGIC = 0x72730137`, `blockLength = 2048`, `strongSumLength = 32`).
 *
 * @param {Uint8Array} fileBytes
 * @returns {Uint8Array}
 */
export function computeLibrsyncSignature(fileBytes) {
    const BLOCK_LEN = 2048;
    const STRONG_LEN = 32;
    const CHAR_OFFSET = 31;
    const blockCount = fileBytes.length === 0 ? 0 : Math.ceil(fileBytes.length / BLOCK_LEN);
    const out = new Uint8Array(12 + blockCount * (4 + STRONG_LEN));
    const dv = new DataView(out.buffer);

    // Big-endian header: magic (0x72730137), blockLength (2048), strongSumLength (32)
    dv.setUint32(0, 0x72730137, false);
    dv.setUint32(4, BLOCK_LEN, false);
    dv.setUint32(8, STRONG_LEN, false);

    let writePos = 12;
    for (let offset = 0; offset < fileBytes.length; offset += BLOCK_LEN) {
        const chunk = fileBytes.subarray(offset, Math.min(offset + BLOCK_LEN, fileBytes.length));
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < chunk.length; i++) {
            s1 = (s1 + chunk[i] + CHAR_OFFSET) & 0xffff;
            s2 = (s2 + s1) & 0xffff;
        }
        dv.setUint32(writePos, ((s2 << 16) | s1) >>> 0, false);
        writePos += 4;
        const strong = blake2b256(chunk);
        out.set(strong, writePos);
        writePos += STRONG_LEN;
    }
    return out;
}

/**
 * Deterministic 16-bit hue hash matching VRCX desktop user colour assignment.
 *
 * @param {string} userId
 * @returns {number}
 */
function hashUserIdToHue(userId) {
    let hash = 2166136261;
    const str = String(userId || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash % 65536;
}

const VRCHAT_MAX_UPLOAD_DIM = 2000;
const VRCHAT_MAX_PRINT_WIDTH = 1920;
const VRCHAT_MAX_PRINT_HEIGHT = 1080;
const VRCHAT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function isPngBytes(bytes) {
    return (
        bytes.byteLength >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    );
}

function sniffImageMimeFromBytes(bytes) {
    if (isPngBytes(bytes)) return 'image/png';
    if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (
        bytes.byteLength >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    if (bytes.byteLength >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    return 'image/png';
}

function detectWhiteBorderCropRect(ctx, width, height) {
    const imgData = ctx.getImageData(0, 0, width, height).data;
    const isNearWhite = (x, y) => {
        const idx = (y * width + x) * 4;
        return imgData[idx + 3] < 16 || (imgData[idx] >= 245 && imgData[idx + 1] >= 245 && imgData[idx + 2] >= 245);
    };
    let top = 0;
    let bottom = height - 1;
    let left = 0;
    let right = width - 1;
    const rowWhite = (y) => {
        for (let x = 0; x < width; x++) if (!isNearWhite(x, y)) return false;
        return true;
    };
    const colWhite = (x) => {
        for (let y = top; y <= bottom; y++) if (!isNearWhite(x, y)) return false;
        return true;
    };
    while (top < bottom && rowWhite(top)) top++;
    while (bottom > top && rowWhite(bottom)) bottom--;
    while (left < right && colWhite(left)) left++;
    while (right > left && colWhite(right)) right--;
    const cropW = right - left + 1;
    const cropH = bottom - top + 1;
    if (cropW < 32 || cropH < 32 || (cropW === width && cropH === height)) {
        return null;
    }
    return { x: left, y: top, w: cropW, h: cropH };
}

/**
 * Client-side Canvas image normalization (replaces .NET ImageSharp in Web mode so Workers stay under 10ms CPU).
 * Converts JPEG/WebP/GIF uploads to PNG, enforces VRChat's 2000px / 10 MiB limits, supports square padding
 * (`matchingDimensions`) for VRC+ icons/emojis/stickers, and Print white-border crop + 1920x1080 limits.
 *
 * @param {string} base64Data
 * @param {{ matchingDimensions?: boolean; isPrint?: boolean; cropWhiteBorder?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function normalizeUploadImageInBrowser(base64Data, opts = {}) {
    if (typeof base64Data !== 'string' || !base64Data) return base64Data;
    const rawBase64 = base64Data.includes(',') ? base64Data.slice(base64Data.indexOf(',') + 1) : base64Data;
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
        return rawBase64;
    }
    const matchingDimensions = Boolean(opts.matchingDimensions);
    const isPrint = Boolean(opts.isPrint);
    const cropWhiteBorder = Boolean(opts.cropWhiteBorder);

    try {
        const bytes = base64ToBytes(rawBase64);
        const alreadyPng = isPngBytes(bytes);
        const mime = sniffImageMimeFromBytes(bytes);
        const blob = new Blob([bytes], { type: mime });
        const bitmap = await createImageBitmap(blob);
        try {
            let srcX = 0;
            let srcY = 0;
            let srcW = bitmap.width;
            let srcH = bitmap.height;

            // Fast path: preserve already-compliant PNG uploads verbatim without pointless re-encoding.
            if (
                alreadyPng &&
                !isPrint &&
                !cropWhiteBorder &&
                srcW <= VRCHAT_MAX_UPLOAD_DIM &&
                srcH <= VRCHAT_MAX_UPLOAD_DIM &&
                (!matchingDimensions || srcW === srcH) &&
                bytes.byteLength <= VRCHAT_MAX_UPLOAD_BYTES
            ) {
                return rawBase64;
            }

            if (isPrint && cropWhiteBorder) {
                const probeCanvas = document.createElement('canvas');
                probeCanvas.width = srcW;
                probeCanvas.height = srcH;
                const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
                if (probeCtx) {
                    probeCtx.drawImage(bitmap, 0, 0);
                    const rect = detectWhiteBorderCropRect(probeCtx, srcW, srcH);
                    if (rect) {
                        srcX = rect.x;
                        srcY = rect.y;
                        srcW = rect.w;
                        srcH = rect.h;
                    }
                }
            }

            const maxW = isPrint ? VRCHAT_MAX_PRINT_WIDTH : VRCHAT_MAX_UPLOAD_DIM;
            const maxH = isPrint ? VRCHAT_MAX_PRINT_HEIGHT : VRCHAT_MAX_UPLOAD_DIM;
            let targetW = matchingDimensions ? Math.max(srcW, srcH) : srcW;
            let targetH = matchingDimensions ? Math.max(srcW, srcH) : srcH;

            if (targetW > maxW || targetH > maxH) {
                const scale = Math.min(maxW / targetW, maxH / targetH);
                targetW = Math.max(1, Math.round(targetW * scale));
                targetH = Math.max(1, Math.round(targetH * scale));
            }

            const encodeCanvas = (w, h) => {
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;
                if (matchingDimensions && srcW !== srcH) {
                    const scale = Math.min(w / srcW, h / srcH);
                    const drawW = Math.max(1, Math.round(srcW * scale));
                    const drawH = Math.max(1, Math.round(srcH * scale));
                    const offsetX = Math.floor((w - drawW) / 2);
                    const offsetY = Math.floor((h - drawH) / 2);
                    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, offsetX, offsetY, drawW, drawH);
                } else {
                    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, w, h);
                }
                const dataUrl = canvas.toDataURL('image/png');
                return dataUrl.slice(dataUrl.indexOf(',') + 1);
            };

            let outBase64 = encodeCanvas(targetW, targetH);
            if (!outBase64) return rawBase64;
            // Shrink progressively if PNG output exceeds VRChat's 10 MiB upload ceiling.
            for (let attempt = 0; attempt < 4 && Math.floor((outBase64.length * 3) / 4) > VRCHAT_MAX_UPLOAD_BYTES; attempt++) {
                targetW = Math.max(64, Math.round(targetW * 0.85));
                targetH = Math.max(64, Math.round(targetH * 0.85));
                const shrunk = encodeCanvas(targetW, targetH);
                if (!shrunk) break;
                outBase64 = shrunk;
            }
            return outBase64;
        } finally {
            bitmap.close();
        }
    } catch {
        return rawBase64;
    }
}

async function resizeImageInBrowser(base64Data, matchingDimensions = false) {
    return normalizeUploadImageInBrowser(base64Data, { matchingDimensions });
}

async function dispatchRemoteCommand(action, params = {}, options = {}) {
    if (options.requireOnline && !isAnyAgentOnline()) {
        return false;
    }
    try {
        await cloudFetch('/api/commands', {
            method: 'POST',
            json: options.requireOnline ? { action, params, requireOnline: true } : { action, params }
        });
        return true;
    } catch (err) {
        console.warn(`[cloud] Remote command ${action} failed:`, err?.message || err);
        return false;
    }
}

export function createVrcxStorageBridge() {
    return {
        async Get(key) {
            return bootstrapCache.storage[key] ?? '';
        },
        async GetAll() {
            return JSON.stringify(bootstrapCache.storage);
        },
        async Set(key, value) {
            scheduleStoragePatch(key, value ?? '');
        },
        async Remove(key) {
            scheduleStoragePatch(key, null);
        },
        async Clear() {
            clearCloudActivitySyncStateCache();
            for (const k of Object.keys(bootstrapCache.storage)) {
                scheduleStoragePatch(k, null);
            }
            await flushStorageNow();
        },
        async Save() {
            await flushStorageNow();
        }
    };
}

/** @type {(() => void) | null} */
let activeLogWatcherUnsub = null;

export function createLogWatcherBridge() {
    activeLogWatcherUnsub?.();
    activeLogWatcherUnsub = null;

    /** @type {Array<{ row: string[]; rowId: number; type: string; createdAt: string }>} */
    const queue = [];
    const MAX_QUEUED_ROWS = 500;
    let inFlightAsyncDispatch = false;

    /**
     * Strictly serializes real-time WS GameLog delivery into window.$bridge.addGameLogEvent
     * in FIFO order (waiting for each async Promise to settle before starting the next item)
     * so server-assigned D1 rowIds can never be scrambled across multi-event batches.
     */
    function pumpQueue() {
        if (inFlightAsyncDispatch) return;
        const bridge = typeof window !== 'undefined' ? /** @type {any} */ (window).$bridge : null;
        if (!bridge || typeof bridge.addGameLogEvent !== 'function') {
            return;
        }
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            setSuppressCloudGameLogWrites(true);
            setActiveCloudGameLogRowMeta(
                item.rowId > 0 ? { rowId: item.rowId, type: item.type, createdAt: item.createdAt } : null
            );
            try {
                const ret = bridge.addGameLogEvent(JSON.stringify(item.row));
                if (ret && typeof ret.then === 'function') {
                    inFlightAsyncDispatch = true;
                    Promise.resolve(ret)
                        .catch(() => {})
                        .finally(() => {
                            clearActiveCloudGameLogRowMeta();
                            setSuppressCloudGameLogWrites(false);
                            inFlightAsyncDispatch = false;
                            pumpQueue();
                        });
                    return;
                }
                clearActiveCloudGameLogRowMeta();
                setSuppressCloudGameLogWrites(false);
            } catch {
                clearActiveCloudGameLogRowMeta();
                setSuppressCloudGameLogWrites(false);
            }
        }
    }

    activeLogWatcherUnsub = onCloudGameLogEvent((ev) => {
        const dt = ev.created_at || new Date().toISOString();
        const serverRowId = Number(ev.rowId) > 0 ? Math.floor(Number(ev.rowId)) : 0;
        /** @type {string[] | null} */
        let row = null;
        if (ev.type === 'Location') {
            row = ['cloud', dt, 'location', ev.location || '', ev.worldName || ''];
        } else if (ev.type === 'OnPlayerJoined') {
            row = ['cloud', dt, 'player-joined', ev.displayName || '', ev.userId || ''];
        } else if (ev.type === 'OnPlayerLeft') {
            row = ['cloud', dt, 'player-left', ev.displayName || '', ev.userId || ''];
        } else if (ev.type === 'VideoPlay') {
            row = ['cloud', dt, 'video-play', ev.videoUrl || '', ev.displayName || ''];
        } else if (ev.type === 'Event') {
            row = ['cloud', dt, 'event', ev.data || ''];
        } else if (ev.type === 'PortalSpawn') {
            row = ['cloud', dt, 'portal-spawn'];
        }
        if (!row) return;

        if (queue.length >= MAX_QUEUED_ROWS) {
            queue.shift();
        }
        queue.push({ row, rowId: serverRowId, type: String(ev.type || ''), createdAt: dt });
        pumpQueue();
    });

    return {
        async Reset() {
            queue.length = 0;
        },
        async SetDateTill() {},
        async Get() {
            if (queue.length === 0) return [];
            return queue.splice(0, 50).map((item) => item.row);
        },
        async GetLogLines() {
            return [];
        }
    };
}

export function createDiscordBridge() {
    /** @type {Record<string, any>} */
    const state = { active: false, details: '', stateText: '', largeImage: '', smallImage: '' };
    /** @type {ReturnType<typeof setTimeout> | null} */
    let syncTimer = null;

    function queueSync() {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            syncTimer = null;
            if (!cloudState.authenticated || cloudState.agentsOnline.length === 0) {
                return;
            }
            dispatchRemoteCommand('discord_update', { ...state });
        }, 2500);
    }

    return {
        async SetActive(active) {
            if (state.active === Boolean(active)) return state.active;
            state.active = Boolean(active);
            queueSync();
            return state.active;
        },
        async SetText(details, stateText) {
            if (state.details === details && state.stateText === stateText) return;
            state.details = details || '';
            state.stateText = stateText || '';
            queueSync();
        },
        async SetTimestamps() {},
        async SetAssets(
            details,
            stateText,
            detailsUrl,
            largeImage,
            largeText,
            smallImage,
            smallText,
            startUnixMilliseconds,
            endUnixMilliseconds,
            partyId,
            partySize,
            partyMax,
            buttonText,
            buttonUrl,
            appId,
            activityType,
            statusDisplayType
        ) {
            const next = {
                active: state.active,
                details: details || '',
                stateText: stateText || '',
                detailsUrl: detailsUrl || '',
                largeImage: largeImage || '',
                largeText: largeText || '',
                smallImage: smallImage || '',
                smallText: smallText || '',
                startUnixMilliseconds: startUnixMilliseconds || 0,
                endUnixMilliseconds: endUnixMilliseconds || 0,
                partyId: partyId || '',
                partySize: partySize || 0,
                partyMax: partyMax || 0,
                buttonText: buttonText || '',
                buttonUrl: buttonUrl || '',
                appId: appId || '',
                activityType: activityType || 0,
                statusDisplayType: statusDisplayType || 0
            };
            if (JSON.stringify(next) === JSON.stringify(state)) return;
            Object.assign(state, next);
            queueSync();
        }
    };
}

export function createAssetBundleManagerBridge() {
    return {
        async SweepCache() {
            return '';
        },
        async GetCacheSize() {
            const st = getPrimaryAgentState();
            return Number(st?.cacheSizeBytes ?? 0);
        },
        async GetVRChatCacheFullLocation() {
            return '';
        },
        async CheckVRChatCache() {
            return { Item1: -1, Item2: false, Item3: '' };
        },
        async DeleteCache(id, _version, variant) {
            const itemId = String(id || '').trim();
            if (!itemId) return;
            const cleanVariant = typeof variant === 'string' ? variant.trim() : '';
            await dispatchRemoteCommand(
                'clear_cache',
                cleanVariant ? { scope: 'single', id: itemId, variant: cleanVariant } : { scope: 'single', id: itemId }
            );
        },
        async DeleteAllCache() {
            await dispatchRemoteCommand('clear_cache', { scope: 'all' });
        }
    };
}

export function createAppApiBridge() {
    let zoomLevel = 1;

    const api = {
        async ShowDevTools() {},
        async SetVR() {},
        async SetZoom(val) {
            zoomLevel = Number(val) || 1;
        },
        async GetZoom() {
            return zoomLevel;
        },
        async DesktopNotification(boldText, text, image) {
            if (typeof Notification === 'undefined') return;
            const opts = { body: text || '', icon: image || undefined };
            if (Notification.permission === 'granted') {
                new Notification(boldText || 'VRCX', opts);
            } else if (Notification.permission === 'default') {
                Notification.requestPermission()
                    .then((permission) => {
                        if (permission === 'granted') {
                            new Notification(boldText || 'VRCX', opts);
                        }
                    })
                    .catch(() => {});
            }
        },
        async RestartApplication() {
            window.location.reload();
        },
        async CheckForUpdateExe() {
            return false;
        },
        async ExecuteVrOverlayFunction() {},
        async FocusWindow() {
            window.focus?.();
        },
        async ChangeTheme() {},
        async DoFunny() {},
        async GetClipboard() {
            try {
                return await navigator.clipboard.readText();
            } catch {
                return '';
            }
        },
        async SetStartup() {},
        async CopyImageToClipboard() {},
        async FlashWindow() {},
        async SetUserAgent() {},
        async SetTrayIconNotification() {},
        async OpenCalendarFile(icsContent) {
            const blob = new Blob([icsContent || ''], { type: 'text/calendar;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'vrchat-event.ics';
            a.style.display = 'none';
            document.body?.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => {
                URL.revokeObjectURL(url);
            }, 1000);
        },
        async GetColourFromUserID(userId) {
            return hashUserIdToHue(userId);
        },
        async GetColourBulk(userIds) {
            /** @type {Record<string, number>} */
            const out = {};
            for (const id of userIds || []) {
                out[id] = hashUserIdToHue(id);
            }
            return out;
        },
        async OpenLink(url) {
            if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
        },
        async OpenDiscordProfile(discordId) {
            window.open(`https://discord.com/users/${encodeURIComponent(discordId)}`, '_blank', 'noopener,noreferrer');
        },
        async OpenSteamStorePage(appId) {
            window.open(
                `https://store.steampowered.com/app/${encodeURIComponent(appId)}`,
                '_blank',
                'noopener,noreferrer'
            );
        },
        async GetLaunchCommand() {
            return '';
        },
        async IPCAnnounceStart() {},
        async SendIpc() {},
        async CustomCss() {
            return '';
        },
        async CustomScript() {
            return '';
        },
        async CurrentCulture() {
            return navigator.language || 'en-US';
        },
        async CurrentLanguage() {
            return navigator.language || 'en-US';
        },
        async GetVersion() {
            return `VRCX Cloud ${typeof VERSION === 'string' ? VERSION : '2026.11'}`;
        },
        async VrcClosedGracefully() {
            return true;
        },
        async SetAppLauncherSettings() {},
        async GetFileBase64() {
            return null;
        },
        async TryOpenInstanceInVrc(launchUrl) {
            const raw = String(launchUrl || '').trim();
            if (!raw.startsWith('vrchat://launch?')) return false;
            const urlWithAttach = raw.includes('attach=') ? raw : `${raw}&attach=1`;
            return dispatchRemoteCommand('launch_vrc', { launchUrl: urlWithAttach }, { requireOnline: true });
        },
        async StartGame(args) {
            const rawArgs = String(args || '');
            const match = rawArgs.match(/vrchat:\/\/launch\?[^\s"']+/);
            if (!match) return false;
            const desktopMode = /(?:^|\s)--no-vr(?:\s|$)/.test(rawArgs);
            return dispatchRemoteCommand(
                'launch_vrc',
                desktopMode ? { launchUrl: match[0], desktopMode: true } : { launchUrl: match[0] },
                { requireOnline: true }
            );
        },
        async StartGameFromPath(_path, args) {
            return this.StartGame(args);
        },
        async QuitGame() {
            const ok = await dispatchRemoteCommand('quit_vrc', {});
            return ok ? 1 : 0;
        },
        async CheckGameRunning() {
            syncGameRunningBridge();
        },
        async IsGameRunning() {
            return getAggregatedGameState().vrcRunning;
        },
        async IsSteamVRRunning() {
            return getAggregatedGameState().steamVrRunning;
        },
        async MD5File(base64) {
            return md5Base64(base64ToBytes(base64));
        },
        async SignFile(base64) {
            return bytesToBase64(computeLibrsyncSignature(base64ToBytes(base64)));
        },
        async FileLength(base64) {
            return String(base64ToBytes(base64).byteLength);
        },
        async ResizeImageToFitLimits(base64data, matchingDimensions = false) {
            return resizeImageInBrowser(base64data, Boolean(matchingDimensions));
        },
        async PopulateImageHosts() {},
        async GetImage(url) {
            return url || '';
        },
        async XSNotification(title, content, timeout, opacity, image) {
            await dispatchRemoteCommand('send_vr_notify', {
                target: 'xsoverlay',
                title,
                content,
                timeout,
                opacity,
                image
            });
        },
        async OVRTNotification(hudNotification, wristNotification, title, body, timeout, opacity, image) {
            await dispatchRemoteCommand('send_vr_notify', {
                target: 'ovrtoolkit',
                hudNotification,
                wristNotification,
                title,
                body,
                timeout,
                opacity,
                image
            });
        },
        async GetVRChatRegistry() {
            return {};
        },
        async GetVRChatRegistryKey() {
            return null;
        },
        async SetVRChatRegistryKey() {
            return false;
        },
        async DeleteVRChatRegistryKey() {
            return false;
        },
        async GetVRChatRegistryJson() {
            return '{}';
        },
        async HasVRChatRegistryFolder() {
            return false;
        },
        async GetVRChatModerations() {
            return null;
        },
        async GetVRChatUserModeration() {
            return 0;
        },
        async SetVRChatUserModeration() {
            return false;
        },
        async ReadConfigFile() {
            return '{}';
        },
        async ReadConfigFileSafe() {
            return '{}';
        },
        async WriteConfigFile() {},
        async FindScreenshotsBySearch() {
            // Desktop contract returns local file path strings (string[]); cloud gallery uses /api/screenshots directly.
            return '[]';
        },
        async GetScreenshotMetadata() {
            return '{}';
        },
        async GetExtraScreenshotData() {
            return '{}';
        },
        async GetLastScreenshot() {
            return '';
        }
    };

    // Safe proxy fallback for any remaining desktop-only AppApi methods
    return new Proxy(api, {
        get(target, prop) {
            if (prop in target) {
                return target[prop];
            }
            if (typeof prop === 'string') {
                return async () => '';
            }
            return undefined;
        }
    });
}

export function createElectronShim() {
    const noopUnsub = () => () => {};
    return {
        getArch: async () => 'web',
        getClipboardText: async () => {
            try {
                return await navigator.clipboard.readText();
            } catch {
                return '';
            }
        },
        getNoUpdater: async () => true,
        setTrayIconNotification: async () => {},
        setThemeSource: async () => {},
        onSystemThemeChanged: noopUnsub,
        openFileDialog: async () => '',
        openDirectoryDialog: async () => '',
        desktopNotification: async (title, body, image) => {
            if (typeof Notification === 'undefined') return;
            const opts = { body: body || '', icon: image || undefined };
            if (Notification.permission === 'granted') {
                new Notification(title || 'VRCX', opts);
            } else if (Notification.permission === 'default') {
                Notification.requestPermission()
                    .then((permission) => {
                        if (permission === 'granted') {
                            new Notification(title || 'VRCX', opts);
                        }
                    })
                    .catch(() => {});
            }
        },
        restartApp: async () => window.location.reload(),
        getOverlayWindow: async () => false,
        updateVr: async () => {},
        onWindowPositionChanged: noopUnsub,
        onWindowSizeChanged: noopUnsub,
        onWindowStateChange: noopUnsub,
        onBrowserFocus: noopUnsub,
        onBrowserBlur: noopUnsub,
        ipcRenderer: {
            on: noopUnsub
        }
    };
}

export function createSqliteNoopShim() {
    return {
        async Execute() {
            return [];
        },
        async ExecuteJson() {
            return '[]';
        },
        async ExecuteNonQuery() {
            return 0;
        },
        async ExecuteInsert() {
            return 0;
        }
    };
}
