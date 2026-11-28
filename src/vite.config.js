import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import fs from 'node:fs';

import { defineConfig, loadEnv } from 'vite';
import { browserslistToTargets } from 'lightningcss';

import browserslist from 'browserslist';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';

import { languageCodes } from './localization/locales';

/**
 * Vite plugin to remove legacy remixicon font files (eot, woff, ttf, svg)
 * from the build output, keeping only woff2. Saves ~4.5 MB.
 *
 * Chrome 144 picks woff2 from the multi-format @font-face src list and
 * never requests the other formats, so deleting them is safe.
 *
 * @returns {import('vite').Plugin}
 */
function remixiconWoff2Only() {
    return {
        name: 'remixicon-woff2-only',
        generateBundle(_, bundle) {
            for (const key of Object.keys(bundle)) {
                if (/remixicon\.(eot|ttf|svg|woff)$/.test(key)) {
                    delete bundle[key];
                }
            }
        }
    };
}

/**
 * @param {string | undefined} assetId
 */
function getAssetLanguage(assetId) {
    if (!assetId) return null;

    if (assetId.endsWith('.json')) {
        const language = assetId.split('.json')[0];

        if (languageCodes.includes(language)) return language;
    }

    const language =
        // Font assets, e.g., noto-sans-jp-regular.woff2 mapped to language code.
        /** @type {Record<string, string>} */ ({
            jp: 'ja',
            sc: 'zh-CN',
            tc: 'zh-TW',
            kr: 'ko'
        })[assetId.split('noto-sans-')[1]?.split('-')[0]];

    return language || null;
}

/**
 * @param {string} moduleId
 */
function getManualChunk(moduleId) {
    const basename = moduleId.split('/').pop();
    const language = getAssetLanguage(basename);
    if (!language) return;

    return `i18n/${language}`;
}

const defaultAssetName = '[name][extname]';

/**
 * @param {string} name
 */
function isFont(name) {
    return /\.(woff2?|ttf|otf|eot)$/.test(name);
}

/**
 * Generates asset filenames; Web builds append content hashes to non-font assets
 * (such as theme CSS and i18n JSON) so Cloudflare/browser caches immediately pick up updates.
 *
 * @param {boolean} isWeb
 */
function createAssetFilenameResolver(isWeb) {
    const hashedSuffix = isWeb ? '-[hash]' : '';
    /**
     * @param {import('rolldown').PreRenderedAsset} assetInfo
     */
    return function getAssetFilename({ name }) {
        const language = getAssetLanguage(name);
        if (!name || !language) {
            if (name && isFont(name)) return `assets/${defaultAssetName}`;
            return `assets/[name]${hashedSuffix}[extname]`;
        }

        if (isFont(name)) return 'assets/fonts/[name][extname]';
        return `assets/i18n/[name]${hashedSuffix}[extname]`;
    };
}

/**
 * Formats a Date into `YYYY.MM.DD` in Asia/Shanghai (UTC+8) when no explicit commit timezone is present.
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDateAsCloudVersion(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    if (year && month && day) {
        return `${year}.${month}.${day}`;
    }
    return date.toISOString().slice(0, 10).replace(/-/g, '.');
}

/**
 * Resolves the VRCX Cloud version date (`YYYY.MM.DD`) from the latest Git commit timestamp
 * (falling back to current build time when `.git` is unavailable) so every deploy reflects
 * the actual update date without modifying upstream desktop `Version`.
 *
 * @param {string} fallbackVersion
 * @returns {string}
 */
function resolveWebCloudVersion(fallbackVersion) {
    try {
        const repoRoot = resolve(import.meta.dirname, '..');
        const iso = execFileSync('git', ['log', '-1', '--format=%cI'], {
            cwd: repoRoot,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        // Preserve explicit commit local timezone offset (e.g. +08:00); convert UTC 'Z' commits to Asia/Shanghai.
        const explicitOffsetMatch = iso.match(/^(\d{4})-(\d{2})-(\d{2})T.*[+-]\d{2}:\d{2}$/);
        if (explicitOffsetMatch) {
            return `${explicitOffsetMatch[1]}.${explicitOffsetMatch[2]}.${explicitOffsetMatch[3]}`;
        }
        const parsedMs = Date.parse(iso);
        if (Number.isFinite(parsedMs)) {
            return formatDateAsCloudVersion(new Date(parsedMs));
        }
    } catch {
        // Fall back to current build time below
    }
    try {
        return formatDateAsCloudVersion(new Date());
    } catch {
        return fallbackVersion;
    }
}

/**
 * @param ConfigEnv ConfigEnv
 * @returns {import('vite').UserConfig}
 */
export default defineConfig(({ mode }) => {
    const { SENTRY_AUTH_TOKEN: sentryAuthToken } = loadEnv(mode, process.cwd(), '');
    const isWeb = mode === 'web';

    const buildAndUploadSourceMaps = !!sentryAuthToken && !isWeb;

    const baseVersion = fs.readFileSync(new URL('../Version', import.meta.url), 'utf-8').trim();
    const version = isWeb ? resolveWebCloudVersion(baseVersion) : baseVersion;

    const nightly = mode === 'development' || version.split('-').at(-1)?.length === 7;

    /** @type {import('vite').UserConfig} */
    return {
        base: isWeb ? '/' : '',
        plugins: [
            remixiconWoff2Only(),
            vue(),
            vueJsx({
                tsTransform: 'built-in'
            }),
            tailwindcss(),
            buildAndUploadSourceMaps &&
                import('@sentry/vite-plugin').then(({ sentryVitePlugin }) =>
                    sentryVitePlugin({
                        authToken: sentryAuthToken,
                        project: 'vrcx-web',
                        release: {
                            name: version
                        },
                        sourcemaps: {
                            assets: './build/html/**',
                            filesToDeleteAfterUpload: './build/html/**/*.js.map',
                            ignore: []
                        }
                    })
                )
        ],
        resolve: {
            alias: {
                '@': resolve(import.meta.dirname, '.')
            }
        },
        css: {
            transformer: 'lightningcss',
            lightningcss: {
                drafts: {
                    customMedia: true
                },
                errorRecovery: true,
                targets: browserslistToTargets(
                    browserslist(isWeb ? 'chrome >= 115, safari >= 16, firefox >= 115' : 'Chrome 145')
                )
            }
        },
        optimizeDeps: {
            include: [
                'vue',
                'vue/jsx-runtime',
                'reka-ui',
                'pinia',
                'vue-i18n',
                'tailwindcss',
                'lucide-vue-next',
                '@vueuse/core',
                'vue-sonner',
                'dayjs'
            ]
        },
        define: {
            VERSION: JSON.stringify(version),
            NIGHTLY: JSON.stringify(nightly),
            WEB: JSON.stringify(isWeb),
            ...(isWeb ? { WINDOWS: 'false', LINUX: 'false' } : {})
        },
        server: {
            port: 9000,
            strictPort: true,
            ...(isWeb
                ? {
                      proxy: {
                          '/api': 'http://127.0.0.1:8787',
                          '/health': 'http://127.0.0.1:8787',
                          '/poc': 'http://127.0.0.1:8787',
                          '/ws': {
                              target: 'http://127.0.0.1:8787',
                              ws: true
                          }
                      }
                  }
                : {})
        },
        build: {
            target: isWeb ? ['es2022', 'chrome115', 'safari16', 'firefox115'] : 'chrome145',
            outDir: isWeb ? '../build/web' : '../build/html',
            license: true,
            emptyOutDir: true,
            copyPublicDir: true,
            reportCompressedSize: false,
            chunkSizeWarningLimit: 5000,
            sourcemap: buildAndUploadSourceMaps ? 'hidden' : false,
            assetsInlineLimit(filePath, content) {
                if (isFont(filePath)) return false;
                if (filePath.endsWith('.json')) return false;
                if (filePath.includes('/styles/themes/') || filePath.includes('\\styles\\themes\\')) return false;
                return content.length <= 40960;
            },
            rolldownOptions: {
                preserveEntrySignatures: false,
                input: isWeb
                    ? { index: resolve(import.meta.dirname, './index.html') }
                    : {
                          index: resolve(import.meta.dirname, './index.html'),
                          vr: resolve(import.meta.dirname, './vr.html')
                      },
                output: {
                    assetFileNames: createAssetFilenameResolver(isWeb),
                    manualChunks: getManualChunk,
                    strictExecutionOrder: true
                }
            }
        }
    };
});
