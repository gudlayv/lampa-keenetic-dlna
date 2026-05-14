// Headless-тест override Lampa.Select.show.
// Запуск: node tools/test-select-injection.js
//
// Не нужен браузер — тест чисто на Node, мокаем минимальное Lampa.*.

'use strict';

const fs = require('fs');
const path = require('path');

const pluginSrc = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'dlna.js'), 'utf8');

// Минимальное окружение для плагина.
const calls = { selectShow: [], noty: [] };

// jQuery-like chainable mock: каждый метод возвращает тот же объект.
function makejQuery() {
    var obj = {
        on:     function () { return obj; },
        append: function () { return obj; },
        find:   function () { return makejQuery(); },
        first:  function () { return makejQuery(); },
        eq:     function () { return makejQuery(); },
        remove: function () { return obj; },
        length: 0
    };
    return obj;
}

function jq() { return makejQuery(); }
// Поддержка jQuery.extend для случаев где плагин его использует.
jq.extend = function (a, b) { return Object.assign(a || {}, b || {}); };
jq.ajax = function () {};

const env = {
    btoa: function (s) { return Buffer.from(s).toString('base64'); },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    XMLHttpRequest: function () {
        this.open = function () {};
        this.setRequestHeader = function () {};
        this.send = function () {};
        this.getResponseHeader = function () { return null; };
        this.readyState = 4;
        this.status = 0;
    },
    document: {
        getElementById: function () { return null; },
        createElement: function () { return { style: {}, id: '', textContent: '' }; },
        head: { appendChild: function () {} }
    },
    DOMParser: function () {
        this.parseFromString = function () {
            return {
                getElementsByTagName: function () { return []; }
            };
        };
    }
};

// $ и jQuery — один и тот же chainable mock.
env.$ = jq;
env.jQuery = jq;

// Минимальный Lampa.
const Lampa = {
    Storage: {
        _store: {},
        field: function (k) { return this._store[k] || ''; },
        get:   function (k, def) { return this._store[k] !== undefined ? this._store[k] : def; },
        set:   function (k, v) { this._store[k] = v; }
    },
    Activity: {
        _active: null,
        active: function () { return this._active; }
    },
    Select: {
        show: function (params) { calls.selectShow.push(params); }
    },
    Noty: { show: function (m) { calls.noty.push(m); } },
    SettingsApi: { addComponent: function () {}, addParam: function () {} },
    Component: { add: function () {} },
    Listener: { follow: function () {}, send: function () {} },
    Controller: { collectionSet: function () {}, toggle: function () {} },
    Manifest: {},
    Reguest: function () {
        this.timeout = function () {};
        this.silent  = function (url, ok, fail) { if (fail) fail({}); };
    },
    TMDB: {
        api: function (path) { return 'https://api.themoviedb.org/3/' + path; },
        key: function () { return 'testkey'; },
        image: function () { return ''; }
    }
};
env.Lampa = Lampa;
env.window = env;
env.window.Lampa = Lampa;
env.window.appready = true;

// Загружаем плагин в наш scope.
const vm = require('vm');
vm.createContext(env);
try {
    vm.runInContext(pluginSrc, env);
} catch (e) {
    console.error('LOAD ERROR:', e.message);
    console.error(e.stack);
    process.exit(1);
}

// Плагин при appready=true сразу вызвал bootIndex() -> TransmissionAddon.install().
// Lampa.Select.show теперь обернут override.

// --- Test 1: торрент-контекст, есть magnet ---
Lampa.Activity._active = { component: 'torrents' };
const params1 = {
    title: 'Test.Movie.2024.1080p',
    items: [
        { title: 'Скачать magnet', magnet: 'magnet:?xt=urn:btih:abcdef0123456789' },
        { title: 'Воспроизвести' }
    ],
    onSelect: function (chosen) { params1._chosen = chosen; }
};
Lampa.Select.show(params1);

if (!params1.items[0]._kt_send) {
    console.error('FAIL: первый item должен быть «Скачать на Кинетик»');
    console.error('Got items:', params1.items.map(function (i) { return i.title; }));
    process.exit(1);
}
console.log('OK: торрент-контекст — пункт инжектится первым.');

// --- Test 2: НЕ-торрент-контекст ---
calls.selectShow = [];
Lampa.Activity._active = { component: 'movie_main' };
const params2 = {
    title: 'Фильтры',
    items: [{ title: 'Год' }, { title: 'Жанр' }],
    onSelect: function () {}
};
Lampa.Select.show(params2);
if (params2.items.length !== 2 || params2.items[0]._kt_send) {
    console.error('FAIL: в нет-торрент-контексте пункт не должен инжектиться');
    process.exit(1);
}
console.log('OK: нет-торрент-контекст — пункт не инжектится.');

// --- Test 3: идемпотентность ---
Lampa.Activity._active = { component: 'torrents' };
const params3 = {
    title: 'X',
    items: [{ title: 'magnet', magnet: 'magnet:?xt=urn:btih:dead' }],
    onSelect: function () {}
};
Lampa.Select.show(params3);
Lampa.Select.show(params3);  // повторный вызов с теми же params
if (params3.items.filter(function (i) { return i._kt_send; }).length !== 1) {
    console.error('FAIL: повторный wrap не должен дублировать пункт');
    console.error('Items:', params3.items.map(function (i) { return i.title; }));
    process.exit(1);
}
console.log('OK: идемпотентность wrap.');

// --- Test 4: проброс onSelect — для не-наших items вызывается, для наших — нет ---
Lampa.Activity._active = { component: 'torrents' };
let origCalled = false;
const params4 = {
    title: 'X',
    items: [{ title: 'magnet', magnet: 'magnet:?xt=urn:btih:beef' }],
    onSelect: function (chosen) { origCalled = true; params4._chosen = chosen; }
};
Lampa.Select.show(params4);
// Симулируем выбор НЕ-нашего пункта (LAMPA вызывает onSelect извне)
params4.onSelect({ title: 'Воспроизвести' });
if (!origCalled) {
    console.error('FAIL: оригинальный onSelect должен дергаться для не-наших items');
    process.exit(1);
}
// Симулируем выбор НАШЕГО пункта (_kt_send:true) — оригинальный onSelect НЕ должен дергаться
origCalled = false;
params4.onSelect({ title: 'Скачать на Кинетик', _kt_send: true, _kt_info: { magnet: 'magnet:?xt=urn:btih:abc', name: 'x' } });
if (origCalled) {
    console.error('FAIL: оригинальный onSelect НЕ должен дергаться для _kt_send items');
    process.exit(1);
}
console.log('OK: проброс onSelect — для не-наших items вызывается, для наших — нет.');

// --- Test 5: regex-fallback извлечения magnet ---
Lampa.Activity._active = { component: 'torrents' };
const params5 = {
    title: 'magnet:?xt=urn:btih:1234567890abcdef in title',
    items: [{ title: 'Просто пункт' }],
    onSelect: function () {}
};
Lampa.Select.show(params5);
if (!params5.items[0]._kt_send) {
    console.error('FAIL: regex-fallback должен извлечь magnet из title');
    process.exit(1);
}
console.log('OK: regex-fallback извлечения magnet.');

console.log('\nAll 5 tests passed.');
process.exit(0);  // плагин зарегистрировал setTimeout 2s — выходим явно
