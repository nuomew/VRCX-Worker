export const VRC_OSC_MAX_CHARS = 144;
export const VRC_OSC_MAX_LINES = 9;
export const DEFAULT_OSC_SEND_PORT = 9000;
export const DEFAULT_OSC_LISTEN_PORT = 9002;
export const CHAT_TRANSLATOR_PREFS_KEY = 'VRCX_chatTranslatorPrefs';
export const DEFAULT_CLOUDFLARE_AI_MODEL = '@cf/zai-org/glm-4.7-flash';

export const CLOUDFLARE_AI_TRANSLATION_PRESETS = Object.freeze([
    {
        id: '@cf/zai-org/glm-4.7-flash',
        label: 'GLM-4.7-Flash (Free · ~630k tok / ~6,000 msgs/day)',
        labelZh: 'GLM-4.7-Flash（免费推荐 · ~63万 tok / 约 6,000 句/天）',
        quotaDetail: 'Free 10k Neurons/day (~630k tok -> ~6,000 msgs/day) · 5.5k in / 36.4k out Neurons per 1M tok',
        quotaDetailZh: '免费 10,000 Neurons/天：约 63 万 tok → 约 6,000 句/天（输入 5.5k / 输出 36.4k Neurons 每百万 tok）',
        tier: 'free'
    },
    {
        id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
        label: 'Llama 3.1 8B FP8 Fast (Free · ~690k tok / ~6,600 msgs/day)',
        labelZh: 'Llama 3.1 8B FP8 Fast（免费 · ~69万 tok / 约 6,600 句/天）',
        quotaDetail: 'Free 10k Neurons/day (~690k tok -> ~6,600 msgs/day) · 4.1k in / 34.9k out Neurons per 1M tok',
        quotaDetailZh: '免费 10,000 Neurons/天：约 69 万 tok → 约 6,600 句/天（输入 4.1k / 输出 34.9k Neurons 每百万 tok）',
        tier: 'free'
    },
    {
        id: '@cf/meta/llama-3.2-3b-instruct',
        label: 'Llama 3.2 3B (Free · ~750k tok / ~7,200 msgs/day)',
        labelZh: 'Llama 3.2 3B（免费极速 · ~75万 tok / 约 7,200 句/天）',
        quotaDetail: 'Free 10k Neurons/day (~750k tok -> ~7,200 msgs/day) · 4.6k in / 30.5k out Neurons per 1M tok',
        quotaDetailZh: '免费 10,000 Neurons/天：约 75 万 tok → 约 7,200 句/天（输入 4.6k / 输出 30.5k Neurons 每百万 tok）',
        tier: 'free'
    },
    {
        id: '@cf/meta/m2m100-1.2b',
        label: 'Meta M2M100 1.2B (Free MT · ~320k tok / ~5,300 msgs/day)',
        labelZh: 'Meta M2M100 1.2B（免费直译 · ~32万 tok / 约 5,300 句/天）',
        quotaDetail: 'Free 10k Neurons/day (~320k tok -> ~5,300 msgs/day, no prompt) · 31.1k in / 31.1k out Neurons per 1M tok',
        quotaDetailZh: '免费 10,000 Neurons/天：约 32 万 tok → 约 5,300 句/天（无需提示词，输入/输出各 31.1k Neurons 每百万 tok）',
        tier: 'free'
    },
    {
        id: '@cf/zai-org/glm-5.3-flash',
        label: 'GLM-5.3-Flash (Paid · ~410k tok / ~3,900 msgs per 10k Neurons)',
        labelZh: 'GLM-5.3-Flash（需付费 · ~41万 tok / 约 3,900 句）',
        quotaDetail: 'Requires Workers Paid / Credits · $0.15 in / $0.50 out per 1M tok (~410k tok -> ~3,900 msgs per 10k Neurons; ~3.75M tok -> ~35,700 msgs per $1)',
        quotaDetailZh: '需 Workers Paid / 预充额度（$0.15 输入 / $0.50 输出每百万 tok）：每 10k Neurons 约 41 万 tok → 约 3,900 句；每 $1 约 375 万 tok → 约 35,700 句',
        tier: 'paid'
    },
    {
        id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
        label: 'DeepSeek-V4.1-Flash-1017 (Paid · ~180k tok / ~1,700 msgs per 10k Neurons)',
        labelZh: 'DeepSeek-V4.1-Flash-1017（需付费 · ~18万 tok / 约 1,700 句）',
        quotaDetail: 'Requires Workers Paid / Credits · $0.30 in / $1.20 out per 1M tok (~180k tok -> ~1,700 msgs per 10k Neurons; ~1.67M tok -> ~15,800 msgs per $1)',
        quotaDetailZh: '需 Workers Paid / 预充额度（$0.30 输入 / $1.20 输出每百万 tok，已关思考）：每 10k Neurons 约 18 万 tok → 约 1,700 句；每 $1 约 167 万 tok → 约 15,800 句',
        tier: 'paid'
    }
]);

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
