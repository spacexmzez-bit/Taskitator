// Phase 7.3: ChatGPT (gpt-6-luna) as a personal-key provider; per-page Copilot knowledge.
// Worker behaviour for ChatGPT is covered end to end in security.test.js ("Phase 7.3: ...").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PROVIDERS, toOpenAIRequest, fromOpenAIResponse, estimateOpenAIInput, providerUsage } from './worker.js';
import { modelCost } from './pro-backend.js';
import './copilot-knowledge.js';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const K = globalThis.TaskitatorCopilotKnowledge;

test('ChatGPT provider, price table and usage', () => {
    assert.deepEqual(PROVIDERS.openai, { name: 'ChatGPT', models: ['gpt-6-luna'] });
    assert.equal(modelCost('gpt-6-luna', 1000, 1000), 1000 * 10 + 1000 * 50, '$0.10 / $0.50 per 1M');
    assert.equal(modelCost('gpt-6-luna', 300000, 10), 300000 * 20 + 10 * 75, 'over 272K: 2x input, 1.5x output');
    assert.deepEqual(providerUsage('openai', { usage: { input_tokens: 40, output_tokens: 9, input_tokens_details: { cached_tokens: 30 } } }), { input: 40, output: 9 });
    assert.equal(providerUsage('openai', { usage: { input_tokens: -1, output_tokens: 1 } }), null);
});

test('ChatGPT request adapter: provider switch mid-conversation, empty turns, dangling tool calls', () => {
    const base = { generationConfig: { maxOutputTokens: 100 } };
    assert.throws(() => toOpenAIRequest({ ...base, contents: [{ role: 'user', parts: [{ text: 'x' }] }, { role: 'model', parts: [{ thoughtSignature: 'abc' }] }, { role: 'user', parts: [{ text: 'z' }] }] }), /Start a new conversation/);
    assert.throws(() => toOpenAIRequest({ ...base, contents: [{ role: 'user', parts: [{ text: 'x' }] }, { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'get_tasks', args: {} } }] }] }), /complete tool results/);
    assert.throws(() => toOpenAIRequest({ ...base, contents: [{ role: 'user', parts: [{ functionResponse: { id: 'nope', name: 'get_tasks', response: {} } }] }] }), /does not match/);
    const r = toOpenAIRequest({ ...base, contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
    assert.equal(r.max_output_tokens, 100); assert.equal(r.store, false); assert.equal(r.tools, undefined);
    assert.ok(estimateOpenAIInput(r) >= Math.ceil('hello'.length / 2));
    assert.ok(estimateOpenAIInput({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:' }] }] }) >= 3000, 'images estimated high');
});

test('ChatGPT response adapter keeps text, skips reasoning, rejects empty answers', () => {
    const out = fromOpenAIResponse({ status: 'completed', model: 'gpt-6-luna', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }], usage: { input_tokens: 3, output_tokens: 1 } });
    assert.deepEqual(out.candidates[0].content.parts, [{ text: 'Hi' }]);
    assert.equal(out.usageMetadata.promptTokenCount, 3);
    assert.throws(() => fromOpenAIResponse({ status: 'completed', output: [{ type: 'reasoning' }] }), /empty response/);
    assert.throws(() => fromOpenAIResponse({ status: 'failed', output: [] }), /unsupported or incomplete/);
    assert.throws(() => fromOpenAIResponse({ status: 'completed', output: [{ type: 'web_search_call' }] }), /unsupported/);
});

test('Settings and client know ChatGPT; key guidance says it is an OpenAI API key', () => {
    const s = read('settings.html'), p = read('pro.js');
    assert.match(s, /<option value="openai">ChatGPT<\/option>/);
    assert.match(s, /Gemini, Claude and ChatGPT each keep their own key/);
    assert.match(p, /openai:\['gpt-6-luna'\]/); assert.match(p, /openai:'ChatGPT'/);
    assert.match(p, /A ChatGPT Plus or Pro subscription doesn’t include API access/);
    assert.match(p, /provider === 'claude' \|\| provider === 'openai'/, 'large photos resized for ChatGPT too');
    assert.match(read('worker.js'), /Choose Gemini, Claude or ChatGPT\./);
});

test('Copilot knowledge: every page has an entry within budget', () => {
    const pages = ['today', 'general', 'calendar', 'projects', 'stats', 'trash', 'friends', 'study_plans', 'sleep', 'universe', 'help', 'blocker_guide'];
    assert.ok(K.MAP.length <= 560, 'MAP ' + K.MAP.length);
    for (const p of pages) {
        assert.ok(K.PAGES[p], p);
        assert.ok(K.PAGES[p].length <= 1900, p + ' ' + K.PAGES[p].length);
        assert.ok(K.forPage(p).startsWith(K.MAP));
    }
    for (const t of ['general', 'tasks', 'schedule', 'ai', 'phone', 'account']) {
        const full = K.forPage('settings', t);
        assert.ok(full.length <= 2300, 'settings.' + t + ' ' + full.length);
        assert.ok(full.includes('OPEN TAB: ' + K.SETTINGS[t]));
        for (const other of ['general', 'tasks', 'schedule', 'ai', 'phone', 'account'].filter(x => x !== t)) assert.ok(!full.includes(K.SETTINGS[other]), 'only the open tab is sent');
    }
    assert.equal(K.forPage('legal'), K.MAP);
});

test('Copilot knowledge covers the new features where they live', () => {
    const has = (text, ...words) => words.forEach(w => assert.ok(text.includes(w), w));
    has(K.PAGES.today, 'Points strip', '150', 'Make today required', 'free days', 'Emergency Bypass', 'AI-locked');
    has(K.PAGES.friends, 'Duo streak', 'Cheer', 'Block', 'Collab', 'Pro for every member', 'Privacy');
    has(K.SETTINGS.schedule, 'Streak free days', 'Streak counting', 'Loose', 'Normal', 'Tight', 'next week');
    has(K.SETTINGS.ai, 'ChatGPT', 'platform.openai.com', 'GPT-6 Luna', 'subscription does not include API access');
    has(K.SETTINGS.tasks, 'Harsh', 'Limited', 'Loosening');
    has(K.PAGES.stats, 'Rigor Ratio', 'logical day');
    assert.ok(!K.PAGES.today.includes('platform.openai.com'), 'Today does not carry Settings details');
});

test('Copilot sends knowledge for the current page only; Friends and Universe get their own pages', () => {
    const app = read('app.js');
    assert.match(app, /const knowledge = window\.TaskitatorCopilotKnowledge\?\.forPage\?\.\(page\);/);
    assert.match(app, /friends: 'friends'/);
    assert.match(app, /if \(view === 'universe'\) return 'universe';/);
    assert.match(app, /const activeTools = \(pageContext === 'today' \|\| pageContext === 'general'\)/, 'new pages stay read-only');
    for (const f of ['index.html', 'components.html', 'settings.html']) {
        const h = read(f), k = h.indexOf('src="copilot-knowledge.js'), a = h.search(/src="app\.js/);
        assert.ok(k > 0 && k < a, f + ': knowledge loads before app.js');
    }
    assert.match(read('sw.js'), /'\.\/copilot-knowledge\.js'/);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v78'/);
});
