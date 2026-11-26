const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]!);
    }
    return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

export function randomHex(byteLength = 32): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}

export function timingSafeEqual(a: string, b: string): boolean {
    const ab = encoder.encode(a);
    const bb = encoder.encode(b);
    if (ab.length !== bb.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < ab.length; i++) {
        diff |= ab[i]! ^ bb[i]!;
    }
    return diff === 0;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
    const data = typeof input === 'string' ? encoder.encode(input) : input;
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return bytesToHex(new Uint8Array(sig));
}

async function deriveAesKey(masterSecret: string): Promise<CryptoKey> {
    const rawHash = await crypto.subtle.digest('SHA-256', encoder.encode(masterSecret));
    return crypto.subtle.importKey('raw', rawHash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptAesGcm(
    masterSecret: string,
    plaintext: string
): Promise<{ ciphertextB64: string; ivB64: string }> {
    const key = await deriveAesKey(masterSecret);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
    return {
        ciphertextB64: bytesToBase64(new Uint8Array(cipherBuf)),
        ivB64: bytesToBase64(iv)
    };
}

export async function decryptAesGcm(masterSecret: string, ciphertextB64: string, ivB64: string): Promise<string> {
    const key = await deriveAesKey(masterSecret);
    const iv = base64ToBytes(ivB64);
    const cipher = base64ToBytes(ciphertextB64);
    const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        cipher as BufferSource
    );
    return decoder.decode(plainBuf);
}

/**
 * Validates that a static access passphrase has at least 10 characters,
 * contains both at least one ASCII letter and one digit, and has no control characters.
 */
export function validateStaticPassphrase(raw: unknown): { valid: boolean; reason?: string } {
    if (typeof raw !== 'string') {
        return { valid: false, reason: 'Static passphrase must be a string' };
    }
    if (raw.length < 10) {
        return { valid: false, reason: 'Static passphrase must be at least 10 characters long' };
    }
    if (raw.length > 128) {
        return { valid: false, reason: 'Static passphrase must be at most 128 characters long' };
    }
    if (/[\x00-\x1F\x7F]/.test(raw)) {
        return { valid: false, reason: 'Static passphrase cannot contain control characters' };
    }
    if (!/[A-Za-z]/.test(raw) || !/[0-9]/.test(raw)) {
        return { valid: false, reason: 'Static passphrase must include both letters and numbers' };
    }
    return { valid: true };
}

/**
 * Derives a salted PBKDF2-SHA256 hash formatted as `pbkdf2$<iterations>$<saltHex>$<hashHex>`
 * compatible with `verifyPasscode` and Cloudflare Workers Web Crypto's 100,000-iteration ceiling.
 */
export async function hashPasscodePbkdf2(passphrase: string, iterations = 100_000): Promise<string> {
    const safeIterations = Math.min(Math.max(Math.floor(iterations), 10_000), 100_000);
    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes as BufferSource, iterations: safeIterations, hash: 'SHA-256' },
        baseKey,
        256
    );
    return `pbkdf2$${safeIterations}$${bytesToHex(saltBytes)}$${bytesToHex(new Uint8Array(derived))}`;
}

/**
 * Verifies either a raw secret passcode or a PBKDF2-SHA256 hash formatted as:
 * `pbkdf2$<iterations>$<saltHex>$<hashHex>`
 */
export async function verifyPasscode(configured: string, candidate: string): Promise<boolean> {
    if (!configured.startsWith('pbkdf2$')) {
        return timingSafeEqual(configured, candidate);
    }
    const parts = configured.split('$');
    if (parts.length !== 4) {
        return false;
    }
    const iterations = Number(parts[1]);
    const saltHex = parts[2] ?? '';
    const expectedHex = parts[3] ?? '';
    // Cloudflare Workers Web Crypto enforces a hard 100,000-iteration ceiling on PBKDF2.
    if (
        !Number.isInteger(iterations) ||
        iterations < 10_000 ||
        iterations > 100_000 ||
        saltHex.length === 0 ||
        saltHex.length % 2 !== 0 ||
        !/^[0-9a-fA-F]+$/.test(saltHex) ||
        !/^[0-9a-fA-F]{64}$/.test(expectedHex)
    ) {
        return false;
    }
    const saltBytes = new Uint8Array(saltHex.length / 2);
    for (let i = 0; i < saltBytes.length; i++) {
        saltBytes[i] = parseInt(saltHex.slice(i * 2, i * 2 + 2), 16);
    }
    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(candidate), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes as BufferSource, iterations, hash: 'SHA-256' },
        baseKey,
        256
    );
    return timingSafeEqual(bytesToHex(new Uint8Array(derived)), expectedHex.toLowerCase());
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        value = (value << 8) | bytes[i]!;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]!;
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]!;
    }
    return out;
}

/**
 * Generates a cryptographically random RFC 6238 Base32 TOTP secret (default 160-bit / 32 Base32 chars).
 */
export function generateTotpSecret(byteLength = 20): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return encodeBase32(bytes);
}

function decodeBase32(input: string): Uint8Array {
    const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const idx = BASE32_ALPHABET.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

async function computeHotpForStep(hmacKey: CryptoKey, step: number): Promise<string> {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, Math.floor(step / 0x100000000));
    view.setUint32(4, step >>> 0);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, buf));
    const offset = mac[mac.length - 1]! & 0x0f;
    const binary =
        ((mac[offset]! & 0x7f) << 24) |
        ((mac[offset + 1]! & 0xff) << 16) |
        ((mac[offset + 2]! & 0xff) << 8) |
        (mac[offset + 3]! & 0xff);
    return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Generates an RFC 6238 SHA-1 6-digit TOTP code for a given Base32 secret and timestamp.
 */
export async function generateTotpCode(base32Secret: string, nowMs = Date.now()): Promise<string> {
    const keyBytes = decodeBase32(base32Secret);
    if (keyBytes.length === 0) {
        throw new Error('Invalid Base32 TOTP secret');
    }
    const hmacKey = await crypto.subtle.importKey(
        'raw',
        keyBytes as BufferSource,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
    );
    const step = Math.floor(nowMs / 30_000);
    return computeHotpForStep(hmacKey, step);
}

/**
 * RFC 6238 SHA-1 6-digit TOTP verification (±1 step drift tolerance).
 * Returns the matched 30-second time step so callers can enforce single-use replay protection.
 */
export async function verifyTotpStep(
    base32Secret: string,
    code: string,
    nowMs = Date.now()
): Promise<{ valid: boolean; step: number }> {
    const cleanCode = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanCode)) {
        return { valid: false, step: 0 };
    }
    const keyBytes = decodeBase32(base32Secret);
    if (keyBytes.length === 0) {
        return { valid: false, step: 0 };
    }
    const hmacKey = await crypto.subtle.importKey(
        'raw',
        keyBytes as BufferSource,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
    );
    const currentStep = Math.floor(nowMs / 30_000);
    for (const delta of [-1, 0, 1]) {
        const step = currentStep + delta;
        const otp = await computeHotpForStep(hmacKey, step);
        if (timingSafeEqual(otp, cleanCode)) {
            return { valid: true, step };
        }
    }
    return { valid: false, step: 0 };
}

/** RFC 6238 SHA-1 6-digit TOTP verification (±1 step drift tolerance). */
export async function verifyTotp(base32Secret: string, code: string, nowMs = Date.now()): Promise<boolean> {
    const res = await verifyTotpStep(base32Secret, code, nowMs);
    return res.valid;
}

export async function signSessionCookie(secret: string, sessionId: string, expEpochSec: number): Promise<string> {
    const payload = `${sessionId}.${expEpochSec}`;
    const sig = await hmacSha256Hex(secret, payload);
    return `${payload}.${sig}`;
}

export async function verifySessionCookie(
    secret: string,
    cookieVal: string
): Promise<{ valid: boolean; sessionId?: string }> {
    const parts = cookieVal.split('.');
    if (parts.length !== 3) {
        return { valid: false };
    }
    const [sessionId, expStr, sig] = parts as [string, string, string];
    const exp = Number(expStr);
    if (!sessionId || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
        return { valid: false };
    }
    const expected = await hmacSha256Hex(secret, `${sessionId}.${expStr}`);
    if (!timingSafeEqual(expected, sig)) {
        return { valid: false };
    }
    return { valid: true, sessionId };
}

/**
 * Signs a 2FA browser-trust cookie scoped to the active `trustEpoch` so disabling,
 * re-binding, or revoking all trusted browsers immediately invalidates prior cookies.
 */
export async function sign2faTrustCookie(
    signSecret: string,
    trustEpoch: string,
    tokenId: string,
    expEpochSec: number
): Promise<string> {
    const payload = `v1.${trustEpoch}.${tokenId}.${expEpochSec}`;
    const sig = await hmacSha256Hex(signSecret, payload);
    return `${payload}.${sig}`;
}

export async function verify2faTrustCookie(
    signSecret: string,
    cookieVal: string,
    expectedEpoch: string,
    maxAllowedExpEpochSec: number
): Promise<{ valid: boolean; tokenId?: string; expEpochSec?: number }> {
    const parts = cookieVal.split('.');
    if (parts.length !== 5) {
        return { valid: false };
    }
    const [version, epoch, tokenId, expStr, sig] = parts as [string, string, string, string, string];
    if (version !== 'v1' || !epoch || !tokenId || !timingSafeEqual(epoch, expectedEpoch)) {
        return { valid: false };
    }
    const exp = Number(expStr);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(exp) || exp <= nowSec || exp > maxAllowedExpEpochSec) {
        return { valid: false };
    }
    const expectedSig = await hmacSha256Hex(signSecret, `${version}.${epoch}.${tokenId}.${expStr}`);
    if (!timingSafeEqual(expectedSig, sig)) {
        return { valid: false };
    }
    return { valid: true, tokenId, expEpochSec: exp };
}
