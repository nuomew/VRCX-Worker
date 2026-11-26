import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    cloudFetch: vi.fn(),
    connectCloudHubWs: vi.fn(),
    onCloudChatEvent: vi.fn(),
    onCloudCommandResult: vi.fn(),
    translateText: vi.fn(),
    setTranslationApi: vi.fn(),
    confirm: vi.fn(),
    getString: vi.fn(),
    setString: vi.fn(),
    chatListeners: [],
    cmdListeners: []
}));

const translationApi = ref(true);
const translationApiKey = ref('test-key');
const translationApiType = ref('openai');
const translationApiEndpoint = ref('https://api.openai.com/v1/chat/completions');
const translationApiModel = ref('gpt-4o-mini');
const translationApiPrompt = ref('');

vi.mock('vue-router', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useRouter: () => ({ push: mocks.push })
    };
});

vi.mock('vue-i18n', () => ({
    useI18n: () => ({ t: (key) => key })
}));

vi.mock('pinia', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        storeToRefs: (store) => store
    };
});

vi.mock('vue-sonner', () => ({
    toast: {
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('@/ipc-web/apiClient', () => ({
    cloudFetch: (...args) => mocks.cloudFetch(...args),
    connectCloudHubWs: (...args) => mocks.connectCloudHubWs(...args),
    onCloudChatEvent: (fn) => {
        mocks.chatListeners.push(fn);
        mocks.onCloudChatEvent(fn);
        return () => {
            const idx = mocks.chatListeners.indexOf(fn);
            if (idx >= 0) mocks.chatListeners.splice(idx, 1);
        };
    },
    onCloudCommandResult: (fn) => {
        mocks.cmdListeners.push(fn);
        mocks.onCloudCommandResult(fn);
        return () => {
            const idx = mocks.cmdListeners.indexOf(fn);
            if (idx >= 0) mocks.cmdListeners.splice(idx, 1);
        };
    }
}));

vi.mock('@/services/config', () => ({
    default: {
        getString: (...args) => mocks.getString(...args),
        setString: (...args) => mocks.setString(...args)
    }
}));

vi.mock('@/stores', () => ({
    useAdvancedSettingsStore: () => ({
        translationApi,
        translationApiKey,
        translationApiType,
        translationApiEndpoint,
        translationApiModel,
        translationApiPrompt,
        translateText: (...args) => mocks.translateText(...args),
        setTranslationApi: (...args) => mocks.setTranslationApi(...args)
    }),
    useModalStore: () => ({
        confirm: (...args) => mocks.confirm(...args)
    })
}));

vi.mock('@/components/ui/dialog', () => ({
    Dialog: {
        name: 'Dialog',
        props: ['open'],
        emits: ['update:open'],
        template: '<div v-if="open" class="mock-osc-dialog"><slot /></div>'
    },
    DialogContent: { template: '<div class="mock-osc-dialog-content"><slot /></div>' },
    DialogHeader: { template: '<div><slot /></div>' },
    DialogTitle: { template: '<h3><slot /></h3>' },
    DialogDescription: { template: '<p><slot /></p>' },
    DialogFooter: { template: '<div><slot /></div>' }
}));

vi.mock('@/views/Settings/dialogs/TranslationApiDialog.vue', () => ({
    default: {
        name: 'TranslationApiDialog',
        template: '<div class="mock-translation-dialog" />',
        props: ['isTranslationApiDialogVisible']
    }
}));

import ChatTranslator from '../ChatTranslator.vue';
import {
    buildChatTranslationPrompt,
    composeOscChatboxPayload,
    normalizeOscPort,
    sanitizeOscChatboxText,
    VRC_OSC_MAX_CHARS,
    VRC_OSC_MAX_LINES
} from '../chatTranslatorUtils';

describe('chatTranslatorUtils', () => {
    test('enforces VRChat 144-char and 9-line limits while preserving emoji code points', () => {
        const elevenLines = Array.from({ length: 11 }, (_, i) => `L${i + 1}`).join('\n');
        const lineRes = sanitizeOscChatboxText(elevenLines);
        expect(lineRes.truncated).toBe(true);
        expect(lineRes.lineCount).toBe(VRC_OSC_MAX_LINES);
        expect(lineRes.text.endsWith('L9')).toBe(true);

        const emoji150 = '😀'.repeat(150);
        const emojiRes = sanitizeOscChatboxText(emoji150);
        expect(emojiRes.truncated).toBe(true);
        expect(emojiRes.charCount).toBe(VRC_OSC_MAX_CHARS);
        expect(Array.from(emojiRes.text)).toHaveLength(VRC_OSC_MAX_CHARS);

        const ctrl = sanitizeOscChatboxText('hello\u0000\u0007\r\nworld');
        expect(ctrl.text).toBe('hello\nworld');
    });

    test('composes OSC chatbox payload across all display modes', () => {
        expect(
            composeOscChatboxPayload({
                sourceText: '你好',
                translatedText: 'Hello',
                displayMode: 'translated_only'
            }).text
        ).toBe('Hello');

        expect(
            composeOscChatboxPayload({
                sourceText: '你好',
                translatedText: 'Hello',
                displayMode: 'translated_and_source'
            }).text
        ).toBe('Hello\n(你好)');

        expect(
            composeOscChatboxPayload({
                sourceText: '你好',
                translatedText: 'Hello',
                displayMode: 'source_and_translated'
            }).text
        ).toBe('你好\n(Hello)');

        expect(
            composeOscChatboxPayload({
                sourceText: '你好',
                translatedText: 'Hello',
                displayMode: 'source_only'
            }).text
        ).toBe('你好');
    });

    test('normalizes OSC port bounds and builds prompt', () => {
        expect(normalizeOscPort(9000)).toBe(9000);
        expect(normalizeOscPort('9005')).toBe(9005);
        expect(normalizeOscPort(80, 9000)).toBe(9000);
        expect(normalizeOscPort(70000, 9000)).toBe(9000);

        expect(buildChatTranslationPrompt('zh-CN', 'ja', 'Custom prompt')).toBe('Custom prompt');
        expect(buildChatTranslationPrompt('zh-CN', 'ja', '')).toContain('Simplified Chinese');
        expect(buildChatTranslationPrompt('zh-CN', 'ja', '')).toContain('Japanese');
    });
});

describe('ChatTranslator.vue', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.chatListeners.length = 0;
        mocks.cmdListeners.length = 0;
        vi.stubGlobal('WEB', true);
        translationApi.value = true;
        translationApiType.value = 'openai';
        translationApiEndpoint.value = 'https://api.openai.com/v1/chat/completions';
        translationApiModel.value = 'gpt-4o-mini';
        mocks.getString.mockResolvedValue('');
        mocks.confirm.mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('defaults translation OFF and sends original text without requiring a translation API, even if translation is toggled ON unconfigured', async () => {
        translationApi.value = false;
        translationApiKey.value = '';
        translationApiEndpoint.value = '';
        translationApiModel.value = '';

        mocks.cloudFetch.mockImplementation(async (url, opts) => {
            if (url.startsWith('/api/chat/messages') && (!opts || !opts.method || opts.method === 'GET')) {
                return {
                    chatDbDedicated: true,
                    config: {
                        oscEnabled: true,
                        oscSendPort: 9000,
                        oscListenEnabled: false,
                        oscListenPort: 9002,
                        oscForwardToVrchat: true,
                        translateEnabled: false,
                        sourceLang: 'auto',
                        targetLang: 'en',
                        displayMode: 'translated_and_source',
                        immediate: true,
                        playSfx: true,
                        syncTyping: false,
                        autoTranslateDesktop: false,
                        targetDeviceId: ''
                    },
                    messages: [],
                    devices: []
                };
            }
            if (url === '/api/chat/config' && opts?.method === 'PUT') {
                return { chatDbDedicated: true, pushedAgents: 0, config: opts.json };
            }
            if (url === '/api/chat/send' && opts?.method === 'POST') {
                return {
                    deliveryStatus: 'dispatched',
                    message: {
                        id: 'chat_orig_1',
                        direction: 'web_to_vrc',
                        sourceText: opts.json.sourceText,
                        translatedText: '',
                        sentText: opts.json.sentText,
                        oscPort: 9000,
                        status: 'dispatched',
                        createdAt: '2026-11-26T10:00:00.000Z'
                    }
                };
            }
            return {};
        });

        const wrapper = mount(ChatTranslator);
        await flushPromises();

        // Translation is OFF by default, OSC dialog is closed, and zero native checkboxes are rendered
        expect(wrapper.find('.mock-osc-dialog').exists()).toBe(false);
        expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
        expect(wrapper.text()).toContain('view.tools.chat_translator.translate_off_hint');

        const textarea = wrapper.find('textarea');
        await textarea.setValue('直接发原文给 VRChat');
        const sendBtn = wrapper
            .findAll('button')
            .find((b) => b.text().includes('view.tools.chat_translator.send_direct_btn'));
        expect(sendBtn).toBeTruthy();
        await sendBtn.trigger('click');
        await flushPromises();

        expect(mocks.translateText).not.toHaveBeenCalled();
        expect(mocks.cloudFetch).toHaveBeenCalledWith(
            '/api/chat/send',
            expect.objectContaining({
                method: 'POST',
                json: expect.objectContaining({
                    sourceText: '直接发原文给 VRChat',
                    translatedText: '',
                    sentText: '直接发原文给 VRChat',
                    displayMode: 'source_only'
                })
            })
        );

        // Even if user enables translation via Switch without configuring an API, sending still sends original text cleanly
        const translateSwitch = wrapper.find(
            'button[role="switch"][aria-label="view.tools.chat_translator.translate_enabled_label"]'
        );
        expect(translateSwitch.exists()).toBe(true);
        await translateSwitch.trigger('click');
        await flushPromises();

        await textarea.setValue('未配置接口也发原文');
        const directBtnAgain = wrapper
            .findAll('button')
            .find((b) => b.text().includes('view.tools.chat_translator.send_direct_btn'));
        expect(directBtnAgain).toBeTruthy();
        await directBtnAgain.trigger('click');
        await flushPromises();

        expect(mocks.translateText).not.toHaveBeenCalled();
        expect(mocks.cloudFetch).toHaveBeenCalledWith(
            '/api/chat/send',
            expect.objectContaining({
                method: 'POST',
                json: expect.objectContaining({
                    sentText: '未配置接口也发原文',
                    displayMode: 'source_only'
                })
            })
        );

        wrapper.unmount();
    });

    test('loads synced messages, translates & sends when translation is enabled, and configures OSC in modal dialog', async () => {
        mocks.cloudFetch.mockImplementation(async (url, opts) => {
            if (url.startsWith('/api/chat/messages') && (!opts || !opts.method || opts.method === 'GET')) {
                return {
                    chatDbDedicated: true,
                    config: {
                        oscEnabled: true,
                        oscSendPort: 9000,
                        oscListenEnabled: false,
                        oscListenPort: 9002,
                        oscForwardToVrchat: true,
                        translateEnabled: true,
                        sourceLang: 'auto',
                        targetLang: 'en',
                        displayMode: 'translated_and_source',
                        immediate: true,
                        playSfx: true,
                        syncTyping: false,
                        autoTranslateDesktop: false,
                        targetDeviceId: ''
                    },
                    messages: [
                        {
                            id: 'osc_sync_1',
                            direction: 'desktop_sync',
                            sourceText: 'こんにちは',
                            translatedText: '',
                            sentText: 'こんにちは',
                            sourceLang: 'auto',
                            targetLang: '',
                            oscPort: 9000,
                            status: 'synced',
                            createdAt: '2026-11-26T10:00:00.000Z'
                        }
                    ],
                    devices: [
                        {
                            deviceId: 'win-desk-1',
                            deviceName: 'Main-PC',
                            online: true,
                            vrcRunning: true,
                            osc: {
                                enabled: true,
                                sendPort: 9000,
                                listenEnabled: true,
                                listenPort: 9002,
                                forwardToVrchat: true,
                                listenError: ''
                            }
                        }
                    ]
                };
            }
            if (url === '/api/chat/config' && opts?.method === 'PUT') {
                return {
                    chatDbDedicated: true,
                    pushedAgents: 1,
                    config: opts.json
                };
            }
            if (url === '/api/chat/send' && opts?.method === 'POST') {
                return {
                    deliveryStatus: 'dispatched',
                    message: {
                        id: 'chat_sent_1',
                        direction: 'web_to_vrc',
                        sourceText: '你好世界',
                        translatedText: 'Hello world',
                        sentText: 'Hello world\n(你好世界)',
                        sourceLang: 'auto',
                        targetLang: 'en',
                        oscPort: 9000,
                        status: 'dispatched',
                        createdAt: '2026-11-26T10:01:00.000Z'
                    }
                };
            }
            return {};
        });
        mocks.translateText.mockResolvedValue('Hello world');

        const wrapper = mount(ChatTranslator);
        await flushPromises();

        expect(wrapper.text()).toContain('こんにちは');

        const textarea = wrapper.find('textarea');
        await textarea.setValue('你好世界');

        const sendBtn = wrapper
            .findAll('button')
            .find((b) => b.text().includes('view.tools.chat_translator.translate_and_send_btn'));
        expect(sendBtn).toBeTruthy();
        await sendBtn.trigger('click');
        await flushPromises();

        expect(mocks.translateText).toHaveBeenCalledWith(
            '你好世界',
            'en',
            expect.objectContaining({ type: 'openai' })
        );
        expect(mocks.cloudFetch).toHaveBeenCalledWith(
            '/api/chat/send',
            expect.objectContaining({
                method: 'POST',
                json: expect.objectContaining({
                    sourceText: '你好世界',
                    translatedText: 'Hello world',
                    sentText: 'Hello world\n(你好世界)',
                    oscPort: 9000,
                    sendToVrc: true
                })
            })
        );
        expect(mocks.connectCloudHubWs).toHaveBeenCalled();
        expect(wrapper.text()).toContain('Hello world');

        // Instant WebSocket delivery of incoming desktop OSC message & delivery receipt without polling
        for (const fn of mocks.chatListeners) {
            fn({
                type: 'chat.agent_status',
                payload: {
                    deviceId: 'win-desk-1',
                    connected: true,
                    osc: { deviceName: 'Main-PC', vrcRunning: true, sendPort: 9000, listenEnabled: true, listenPort: 9002 }
                }
            });
            fn({
                type: 'chat.message',
                payload: {
                    message: {
                        id: 'osc_instant_2',
                        direction: 'desktop_sync',
                        sourceText: '实时游戏打字消息',
                        translatedText: '',
                        sentText: '实时游戏打字消息',
                        oscPort: 9000,
                        status: 'synced',
                        createdAt: '2026-11-26T10:02:00.000Z'
                    }
                }
            });
            fn({
                type: 'chat.message',
                payload: {
                    message: {
                        id: 'peer_msg_1',
                        direction: 'peer_incoming',
                        senderName: 'Alice',
                        sourceText: 'Hi from another player',
                        translatedText: '',
                        sentText: 'Hi from another player',
                        oscPort: 9000,
                        status: 'synced',
                        createdAt: '2026-11-26T10:02:30.000Z'
                    }
                }
            });
        }
        for (const fn of mocks.cmdListeners) {
            fn({
                type: 'cmd.result',
                payload: { chatMsgId: 'chat_sent_1', status: 'succeeded', message: 'Sent OSC' }
            });
        }
        await flushPromises();

        expect(wrapper.text()).toContain('view.tools.chat_translator.agent_realtime');
        expect(wrapper.text()).toContain('view.tools.chat_translator.dedicated_db_badge');
        expect(wrapper.text()).toContain('实时游戏打字消息');
        expect(wrapper.text()).toContain('Hi from another player');
        expect(wrapper.text()).toContain('view.tools.chat_translator.status_sent');

        // Self messages (web_to_vrc & desktop_sync) align right; peer_incoming aligns left
        const rightRows = wrapper.findAll('[data-msg-side="right"]');
        const leftRows = wrapper.findAll('[data-msg-side="left"]');
        expect(rightRows.some((el) => el.text().includes('Hello world'))).toBe(true);
        expect(rightRows.some((el) => el.text().includes('实时游戏打字消息'))).toBe(true);
        expect(leftRows.some((el) => el.text().includes('Hi from another player'))).toBe(true);

        // Clicking Cloud OSC Settings opens modal dialog (not inline expansion) and toggling relay saves to PUT /api/chat/config
        expect(wrapper.find('.mock-osc-dialog').exists()).toBe(false);
        const oscSettingsBtn = wrapper
            .findAll('button')
            .find((b) => b.text().includes('view.tools.chat_translator.osc_settings_btn'));
        expect(oscSettingsBtn).toBeTruthy();
        await oscSettingsBtn.trigger('click');
        await flushPromises();
        expect(wrapper.find('.mock-osc-dialog').exists()).toBe(true);
        expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);

        const listenSwitch = wrapper
            .find('.mock-osc-dialog')
            .find('button[role="switch"][aria-label="view.tools.chat_translator.osc_listen_enabled_label"]');
        expect(listenSwitch.exists()).toBe(true);
        await listenSwitch.trigger('click');
        await flushPromises();

        expect(mocks.cloudFetch).toHaveBeenCalledWith(
            '/api/chat/config',
            expect.objectContaining({
                method: 'PUT',
                json: expect.objectContaining({
                    oscEnabled: true,
                    oscSendPort: 9000,
                    oscListenEnabled: true,
                    oscListenPort: 9002,
                    oscForwardToVrchat: true,
                    translateEnabled: true
                })
            })
        );

        wrapper.unmount();
    });

    test('renders gray-off/green-on switches and prevents stale GET polls or WS echoes from bouncing rapid toggle clicks', async () => {
        let resolveStaleGet;
        let putResolvers = [];
        const putPayloads = [];
        let getCallCount = 0;

        mocks.cloudFetch.mockImplementation((url, opts) => {
            if (url.startsWith('/api/chat/messages') && (!opts || !opts.method || opts.method === 'GET')) {
                getCallCount += 1;
                if (getCallCount === 1) {
                    return new Promise((resolve) => {
                        resolveStaleGet = resolve;
                    });
                }
                return Promise.resolve({ chatDbDedicated: true, messages: [], devices: [] });
            }
            if (url === '/api/chat/config' && opts?.method === 'PUT') {
                putPayloads.push({ ...opts.json });
                return new Promise((resolve) => {
                    putResolvers.push(resolve);
                });
            }
            return Promise.resolve({});
        });

        const wrapper = mount(ChatTranslator);
        await flushPromises();

        const translateSwitch = wrapper.find(
            'button[role="switch"][aria-label="view.tools.chat_translator.translate_enabled_label"]'
        );
        expect(translateSwitch.exists()).toBe(true);
        // Verify gray off / green on classes
        expect(translateSwitch.classes().join(' ')).toContain('data-[state=checked]:bg-emerald-500');
        expect(translateSwitch.classes().join(' ')).toContain('data-[state=unchecked]:bg-zinc-400/75');
        expect(translateSwitch.attributes('data-state')).toBe('unchecked');

        // 1. User toggles ON while initial GET /api/chat/messages (with old translateEnabled: false) is still in flight
        await translateSwitch.trigger('click');
        await flushPromises();
        expect(translateSwitch.attributes('data-state')).toBe('checked');
        expect(putPayloads).toHaveLength(1);
        expect(putPayloads[0].translateEnabled).toBe(true);

        // Stale GET resolves with old false -> MUST NOT bounce switch back to unchecked!
        resolveStaleGet({
            chatDbDedicated: true,
            config: { oscEnabled: true, translateEnabled: false },
            messages: [],
            devices: []
        });
        await flushPromises();
        expect(translateSwitch.attributes('data-state')).toBe('checked');

        // 2. While PUT #1 (true) is still in flight, user immediately toggles OFF
        await translateSwitch.trigger('click');
        await flushPromises();
        expect(translateSwitch.attributes('data-state')).toBe('unchecked');
        // Must serialize PUTs (only 1 in flight at a time, never race PUT #2 concurrently with PUT #1)
        expect(putPayloads).toHaveLength(1);

        // Echo WS `chat.config_updated` from PUT #1 (true) arrives -> MUST NOT bounce switch back to checked!
        for (const fn of mocks.chatListeners) {
            fn({
                type: 'chat.config_updated',
                payload: { config: { oscEnabled: true, translateEnabled: true } }
            });
        }
        await flushPromises();
        expect(translateSwitch.attributes('data-state')).toBe('unchecked');

        // PUT #1 resolves -> serialized queue immediately dispatches PUT #2 with final OFF state (false)
        putResolvers.shift()({ chatDbDedicated: true, config: { oscEnabled: true, translateEnabled: true } });
        await flushPromises();
        expect(translateSwitch.attributes('data-state')).toBe('unchecked');
        expect(putPayloads).toHaveLength(2);
        expect(putPayloads[1].translateEnabled).toBe(false);

        // PUT #2 resolves -> stays cleanly unchecked
        putResolvers.shift()({ chatDbDedicated: true, config: { oscEnabled: true, translateEnabled: false } });
        await flushPromises();
        expect(translateSwitch.attributes('data-state')).toBe('unchecked');

        wrapper.unmount();
    });

    test('loads latest 20 messages oldest-to-newest (latest at bottom), displays YYYY-MM-DD HH:mm timestamps, and auto-loads older pages when scrolling up', async () => {
        const requestedUrls = [];
        const page1 = Array.from({ length: 20 }, (_, i) => {
            const idx = 25 - i; // 25 down to 6 (API returns newest first)
            const minute = String(idx).padStart(2, '0');
            return {
                id: `msg_${String(idx).padStart(2, '0')}`,
                direction: 'web_to_vrc',
                sourceText: `消息 #${idx}`,
                translatedText: '',
                sentText: `消息 #${idx}`,
                oscPort: 9000,
                status: 'sent',
                createdAt: `2026-11-26T10:${minute}:00.000Z`
            };
        });
        const page2 = Array.from({ length: 5 }, (_, i) => {
            const idx = 5 - i; // 5 down to 1
            const minute = String(idx).padStart(2, '0');
            return {
                id: `msg_${String(idx).padStart(2, '0')}`,
                direction: 'web_to_vrc',
                sourceText: `消息 #${idx}`,
                translatedText: '',
                sentText: `消息 #${idx}`,
                oscPort: 9000,
                status: 'sent',
                createdAt: `2026-11-26T10:${minute}:00.000Z`
            };
        });

        mocks.cloudFetch.mockImplementation(async (url, opts) => {
            if (url.startsWith('/api/chat/messages') && (!opts || !opts.method || opts.method === 'GET')) {
                requestedUrls.push(url);
                if (url.includes('before=')) {
                    return {
                        chatDbDedicated: true,
                        messages: page2,
                        hasMore: false,
                        nextBefore: '',
                        nextBeforeId: ''
                    };
                }
                return {
                    chatDbDedicated: true,
                    config: { oscEnabled: true, translateEnabled: false },
                    messages: page1,
                    hasMore: true,
                    nextBefore: page1[19].createdAt,
                    nextBeforeId: page1[19].id,
                    devices: []
                };
            }
            return {};
        });

        const wrapper = mount(ChatTranslator);
        await flushPromises();

        // Initial load requests limit=20 only, orders older messages at top and latest message at bottom
        expect(requestedUrls).toEqual(['/api/chat/messages?limit=20']);
        const initialRows = wrapper.findAll('[data-msg-side]');
        expect(initialRows).toHaveLength(20);
        expect(initialRows[0].text()).toContain('消息 #6');
        expect(initialRows[19].text()).toContain('消息 #25');
        expect(wrapper.text()).not.toContain('消息 #5');
        expect(wrapper.text()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        expect(wrapper.find('[data-load-more-sentinel="top"]').exists()).toBe(true);

        // Simulate scrolling up to the top of the message list -> auto-loads earlier page 2 above existing messages
        const feedEl = wrapper.find('.overflow-y-auto');
        Object.defineProperty(feedEl.element, 'scrollHeight', {
            get: () => feedEl.element.querySelectorAll('[data-msg-side]').length * 60,
            configurable: true
        });
        Object.defineProperty(feedEl.element, 'clientHeight', { value: 400, configurable: true });
        feedEl.element.scrollTop = 20;

        await feedEl.trigger('scroll');
        await flushPromises();

        expect(requestedUrls).toHaveLength(2);
        expect(requestedUrls[1]).toContain('limit=20');
        expect(requestedUrls[1]).toContain(`before=${encodeURIComponent(page1[19].createdAt)}`);
        expect(requestedUrls[1]).toContain('beforeId=msg_06');
        const allRows = wrapper.findAll('[data-msg-side]');
        expect(allRows).toHaveLength(25);
        expect(allRows[0].text()).toContain('消息 #1');
        expect(allRows[24].text()).toContain('消息 #25');
        // Reading anchor preserved: previous scrollTop (20) + prepended 5 rows * 60px (300) = 320
        expect(feedEl.element.scrollTop).toBe(320);
        expect(wrapper.text()).toContain('view.tools.chat_translator.no_more_messages');

        // New real-time incoming message appends at the bottom (last item)
        for (const fn of mocks.chatListeners) {
            fn({
                type: 'chat.message',
                payload: {
                    message: {
                        id: 'msg_26',
                        direction: 'web_to_vrc',
                        sourceText: '消息 #26',
                        translatedText: '',
                        sentText: '消息 #26',
                        oscPort: 9000,
                        status: 'sent',
                        createdAt: '2026-11-26T10:26:00.000Z'
                    }
                }
            });
        }
        await flushPromises();
        const updatedRows = wrapper.findAll('[data-msg-side]');
        expect(updatedRows).toHaveLength(26);
        expect(updatedRows[25].text()).toContain('消息 #26');

        wrapper.unmount();
    });
});
