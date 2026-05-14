# Keenetic Transmission Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В LAMPA-онлайне long-press на торрент-раздаче открывает context-меню, где первым пунктом стоит «Скачать на Кинетик» — magnet/torrent отправляется в Transmission на Кинетике одним POST через `serve.py`.

**Architecture:** Monkey-patch `Lampa.Select.show` в плагине `dlna.js`. Override детектит торрент-контекст по `Activity.active().component` + наличию magnet-маркеров в `params.items`, инжектит свой пункт, дальше отдает управление оригинальному `Select.show`. `TransmissionClient` поверх `Lampa.Reguest` шлет один POST `torrent-add` через существующий `serve.py`-прокси (allowlist расширяется на `192.168.1.1:8090`). У встроенного Transmission в Кинетике CSRF отключен (подтверждено спайком), но fallback-ветка на 409→retry с session-id оставлена для совместимости.

**Tech Stack:** Vanilla JS (плагин одним IIFE-файлом, как сейчас), `Lampa.Reguest`/`jQuery.ajax`, `Lampa.SettingsApi`, `Lampa.Storage`, `Lampa.Noty`. Node + Playwright для headless-тестов в Chrome. Python 3 для `serve.py`. На стороне Transmission ничего не меняем (встроенный модуль Кинетика).

**Спек:** `docs/superpowers/specs/2026-05-14-keenetic-transmission-design.md`.

---

## File Structure

| Файл | Действие | Содержимое |
|---|---|---|
| `plugins/dlna.js` | Modify | + `TransmissionClient` (IIFE-модуль), + `TransmissionAddon` (IIFE-модуль), + Settings-поля, + версия 0.8.0 → 0.9.0 |
| `serve.py` | Modify | Расширить дефолт `ALLOWED_HOSTS` + CORS-headers (`Authorization`, `X-Transmission-Session-Id`) + `Access-Control-Expose-Headers` |
| `scripts/entware-install.sh` | Modify | В `DLNA_PROXY_ALLOW` env при запуске `S99lampa-dlna` добавить `192.168.1.1:8090` |
| `tools/test-transmission.sh` | (уже есть) | Спайк-скрипт, используется как ручной smoke-test |
| `tools/test-select-injection.js` | Create | Headless-тест в Chrome (Playwright): мок `Lampa.*`, проверка override |
| `README.md` | Modify | Секция «Интеграция с Transmission» |

`plugins/dlna.js` уже 1634 строки, но это — single-file плагин по выбранной архитектуре. Не дробим: новые модули добавляются рядом с существующими (`CardButton`, `IndexService`).

---

## Task 1: `serve.py` — расширить allowlist и CORS-headers

**Files:**
- Modify: `serve.py:42` (allowlist), `serve.py:64-69` (CORS headers)

- [ ] **Step 1: Прочитать текущее состояние**

Run: `sed -n '40,70p' serve.py`
Expected: видеть `ALLOWED_HOSTS = _parse_allow(os.environ.get("DLNA_PROXY_ALLOW", "192.168.1.1:8200"))` и `end_headers` с тремя `Access-Control-*` заголовками.

- [ ] **Step 2: Обновить default allowlist**

Заменить `serve.py:42`:

```python
# Дефолт: MiniDLNA + встроенный Transmission Кинетика. Через DLNA_PROXY_ALLOW
# пользователь может изменить порты (например если Transmission на :8091).
ALLOWED_HOSTS = _parse_allow(os.environ.get("DLNA_PROXY_ALLOW", "192.168.1.1:8200,192.168.1.1:8090"))
```

- [ ] **Step 3: Обновить CORS-headers**

В `Handler.end_headers` (примерно `serve.py:64-69`) — заменить три `Access-Control-*` строки на:

```python
self.send_header("Access-Control-Allow-Origin", "*")
self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
self.send_header("Access-Control-Allow-Headers", "Content-Type, SOAPAction, Authorization, X-Transmission-Session-Id")
self.send_header("Access-Control-Expose-Headers", "X-Transmission-Session-Id")
self.send_header("Cache-Control", "no-store")
```

- [ ] **Step 4: Локальный smoke-test прокси**

Run: `python3 serve.py 8080 &`
Затем: `curl -i -X OPTIONS http://localhost:8080/proxy/ -H 'Origin: https://example.com'`
Expected:
```
HTTP/1.0 204 No Content
Access-Control-Allow-Headers: Content-Type, SOAPAction, Authorization, X-Transmission-Session-Id
Access-Control-Expose-Headers: X-Transmission-Session-Id
```
Останови процесс: `kill %1`.

- [ ] **Step 5: Smoke-тест allowlist**

Run: `python3 serve.py 8080 &`
Then: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/proxy/http://192.168.1.1:8090/transmission/rpc`
Expected: код **не 403** (502 или другой upstream-ошибочный — нормально, потому что mock-сервер на :8090 не запущен; важно что allowlist пропустил).
Аналогично: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/proxy/http://192.168.1.1:1234/`
Expected: **403** (порт не в allowlist).
Останови: `kill %1`.

- [ ] **Step 6: Commit**

```bash
git add serve.py
git commit -m "serve.py: allowlist + CORS-headers для Transmission RPC"
```

---

## Task 2: `scripts/entware-install.sh` — пробросить новый allowlist

**Files:**
- Modify: `scripts/entware-install.sh`

- [ ] **Step 1: Найти место, где задается DLNA_PROXY_ALLOW**

Run: `grep -n 'DLNA_PROXY_ALLOW\|S99lampa-dlna\|start.sh' scripts/entware-install.sh`
Expected: одна-две строки, обычно в шаблоне init-скрипта или env-файла.

- [ ] **Step 2: Обновить значение**

Везде, где встречается строка `DLNA_PROXY_ALLOW="192.168.1.1:8200"` (или подобное в шаблоне `start.sh` / S99-скрипта), заменить на:

```sh
DLNA_PROXY_ALLOW="192.168.1.1:8200,192.168.1.1:8090"
```

Если значение не задается явно (использует дефолт `serve.py`) — задать явно: добавить `export DLNA_PROXY_ALLOW="192.168.1.1:8200,192.168.1.1:8090"` перед запуском `python3 serve.py`.

- [ ] **Step 3: Проверка bash-синтаксисом**

Run: `sh -n scripts/entware-install.sh`
Expected: пусто (нет синтаксических ошибок).

- [ ] **Step 4: Commit**

```bash
git add scripts/entware-install.sh
git commit -m "entware-install: DLNA_PROXY_ALLOW включает Transmission :8090"
```

---

## Task 3: `TransmissionClient` — клиент RPC (внутри `plugins/dlna.js`)

**Files:**
- Modify: `plugins/dlna.js` — добавить новый IIFE-модуль перед `function startPlugin()`.

Контекст: `TransmissionClient` инкапсулирует RPC. Один публичный метод `addTorrent(opts, onDone, onFail)`. Использует `Lampa.Reguest.silent` (как `tmdbSearch` в существующем коде). CSRF-ветка реализуется через свой fallback на `XMLHttpRequest`, потому что `Lampa.Reguest` HTTP-статусы и custom-headers ответа не пробрасывает.

- [ ] **Step 1: Storage-ключи и helper'ы**

В `plugins/dlna.js` рядом с `STORAGE_DLNA_PROXY` (около строки 14) добавить:

```js
var STORAGE_TR_ADDR  = 'transmission_rpc';
var STORAGE_TR_USER  = 'transmission_user';
var STORAGE_TR_PASS  = 'transmission_pass';
var STORAGE_TR_DIR   = 'transmission_dir';
var DEFAULT_TR_ADDR  = '192.168.1.1:8090';
var DEFAULT_TR_USER  = 'admin';

function trAddr() {
    return (Lampa.Storage.field(STORAGE_TR_ADDR) || DEFAULT_TR_ADDR)
        .replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
function trCreds() {
    var user = Lampa.Storage.field(STORAGE_TR_USER) || '';
    var pass = Lampa.Storage.field(STORAGE_TR_PASS) || '';
    return { user: user, pass: pass };
}
function trDownloadDir() {
    return (Lampa.Storage.field(STORAGE_TR_DIR) || '').trim();
}
```

- [ ] **Step 2: Сам модуль TransmissionClient**

Вставить перед `function startPlugin()` (около строки 1530):

```js
// Клиент Transmission RPC. Один POST torrent-add через serve.py.
// На сборке Transmission в Кинетике CSRF отключен — обычно достаточно одного
// запроса. Для совместимости со стандартным Transmission реализована fallback-
// ветка на 409→retry с X-Transmission-Session-Id. Используем XHR, потому что
// Lampa.Reguest не пробрасывает HTTP-статус и custom response-headers.
var TransmissionClient = (function () {
    var sessionId = null;

    function rpcUrl() {
        var proxy = proxyBase();
        if (!proxy) return '';
        return proxy + 'http://' + trAddr() + '/transmission/rpc';
    }

    function basicAuthHeader() {
        var c = trCreds();
        if (!c.user || !c.pass) return null;  // basic-auth с пустым паролем
                                              // ломает запрос на некоторых билдах
        return 'Basic ' + btoa(c.user + ':' + c.pass);
    }

    function buildBody(magnetOrUrl) {
        var args = { filename: magnetOrUrl };
        var dir = trDownloadDir();
        if (dir) args['download-dir'] = dir;
        return JSON.stringify({ method: 'torrent-add', arguments: args });
    }

    function send(magnetOrUrl, onDone, onFail) {
        var url = rpcUrl();
        if (!url) { onFail({ reason: 'no_proxy' }); return; }
        postOnce(url, magnetOrUrl, sessionId, function (status, sid, body) {
            if (status === 409 && sid && sid !== sessionId) {
                sessionId = sid;
                postOnce(url, magnetOrUrl, sessionId, function (s2, _, b2) {
                    handleFinal(s2, b2, onDone, onFail);
                });
                return;
            }
            handleFinal(status, body, onDone, onFail);
        });
    }

    function postOnce(url, magnetOrUrl, sid, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        var auth = basicAuthHeader();
        if (auth) xhr.setRequestHeader('Authorization', auth);
        if (sid) xhr.setRequestHeader('X-Transmission-Session-Id', sid);
        xhr.timeout = 15000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            var sidFromResp = xhr.getResponseHeader('X-Transmission-Session-Id');
            cb(xhr.status, sidFromResp, xhr.responseText || '');
        };
        xhr.ontimeout = function () { cb(0, null, ''); };
        xhr.onerror = function () { cb(0, null, ''); };
        xhr.send(buildBody(magnetOrUrl));
    }

    function handleFinal(status, bodyText, onDone, onFail) {
        if (status === 401) { onFail({ reason: 'auth' }); return; }
        if (status === 0)   { onFail({ reason: 'network' }); return; }
        if (status === 403) { onFail({ reason: 'forbidden' }); return; }
        if (status >= 500)  { onFail({ reason: 'server', status: status }); return; }
        var data;
        try { data = JSON.parse(bodyText); }
        catch (e) { onFail({ reason: 'parse', body: bodyText }); return; }
        if (!data || data.result !== 'success') {
            onFail({ reason: 'rpc', message: data && data.result });
            return;
        }
        var added = data.arguments && data.arguments['torrent-added'];
        var dup   = data.arguments && data.arguments['torrent-duplicate'];
        if (added) { onDone({ added: true, name: added.name || '' }); return; }
        if (dup)   { onDone({ duplicate: true, name: dup.name || '' }); return; }
        onFail({ reason: 'empty_args' });
    }

    return {
        addTorrent: function (opts, onDone, onFail) {
            if (!opts || !opts.magnet) { onFail({ reason: 'no_magnet' }); return; }
            send(opts.magnet, onDone || function () {}, onFail || function () {});
        },
        // Для теста соединения из Settings: один POST session-stats
        ping: function (onDone, onFail) {
            var url = rpcUrl();
            if (!url) { onFail({ reason: 'no_proxy' }); return; }
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            var auth = basicAuthHeader();
            if (auth) xhr.setRequestHeader('Authorization', auth);
            if (sessionId) xhr.setRequestHeader('X-Transmission-Session-Id', sessionId);
            xhr.timeout = 8000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                var sid = xhr.getResponseHeader('X-Transmission-Session-Id');
                if (xhr.status === 409 && sid) {
                    sessionId = sid;
                    return TransmissionClient.ping(onDone, onFail);
                }
                if (xhr.status === 401) { onFail({ reason: 'auth' }); return; }
                if (xhr.status === 0)   { onFail({ reason: 'network' }); return; }
                try {
                    var d = JSON.parse(xhr.responseText || '{}');
                    if (d.result === 'success') onDone(d.arguments || {});
                    else onFail({ reason: 'rpc', message: d.result });
                } catch (e) { onFail({ reason: 'parse' }); }
            };
            xhr.ontimeout = function () { onFail({ reason: 'network' }); };
            xhr.onerror   = function () { onFail({ reason: 'network' }); };
            xhr.send(JSON.stringify({ method: 'session-stats' }));
        },
        _resetSession: function () { sessionId = null; }
    };
})();
```

- [ ] **Step 3: Smoke-проверка синтаксиса (без LAMPA)**

Run: `node -e "var window={};var Lampa={Storage:{field:function(){return ''}}};var btoa=Buffer.from;require('fs').writeFileSync('/tmp/dlna-syntax.js','('+require('fs').readFileSync('plugins/dlna.js','utf8')+')'); require('/tmp/dlna-syntax.js')" 2>&1 | head -10`
Expected: ошибки про jQuery / `$` / Lampa.* — это нормально (нет среды). Главное **не должно быть SyntaxError**.
Альтернатива (быстрее и точнее):
Run: `node --check plugins/dlna.js`
Expected: пусто (синтаксис OK).

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js
git commit -m "TransmissionClient: RPC-клиент с CSRF-fallback на XHR"
```

---

## Task 4: `TransmissionAddon` — override `Lampa.Select.show`

**Files:**
- Modify: `plugins/dlna.js` — еще один IIFE-модуль рядом с `TransmissionClient`.

Контекст: основная фича. Override обертывает `Lampa.Select.show`, в торрент-контексте префиксует свой пункт. Открытые вопросы из спека решаются здесь:
- **Имя component для торрент-листа**: фильтруем через массив-кандидат `['torrents', 'online', 'lampac_online']` — этого достаточно для текущих LAMPA-источников. Если не совпало — не инжектим.
- **Извлечение magnet**: смотрим `params.items[*]` на наличие `magnet`-полей и regex по полям `title`/`subtitle`/`url` на `magnet:?xt=urn:btih:...` как last resort.

- [ ] **Step 1: Magnet extractor (helper)**

Перед модулем `TransmissionAddon` (после `TransmissionClient`) добавить:

```js
// Извлечение magnet и человеко-читаемого имени из контекстного меню
// торрент-раздачи. Структура items различается между online-источниками,
// поэтому пробуем несколько fallback-стратегий.
function extractTorrentInfo(params) {
    if (!params || !Array.isArray(params.items)) return null;
    var magnet = null;
    var name = (params.title || '').toString();
    var seeds = 0;

    // Стратегия 1: явное поле в каком-то item.
    for (var i = 0; i < params.items.length; i++) {
        var it = params.items[i] || {};
        var candidate = it.magnet || it.MagnetUri || it.link || it.url;
        if (typeof candidate === 'string' && /^magnet:\?/.test(candidate)) {
            magnet = candidate; break;
        }
        if (it._torrent && typeof it._torrent.magnet === 'string') {
            magnet = it._torrent.magnet; break;
        }
    }

    // Стратегия 2: regex по текстам всех items + title.
    if (!magnet) {
        var blob = name + ' ' + JSON.stringify(params.items);
        var m = blob.match(/magnet:\?xt=urn:btih:[A-Fa-f0-9]+[^"\s]*/);
        if (m) magnet = m[0];
    }

    if (!magnet) return null;

    // Сиды — best-effort, для subtitle.
    var seedsMatch = JSON.stringify(params.items).match(/"?seeds"?\s*:\s*(\d+)/i);
    if (seedsMatch) seeds = parseInt(seedsMatch[1], 10);

    return { magnet: magnet, name: name || 'торрент', seeds: seeds };
}
```

- [ ] **Step 2: Модуль TransmissionAddon**

После `extractTorrentInfo` добавить:

```js
// Override Lampa.Select.show для инжекта «Скачать на Кинетик» в context-меню
// торрент-раздачи. try/catch гарантирует что override никогда не ломает
// нативное поведение LAMPA.
var TransmissionAddon = (function () {
    var TORRENT_COMPONENTS = ['torrents', 'online', 'lampac_online'];
    var installed = false;

    function isTorrentContext() {
        try {
            var a = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
            if (!a || !a.component) return false;
            return TORRENT_COMPONENTS.indexOf(a.component) >= 0;
        } catch (e) { return false; }
    }

    function makeItem(info) {
        return {
            title: 'Скачать на Кинетик',
            subtitle: (info.seeds ? info.seeds + ' сидов · ' : '') + 'отправить в Transmission',
            _kt_send: true,
            _kt_info: info
        };
    }

    function send(info) {
        Lampa.Noty.show('Отправляю в Transmission…');
        TransmissionClient.addTorrent({ magnet: info.magnet, name: info.name },
            function (res) {
                var label = res.name || info.name || '';
                if (res.duplicate) Lampa.Noty.show('Уже в очереди: ' + label);
                else                Lampa.Noty.show('Добавлено: ' + label);
            },
            function (err) {
                var msg;
                switch (err.reason) {
                    case 'auth':      msg = 'Неверный логин/пароль Transmission'; break;
                    case 'network':   msg = 'Прокси/RPC недоступен. Проверь serve.py и адрес RPC.'; break;
                    case 'forbidden': msg = 'Прокси: хост не в allowlist (DLNA_PROXY_ALLOW)'; break;
                    case 'no_magnet': msg = 'Не удалось определить magnet'; break;
                    case 'no_proxy':  msg = 'Не задан Прокси URL'; break;
                    case 'rpc':       msg = 'Transmission: ' + (err.message || 'ошибка'); break;
                    case 'parse':     msg = 'Некорректный ответ Transmission'; break;
                    default:          msg = 'Ошибка: ' + (err.reason || 'неизвестно');
                }
                console.warn('[transmission]', err);
                Lampa.Noty.show(msg);
            });
    }

    function wrap(params) {
        try {
            if (!isTorrentContext()) return params;
            var info = extractTorrentInfo(params);
            if (!info) return params;
            // Идемпотентность: вдруг Select.show вызывается повторно с теми же
            // items (например после возврата фокуса).
            var already = params.items && params.items.length && params.items[0]._kt_send;
            if (already) return params;
            var item = makeItem(info);
            params.items = [item].concat(params.items || []);
            var origOnSelect = params.onSelect;
            params.onSelect = function (selected) {
                if (selected && selected._kt_send) {
                    send(selected._kt_info);
                    return;
                }
                if (typeof origOnSelect === 'function') origOnSelect.apply(this, arguments);
            };
            return params;
        } catch (e) {
            console.warn('[transmission] wrap failed', e);
            return params;
        }
    }

    function install() {
        if (installed) return;
        if (!window.Lampa || !Lampa.Select || typeof Lampa.Select.show !== 'function') return;
        var orig = Lampa.Select.show;
        Lampa.Select.show = function (params) {
            return orig.call(this, wrap(params));
        };
        installed = true;
    }

    return { install: install, _wrap: wrap, _extract: extractTorrentInfo };
})();
```

- [ ] **Step 3: Подключить в `startPlugin`**

В функции `startPlugin` (около строки 1530) после `CardButton.init();` (см. функцию `bootIndex` около 1619) — нужно добавить `TransmissionAddon.install();`. Но `install` должен подождать пока `Lampa.Select` появится. В `bootIndex` уже есть `setTimeout(... 2000)` для `quickCheck` — добавим параллельный вызов установки.

Edit `plugins/dlna.js` — заменить функцию `bootIndex`:

```js
function bootIndex() {
    // Warm: моментально из Storage; cold-quickCheck отложен,
    // чтобы не конкурировать со стартом LAMPA.
    try { IndexService.load(); } catch (e) {}
    try { CardButton.init(); } catch (e) {}
    try { TransmissionAddon.install(); } catch (e) {}
    setTimeout(function () {
        try { IndexService.quickCheck(); } catch (e) {}
        try { TransmissionAddon.install(); } catch (e) {}  // retry если Lampa.Select не был готов
    }, 2000);
}
```

- [ ] **Step 4: Syntax-check**

Run: `node --check plugins/dlna.js`
Expected: пусто.

- [ ] **Step 5: Commit**

```bash
git add plugins/dlna.js
git commit -m "TransmissionAddon: override Lampa.Select.show для context-меню торрента"
```

---

## Task 5: Headless-тест override (Playwright)

**Files:**
- Create: `tools/test-select-injection.js`

Контекст: на TV крутить руками каждый рефактор больно. Делаем headless-тест в Node + Playwright (уже установлен), где собираем минимальный фейк `Lampa.*` и проверяем что override:
- инжектит пункт в торрент-контексте,
- не инжектит в нет-торрент-контексте,
- передает callbacks оригинальному onSelect,
- идемпотентен.

- [ ] **Step 1: Создать `tools/test-select-injection.js`**

```js
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
const env = {
    window: {},
    $: () => ({ on: () => {}, append: () => {}, find: () => ({ length: 0, first: () => ({ length: 0 }) }), remove: () => {} }),
    jQuery: function () { return env.$(); },
    btoa: (s) => Buffer.from(s).toString('base64'),
    console: console,
    setTimeout: setTimeout,
    XMLHttpRequest: function () { this.open = () => {}; this.setRequestHeader = () => {}; this.send = () => {}; this.getResponseHeader = () => null; },
    document: { head: { appendChild: () => {} }, getElementById: () => null, createElement: () => ({ style: {}, id: '' }) },
};
env.window = env;

// Минимальный Lampa.
const Lampa = {
    Storage: {
        _store: {},
        field: function (k) { return this._store[k] || ''; },
        get:   function (k, def) { return this._store[k] || def; },
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
    SettingsApi: { addComponent: () => {}, addParam: () => {} },
    Component: { add: () => {} },
    Listener: { follow: () => {}, send: () => {} },
    Controller: { collectionSet: () => {}, toggle: () => {} },
    Manifest: {},
    Reguest: function () {
        this.timeout = () => {};
        this.silent  = (url, ok, fail) => fail && fail({});
    },
    TMDB: null
};
env.Lampa = Lampa;
env.window.Lampa = Lampa;
env.window.appready = true;

// Загружаем плагин в наш scope.
const vm = require('vm');
vm.createContext(env);
try {
    vm.runInContext(pluginSrc, env);
} catch (e) {
    console.error('LOAD ERROR:', e.message);
    process.exit(1);
}

// Дать плагину инициализироваться (он вешает setTimeout 2000).
// Сначала вызовем install напрямую — не ждем 2 секунды в тесте.
// Достанем TransmissionAddon из глобалки в контексте — но плагин IIFE,
// модуль не экспортируется. Однако override уже установлен через bootIndex
// который вызвался при appready=true. Так что Lampa.Select.show уже обернут.

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
    console.error('Got items:', params1.items.map(i => i.title));
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
Lampa.Select.show(params3);  // повторный вызов с тем же params
if (params3.items.filter(i => i._kt_send).length !== 1) {
    console.error('FAIL: повторный wrap не должен дублировать пункт');
    console.error('Items:', params3.items.map(i => i.title));
    process.exit(1);
}
console.log('OK: идемпотентность wrap.');

// --- Test 4: оригинальный onSelect вызывается для не-наших items ---
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
console.log('OK: проброс оригинального onSelect для не-наших items.');

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
```

- [ ] **Step 2: Запустить тест**

Run: `node tools/test-select-injection.js`
Expected:
```
OK: торрент-контекст — пункт инжектится первым.
OK: нет-торрент-контекст — пункт не инжектится.
OK: идемпотентность wrap.
OK: проброс оригинального onSelect для не-наших items.
OK: regex-fallback извлечения magnet.

All 5 tests passed.
```

Если упало — читаем сообщение, фиксим, перезапускаем.

- [ ] **Step 3: Commit**

```bash
git add tools/test-select-injection.js
git commit -m "test: headless-тест override Lampa.Select.show для Transmission"
```

---

## Task 6: Settings — поля Transmission в LAMPA

**Files:**
- Modify: `plugins/dlna.js` — функция `registerSettings` (около строки 1545).

- [ ] **Step 1: Прочитать текущее состояние registerSettings**

Run: `sed -n '1545,1605p' plugins/dlna.js`
Expected: видеть три уже-зарегистрированных параметра (`STORAGE_DLNA_ADDR`, `STORAGE_DLNA_PROXY`, `dlna_refresh_index`).

- [ ] **Step 2: Добавить параметры Transmission**

После третьего `Lampa.SettingsApi.addParam` для `dlna_refresh_index` (перед `}` функции `registerSettings`) добавить:

```js
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_ADDR, type: 'input', placeholder: DEFAULT_TR_ADDR, values: '', default: DEFAULT_TR_ADDR },
                field: {
                    name: 'Transmission RPC',
                    description: 'IP:порт RPC встроенного Transmission Кинетика. По умолчанию 8090; если в web-UI Кинетика порт другой — задай вручную.'
                },
                onChange: function () { try { TransmissionClient._resetSession(); } catch (e) {} }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_USER, type: 'input', placeholder: DEFAULT_TR_USER, values: '', default: DEFAULT_TR_USER },
                field: { name: 'Пользователь Transmission', description: 'Логин из web-UI Кинетика → Transmission.' }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_PASS, type: 'input', placeholder: '', values: '', default: '' },
                field: {
                    name: 'Пароль Transmission',
                    description: 'Пароль из web-UI Кинетика. Хранится в LAMPA в открытом виде — не используй критичные пароли. Если пустой — basic-auth не отправляется.'
                },
                onChange: function () { try { TransmissionClient._resetSession(); } catch (e) {} }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_DIR, type: 'input', placeholder: '', values: '', default: '' },
                field: {
                    name: 'Папка скачивания (опц.)',
                    description: 'Если пусто — Transmission кладет в свою default-папку, заданную в web-UI Кинетика. Если задано — передается как download-dir.'
                }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: 'transmission_test', type: 'trigger', default: false },
                field: {
                    name: 'Тест соединения с Transmission',
                    description: 'session-stats → Noty с результатом.'
                },
                onChange: function () {
                    try { Lampa.Storage.set('transmission_test', false); } catch (e) {}
                    if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Проверяю Transmission…');
                    TransmissionClient.ping(
                        function (info) {
                            var n = info.torrentCount;
                            Lampa.Noty.show('Transmission OK · торрентов: ' + (typeof n === 'number' ? n : '?'));
                        },
                        function (err) {
                            var msg;
                            switch (err.reason) {
                                case 'auth':    msg = 'Неверный логин/пароль'; break;
                                case 'network': msg = 'Не достучался до RPC'; break;
                                case 'rpc':     msg = 'RPC: ' + (err.message || 'ошибка'); break;
                                default:        msg = 'Ошибка: ' + (err.reason || 'неизвестно');
                            }
                            Lampa.Noty.show(msg);
                        });
                }
            });
```

- [ ] **Step 3: Syntax-check**

Run: `node --check plugins/dlna.js`
Expected: пусто.

- [ ] **Step 4: Headless re-run для регрессии**

Run: `node tools/test-select-injection.js`
Expected: все 5 тестов проходят.

- [ ] **Step 5: Commit**

```bash
git add plugins/dlna.js
git commit -m "Settings: поля Transmission (RPC, креды, dir, тест соединения)"
```

---

## Task 7: Bump версии плагина и заголовок

**Files:**
- Modify: `plugins/dlna.js:7`

- [ ] **Step 1: Bump version**

Заменить `plugins/dlna.js:7`:

```js
var PLUGIN_VERSION = '0.9.0';
```

- [ ] **Step 2: Commit**

```bash
git add plugins/dlna.js
git commit -m "v0.9.0: интеграция с Keenetic Transmission"
```

---

## Task 8: README — секция Transmission

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Прочитать структуру README**

Run: `grep -n '^## ' README.md`
Expected: список заголовков (Возможности, Зачем нужен прокси, Быстрый старт, Cloudflare named tunnel, Архитектура, ...).

- [ ] **Step 2: Добавить секцию после «Возможности»**

В `README.md`, перед строкой `## Зачем нужен прокси`, добавить новую секцию:

```markdown
## Интеграция с Transmission (опционально)

В LAMPA-онлайне на каждой торрент-раздаче long-press OK открывает
контекстное меню. Если в Кинетике включен встроенный Transmission, плагин
добавляет туда пункт **«Скачать на Кинетик»** — magnet уходит в Transmission
одним RPC-вызовом через тот же `serve.py`-прокси.

Файл качается на USB-диск Кинетика, который сканирует MiniDLNA — через
5-10 минут раздача появляется в списке «Все» плагина, а на TMDB-карточке —
кнопка «Смотреть с DLNA».

### Настройка

1. В Кинетике через web-UI поставить компонент Transmission (раздел
   «Приложения»). Запомнить TCP-порт управления — по умолчанию 8090,
   у некоторых пользователей перенесен на другой.
2. В LAMPA: **Настройки → Keenetic DLNA** заполнить:
   - Transmission RPC: `192.168.1.1:8090` (или твой порт);
   - Пользователь / Пароль (если задал в web-UI Кинетика);
   - «Папка скачивания» — оставь пустой, чтобы Transmission решил сам.
3. Нажать «Тест соединения с Transmission» — должно появиться
   уведомление с числом активных торрентов.

> Если у тебя порт Transmission **не** 8090, переменная окружения
> `DLNA_PROXY_ALLOW` в `entware-install.sh` должна это отражать.
> По умолчанию allowlist: `192.168.1.1:8200,192.168.1.1:8090`.

### Что не делает

- Не управляет существующими торрентами (пауза/удаление/выбор файлов) —
  для этого web-UI Transmission в Кинетике.
- Не показывает прогресс скачивания в LAMPA.
- Не делает свой поиск торрентов — пункт инжектится в уже существующее
  context-меню LAMPA-онлайна.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: секция «Интеграция с Transmission»"
```

---

## Task 9: TV-ручная проверка (smoke на железе)

Контекст: на этом этапе локально все собрано и протестировано. Финальная проверка — на реальном TV/Кинетике. Это **ручной** шаг (не автоматизируется), но обязательный перед выпуском.

- [ ] **Step 1: Запушить плагин в публичный CDN**

```bash
git push origin main
```

Плагин подтянется в LAMPA через githack-CDN с `?v=<sha>` (если используешь cache-busting) или после авто-инвалидации.

- [ ] **Step 2: Обновить `serve.py` на Кинетике**

Если на Кинетике уже стоит `S99lampa-dlna` от прошлой версии:

```sh
ssh root@192.168.1.1
curl -sSL https://raw.githubusercontent.com/gudlayv/lampa-keenetic-dlna/main/scripts/entware-install.sh | sh
/opt/etc/init.d/S99lampa-dlna restart
/opt/etc/init.d/S99lampa-dlna status
```

Expected: статус running, в логах — `allowlist: ['192.168.1.1:8090', '192.168.1.1:8200']`.

- [ ] **Step 3: Smoke-тест RPC с TV-сети**

С Mac в той же LAN:

```bash
sh tools/test-transmission.sh 192.168.1.1:<твой-порт> admin <пароль>
```

Expected: шаги 1 и 2 проходят.

- [ ] **Step 4: TV-проверка**

В LAMPA на TV:
1. Открыть карточку любого фильма (TMDB).
2. Жмякнуть «Онлайн» → выбрать любой источник → дождаться списка раздач.
3. Long-press OK на раздаче.
4. **Ожидаем:** в открывшемся context-меню первым пунктом «Скачать на Кинетик · N сидов · отправить в Transmission».
5. Нажать. **Ожидаем:** Noty «Отправляю в Transmission…» → Noty «Добавлено: <имя>».
6. В Кинетике web-UI → Transmission — раздача появилась и качается.

Если на шаге 4 пункта нет: открыть console плагина (через `tools/browse.js` или DevTools), посмотреть `Lampa.Activity.active().component`. Если значение НЕ в `['torrents', 'online', 'lampac_online']` — расширить массив `TORRENT_COMPONENTS` в `TransmissionAddon`.

Если на шаге 5 ошибка — посмотреть `console.warn` плагина (фигурирует префикс `[transmission]`).

- [ ] **Step 5: Финальный коммит (если потребовались правки на шаге 4)**

Если массив `TORRENT_COMPONENTS` пришлось расширить или нашлась другая правка:

```bash
git add plugins/dlna.js
git commit -m "Transmission: расширил TORRENT_COMPONENTS / правка после TV-теста"
git push origin main
```

Если все прошло без правок — этот шаг пропускается.

---

## Сводка коммитов

После выполнения плана в `main` будут:

1. `serve.py: allowlist + CORS-headers для Transmission RPC`
2. `entware-install: DLNA_PROXY_ALLOW включает Transmission :8090`
3. `TransmissionClient: RPC-клиент с CSRF-fallback на XHR`
4. `TransmissionAddon: override Lampa.Select.show для context-меню торрента`
5. `test: headless-тест override Lampa.Select.show для Transmission`
6. `Settings: поля Transmission (RPC, креды, dir, тест соединения)`
7. `v0.9.0: интеграция с Keenetic Transmission`
8. `README: секция «Интеграция с Transmission»`
9. (опц.) `Transmission: правка после TV-теста`
