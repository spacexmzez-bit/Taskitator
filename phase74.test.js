// Phase 7.4: title shortcuts match the user's own priority names and rank numbers; mention list for ! # @;
// the live tour card keeps its scroll position (Next stays reachable on phones).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const components = read('components.js');
const source = components.match(/\/\/ <<< MODULE_START: nlp-match\.js >>>([\s\S]*?)\/\/ <<< MODULE_END: nlp-match\.js >>>/)[1];
const context = vm.createContext({});
vm.runInContext(source.replace('})(globalThis);', '})(this);'), context);
const M = context.TaskitatorNlpMatch;
const plain = x => JSON.parse(JSON.stringify(x));   // values from the vm context have another realm's prototypes

// Ranks deliberately out of order in the array: matching goes by rank, not by position in storage.
const PRIOS = [
    { id: 'low', name: 'Low', rank: 4 },
    { id: 'high', name: 'High', rank: 1 },
    { id: 'norm', name: 'Normal', rank: 3 },
    { id: 'med', name: 'Medium', rank: 2 }
];
const id = p => p && p.id;

test('priority: the user\'s own names, any case, spaces ignored', () => {
    assert.equal(id(M.priority(PRIOS, 'normal')), 'norm');
    assert.equal(id(M.priority(PRIOS, 'NORMAL')), 'norm');
    assert.equal(id(M.priority(PRIOS, 'High')), 'high');
    const spaced = [{ id: 'vh', name: 'Very High', rank: 1 }, { id: 'x', name: 'Later', rank: 2 }];
    assert.equal(id(M.priority(spaced, 'veryhigh')), 'vh');
    assert.equal(id(M.priority(spaced, 'VeryHigh')), 'vh');
    const arabic = [{ id: 'u', name: 'عاجل جدا', rank: 1 }, { id: 'n', name: 'عادي', rank: 2 }];
    assert.equal(id(M.priority(arabic, 'عاجلجدا')), 'u');
    assert.equal(id(M.priority(arabic, 'عادي')), 'n');
});

test('priority: rank numbers count from the top, with or without p, Arabic digits too', () => {
    assert.equal(id(M.priority(PRIOS, '1')), 'high');
    assert.equal(id(M.priority(PRIOS, '3')), 'norm');
    assert.equal(id(M.priority(PRIOS, 'p3')), 'norm');
    assert.equal(id(M.priority(PRIOS, 'P4')), 'low');
    assert.equal(id(M.priority(PRIOS, '4')), 'low', 'low is the fourth level here, not rank 3');
    assert.equal(id(M.priority(PRIOS, '٢')), 'med');
    assert.equal(id(M.priority(PRIOS, '۳')), 'norm');
    assert.equal(M.priority(PRIOS, '0'), null);
    assert.equal(M.priority(PRIOS, '5'), null);
    // Gaps in stored ranks: position in rank order decides.
    const gaps = [{ id: 'a', name: 'A', rank: 10 }, { id: 'b', name: 'B', rank: 20 }, { id: 'c', name: 'C', rank: 30 }];
    assert.equal(id(M.priority(gaps, '2')), 'b');
});

test('priority: name beats number, unique start works, ambiguous or unknown stays text', () => {
    const numbered = [{ id: 'one', name: 'Top', rank: 1 }, { id: 'two', name: '3', rank: 2 }, { id: 'three', name: 'Bottom', rank: 3 }];
    assert.equal(id(M.priority(numbered, '3')), 'two', 'a level named "3" wins over the third level');
    assert.equal(id(M.priority(PRIOS, 'med')), 'med');
    assert.equal(id(M.priority(PRIOS, 'n')), 'norm');
    assert.equal(id(M.priority(PRIOS, 'h')), 'high');
    const twoM = [{ id: 'm1', name: 'Medium', rank: 1 }, { id: 'm2', name: 'Minor', rank: 2 }];
    assert.equal(M.priority(twoM, 'm'), null, 'two levels start with m');
    assert.equal(M.priority(PRIOS, 'urgent'), null);
    assert.equal(M.priority(PRIOS, ''), null);
    assert.equal(M.priority([], 'high'), null);
    assert.equal(M.priority(null, '1'), null);
    const dup = [{ id: 'b', name: 'Same', rank: 2 }, { id: 'a', name: 'same', rank: 1 }];
    assert.equal(id(M.priority(dup, 'same')), 'a', 'duplicate names resolve to the higher level');
});

test('priority: the name shown on screen matches too (Arabic for the default levels)', () => {
    const AR = { High: 'عالية', Medium: 'متوسطة', Low: 'منخفضة' };
    const alias = n => AR[n] || null;
    const defaults = [{ id: 'h', name: 'High', rank: 1 }, { id: 'm', name: 'Medium', rank: 2 }, { id: 'l', name: 'Low', rank: 3 }];
    assert.equal(id(M.priority(defaults, 'عالية', alias)), 'h');
    assert.equal(id(M.priority(defaults, 'متو', alias)), 'm');
    assert.equal(id(M.priority(defaults, 'high', alias)), 'h', 'the stored name still works');
    assert.equal(M.priority(defaults, 'عالية'), null, 'without the alias only stored names match');
    assert.deepEqual(plain(M.suggest('!', defaults, 'منخ', 50, alias).map(r => r.item.id)), ['l']);
});

test('project and tag matching', () => {
    const projs = [{ id: 'inbox', name: 'Inbox' }, { id: 'u', name: 'Uni Work' }, { id: 'h', name: 'البيت' }];
    assert.equal(id(M.project(projs, 'uniwork')), 'u');
    assert.equal(id(M.project(projs, 'UniWork')), 'u');
    assert.equal(id(M.project(projs, 'البيت')), 'h');
    assert.equal(M.project(projs, 'inbox'), null, 'Inbox is never a shortcut target');
    assert.equal(M.project(projs, 'uni'), null, 'projects need the full name when typed by hand');
    const tags = ['study', 'Deep Work'];
    assert.deepEqual({ ...M.tag(tags, 'STUDY') }, { value: 'study', isNew: false });
    assert.deepEqual({ ...M.tag(tags, 'deepwork') }, { value: 'Deep Work', isNew: false });
    assert.deepEqual({ ...M.tag(tags, 'Gym') }, { value: 'gym', isNew: true });
});

test('mention list rows', () => {
    const all = M.suggest('!', PRIOS, '');
    assert.deepEqual(plain(all.map(r => [r.rank, r.name])), [[1, 'High'], [2, 'Medium'], [3, 'Normal'], [4, 'Low']]);
    assert.deepEqual(plain(M.suggest('!', PRIOS, '3').map(r => r.name)), ['Normal']);
    assert.deepEqual(plain(M.suggest('!', PRIOS, 'l').map(r => r.name)), ['Low', 'Normal'], 'names starting with the text come first');
    const projs = [{ id: 'inbox', name: 'Inbox' }, { id: 'u', name: 'Uni Work' }, { id: 'h', name: 'Home' }];
    assert.deepEqual(plain(M.suggest('#', projs, '').map(r => r.item.id)), ['u', 'h']);
    assert.deepEqual(plain(M.suggest('#', projs, 'wo').map(r => r.item.id)), ['u']);
    const rows = M.suggest('@', ['study', 'Deep Work'], 'de');
    assert.deepEqual(plain(rows.map(r => [r.name, !!r.isNew])), [['Deep Work', false], ['de', true]]);
    assert.equal(M.suggest('@', ['study'], 'Study').some(r => r.isNew), false, 'no "new tag" row for an existing tag');
    assert.equal(M.suggest('#', projs, 'zzz').length, 0);
    assert.equal(M.tokenOf({ kind: '!', name: 'Very High' }), '!VeryHigh');
    assert.equal(id(M.priority([{ id: 'vh', name: 'Very High', rank: 1 }], M.tokenOf({ kind: '!', name: 'Very High' }).slice(1))), 'vh', 'a removed chip gives back a token that matches again');
});

test('token patterns accept any script and the bonus token', () => {
    const tok = s => (s.match(M.TOKEN) || [])[1];
    assert.equal(tok('Essay !normal '), '!normal');
    assert.equal(tok('Essay !عاجل '), '!عاجل');
    assert.equal(tok('x @study '), '@study');
    assert.equal(tok('pay $$ '), '$$');
    assert.equal(tok('mail@example.com '), undefined, 'a symbol inside a word is not a shortcut');
    const act = s => { const m = s.match(M.ACTIVE); return m ? m[1] + '|' + m[2] : null; };
    assert.equal(act('Essay #'), '#|');
    assert.equal(act('Essay @de'), '@|de');
    assert.equal(act('Essay !عا'), '!|عا');
    assert.equal(act('mail@ex'), null);
    assert.equal(act('Essay !high done'), null);
});

test('title box wiring: matcher, list keys, one priority and project chip, no duplicate tags', () => {
    const engine = components.slice(components.indexOf('const NLPEngine = (() => {'), components.indexOf('return { upgradeInput, extractCleanTitle };'));
    assert.doesNotMatch(engine, /\['p1', 'high'\]|\['p3', 'low'\]/, 'no hard-coded High/Medium/Low names');
    assert.match(engine, /M\.priority\(host\.catalogs\.priorities\(\), value, shownName\)/);
    assert.match(engine, /window\.addEventListener\('keydown'[\s\S]*?ArrowDown[\s\S]*?Enter[\s\S]*?Escape[\s\S]*?stopImmediatePropagation\(\);\s*\}, true\);/);
    assert.match(engine, /if \(type !== 'tag'\)[^\n]*\.nlp-chip\[data-type="\$\{type\}"\][^\n]*\.remove\(\)/);
    assert.match(engine, /if \(resolved\.isNew\) host\.catalogs\.addTag\(value\);/);
    assert.match(engine, /el\.addEventListener\('mousedown', ev => ev\.preventDefault\(\)\)/, 'tapping a row keeps the caret in the title');
    assert.match(components, /if\(!draft\.newTags\.includes\(tag\)&&!liveHost\.catalogs\.tags\(\)\.includes\(tag\)\)draft\.newTags\.push\(tag\);/);
    const css = read('style.css');
    assert.match(css, /\.nlp-host \{ position: relative; \}/);
    assert.match(css, /\.nlp-menu \{[^}]*inset-inline: 0;[^}]*top: 100%;/);
    assert.match(read('locales/ar.js'), /"New tag": "وسم جديد"/);
});

test('tour card keeps its scroll; Back and Next stay pinned', () => {
    const js = read('tutorial-spotlight.js');
    const place = js.slice(js.indexOf('function place()'), js.indexOf('function onMove()'));
    assert.match(place, /const scrolled = card\.scrollTop;\s*try \{ placeCard\(target, vw, vh\); \} finally \{ if \(card\.scrollTop !== scrolled\) card\.scrollTop = scrolled; \}/);
    assert.match(place, /const h = Math\.ceil\(card\.scrollHeight \+ card\.offsetHeight - card\.clientHeight\);/);
    const beforeMeasure = place.slice(0, place.indexOf('const h = Math.ceil'));
    assert.doesNotMatch(beforeMeasure.slice(beforeMeasure.indexOf('function placeCard')), /card\.style\.maxHeight = \(vh - 2 \* EDGE\) \+ 'px';\s*if \(!target\)/, 'max-height is not lifted before measuring');
    assert.match(js, /card\.replaceChildren\(\); card\.scrollTop = 0;/, 'a new step starts at the top');
    const css = read('tutorial-spotlight.css');
    assert.match(css, /\.tt-card \.tt-actions\{position:sticky;bottom:0;/);
    assert.match(css, /@media \(max-width:640px\),\(pointer:coarse\)\{\.tt-keys\{display:none\}\.tt-card \.tt-actions\{bottom:-12px;/);
    for (const f of ['index.html', 'settings.html']) {
        const html = read(f);
        assert.match(html, /tutorial-spotlight\.css\?v=tour-v4/);
        assert.match(html, /tutorial-spotlight\.js\?v=tour-v4/);
    }
    assert.match(read('sw.js'), /taskitator-phase4-v79/);
});
