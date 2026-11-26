export const VRC_OSC_MAX_CHARS = 144;
export const VRC_OSC_MAX_LINES = 9;
export const DEFAULT_OSC_SEND_PORT = 9000;
export const DEFAULT_OSC_LISTEN_PORT = 9002;
export const CHAT_TRANSLATOR_PREFS_KEY = 'VRCX_chatTranslatorPrefs';

export const CHAT_TRANSLATOR_LANGUAGES = Object.freeze([
    { code: 'zh-CN', label: '简体中文', englishName: 'Simplified Chinese' },
    { code: 'zh-TW', label: '繁體中文', englishName: 'Traditional Chinese' },
    { code: 'en', label: 'English', englishName: 'English' },
    { code: 'ja', label: '日本語', englishName: 'Japanese' },
    { code: 'ko', label: '한국어', englishName: 'Korean' },
    { code: 'ru', label: 'Русский', englishName: 'Russian' },
    { code: 'es', label: 'Español', englishName: 'Spanish' },
    { code: 'fr', label: 'Français', englishName: 'French' },
    { code: 'de', label: 'Deutsch', englishName: 'German' },
    { code: 'pt', label: 'Português', englishName: 'Portuguese' },
    { code: 'th', label: 'ภาษาไทย', englishName: 'Thai' },
    { code: 'vi', label: 'Tiếng Việt', englishName: 'Vietnamese' },
    { code: 'id', label: 'Bahasa Indonesia', englishName: 'Indonesian' }
]);

const LANGUAGE_MAP = new Map(CHAT_TRANSLATOR_LANGUAGES.map((item) => [item.code, item]));

export function getChatLanguageLabel(code, autoLabel = 'Auto') {
    if (!code || code === 'auto') return autoLabel;
    return LANGUAGE_MAP.get(code)?.label || code;
}

export function getChatLanguageEnglishName(code) {
    if (!code || code === 'auto') return 'the detected source language';
    return LANGUAGE_MAP.get(code)?.englishName || code;
}

/**
 * Normalizes text for VRChat OSC Chatbox:
 * strips unsafe control characters (preserving newlines), clamps to 9 lines and 144 Unicode code points.
 *
 * @param {string} raw
 * @returns {{ text: string; charCount: number; lineCount: number; truncated: boolean }}
 */
export function sanitizeOscChatboxText(raw) {
    if (typeof raw !== 'string') {
        return { text: '', charCount: 0, lineCount: 0, truncated: false };
    }
    const cleaned = raw
        .replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .trim();
    if (!cleaned) {
        return { text: '', charCount: 0, lineCount: 0, truncated: false };
    }

    const rawLines = cleaned.split('\n');
    let truncated = rawLines.length > VRC_OSC_MAX_LINES;
    let bounded = rawLines.slice(0, VRC_OSC_MAX_LINES).join('\n');

    const runes = Array.from(bounded);
    if (runes.length > VRC_OSC_MAX_CHARS) {
        truncated = true;
        bounded = runes.slice(0, VRC_OSC_MAX_CHARS).join('').trim();
    }

    const finalRunes = Array.from(bounded);
    const finalLines = bounded ? bounded.split('\n').length : 0;
    return {
        text: bounded,
        charCount: finalRunes.length,
        lineCount: finalLines,
        truncated
    };
}

/**
 * Composes the exact text sent to VRChat `/chatbox/input` according to the selected display mode.
 *
 * @param {{ sourceText: string; translatedText?: string; displayMode?: string }} opts
 * @returns {{ text: string; charCount: number; lineCount: number; truncated: boolean }}
 */
export function composeOscChatboxPayload({ sourceText, translatedText = '', displayMode = 'translated_only' }) {
    const src = typeof sourceText === 'string' ? sourceText.trim() : '';
    const dst = typeof translatedText === 'string' ? translatedText.trim() : '';

    let combined = src;
    if (displayMode === 'source_only') {
        combined = src;
    } else if (displayMode === 'translated_and_source') {
        combined = dst && src && dst !== src ? `${dst}\n(${src})` : dst || src;
    } else if (displayMode === 'source_and_translated') {
        combined = dst && src && dst !== src ? `${src}\n(${dst})` : dst || src;
    } else {
        // Default: translated_only
        combined = dst || src;
    }
    return sanitizeOscChatboxText(combined);
}

/**
 * Builds a concise VRChat-friendly OpenAI system prompt when the user has not customized one.
 *
 * @param {string} sourceLang
 * @param {string} targetLang
 * @param {string} [customPrompt]
 * @returns {string}
 */
export function buildChatTranslationPrompt(sourceLang, targetLang, customPrompt = '') {
    if (typeof customPrompt === 'string' && customPrompt.trim()) {
        return customPrompt.trim();
    }
    const targetName = getChatLanguageEnglishName(targetLang);
    const fromClause =
        sourceLang && sourceLang !== 'auto'
            ? `from ${getChatLanguageEnglishName(sourceLang)} `
            : '';
    return `You are a concise VRChat chatbox translator. Translate the user message ${fromClause}into natural ${targetName}. Keep it brief (under 144 characters when possible), preserve tone/emoji, and return only the translated text with no quotes or explanation.`;
}

/**
 * Clamps and validates a user-entered local OSC port into [1024, 65535].
 *
 * @param {unknown} raw
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeOscPort(raw, fallback = DEFAULT_OSC_SEND_PORT) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        return fallback;
    }
    return n;
}
