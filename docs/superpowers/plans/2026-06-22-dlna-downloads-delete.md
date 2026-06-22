# Закачки + удаление фильма с DLNA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в плагин категорию «Закачки» (список активных торрентов Transmission с прогрессом и отменой) и удаление фильма с диска long-press'ом на карточке — всё через существующий Transmission RPC.

**Architecture:** Расширяем `TransmissionClient` (один общий `rpc()` + `list`/`remove`), добавляем pure-матчер `findTorrentForFile` (DLNA-title → торрент), новую вкладку `downloads` в `Component` с авто-poll'ом, и `hover:long`-меню на карточке фильма. Бэкенд (`serve.py`) не трогаем — хост `192.168.1.1:8090` уже в allowlist.

**Tech Stack:** Vanilla ES5 (Tizen/WebView-совместимый) в одном IIFE `plugins/dlna.js`; тесты — node-скрипты в `tools/`, извлекающие pure-функции из `dlna.js` через brace-matching + `eval` (см. `tools/verify-parser.js`); `npm test`.

**Спек:** `docs/superpowers/specs/2026-06-22-dlna-downloads-delete-design.md`

---

## Файловая структура

- **Modify** `plugins/dlna.js`:
  - новые pure-функции `normTorrentName`, `findTorrentForFile` (рядом с парсерами, до `TransmissionClient`);
  - рефактор `TransmissionClient` (≈2287): общий `rpc()`, + `list`, + `remove`;
  - `TABS` (≈1069) и `stacks` (≈1151): категория `downloads`;
  - `Component.openCurrent` (≈1255): ветка `downloads`;
  - новые методы компонента `renderDownloads` / `renderDownloadRow` / `stopDownloadsPoll`;
  - `renderMovieCard` (≈1658): `hover:long`-меню удаления;
  - `PLUGIN_VERSION` (18) → `0.12.0`.
- **Create** `tools/verify-torrent-match.js`: юнит-тест матчера.
- **Modify** `package.json`: `test` запускает оба verify-скрипта.
- **Modify** `README.md`: раздел Transmission — что теперь делает.

---

## Task 1: Pure-матчер `findTorrentForFile` + юнит-тест

**Files:**
- Modify: `plugins/dlna.js` (вставить рядом с `parseFilename`, до `var TransmissionClient`)
- Create: `tools/verify-torrent-match.js`
- Modify: `package.json` (скрипт `test`)

- [ ] **Step 1: Написать падающий тест** — `tools/verify-torrent-match.js`

```javascript
#!/usr/bin/env node
/**
 * tools/verify-torrent-match.js — юнит-тест матчера DLNA-файл → торрент.
 * Извлекает pure-функции normTorrentName / findTorrentForFile из dlna.js
 * (brace-matching + eval, как verify-parser.js). Не зависит от живого RPC.
 */
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'dlna.js'), 'utf8');

function extract(name) {
    const re = new RegExp('function ' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const i = SRC.search(re);
    if (i < 0) throw new Error('not found in dlna.js: ' + name);
    let j = SRC.indexOf('{', i), depth = 0, k = j;
    for (; k < SRC.length; k++) { if (SRC[k] === '{') depth++; else if (SRC[k] === '}') { depth--; if (depth === 0) { k++; break; } } }
    return SRC.slice(i, k);
}
eval([extract('normTorrentName'), extract('findTorrentForFile')].join('\n'));

let failed = 0;
function ok(cond, msg) { if (!cond) { console.error('  ❌', msg); failed++; } else console.log('  ✅', msg); }

const list = [
    { id: 11, name: 'Apex.2026.2160p.NF.WEB-DL', files: [{ name: 'Apex.2026.2160p.NF.WEB-DL.mkv' }] },
    { id: 12, name: 'The.Devil.Wears.Prada.2006.2160p.WEB-DL', files: [{ name: 'The.Devil.Wears.Prada.2006.2160p.WEB-DL.mkv' }] },
    { id: 13, name: 'Common.Side.Effects.S01', files: [{ name: 'S01E01 Pilot.mkv' }, { name: 'S01E02 Lakeshore Limited.mkv' }] }
];

console.log('Проверка findTorrentForFile:');
ok(findTorrentForFile('Apex.2026.2160p.NF.WEB-DL.mkv', list).id === 11, 'точный матч по files[].name (Apex)');
ok(findTorrentForFile('The Devil Wears Prada', list).id === 12, 'матч по подстроке имени раздачи (Prada)');
ok(findTorrentForFile('S01E02 Lakeshore Limited.mkv', list).id === 13, 'матч серии по files[].name');
ok(findTorrentForFile('Совершенно.Другой.Фильм.2099.mkv', list) === null, 'нет ложного матча на чужой файл');
ok(findTorrentForFile('', list) === null, 'пустой ввод → null');
ok(findTorrentForFile('a.mkv', list) === null, 'слишком короткое имя → null (без ложного)');

if (failed) { console.error('\nРЕГРЕСС: ' + failed + ' проверок упало.'); process.exit(1); }
console.log('Все проверки пройдены.');
```

- [ ] **Step 2: Запустить — убедиться что падает**

Run: `node tools/verify-torrent-match.js`
Expected: FAIL — `Error: not found in dlna.js: normTorrentName` (функций ещё нет).

- [ ] **Step 3: Добавить pure-функции в `dlna.js`**

Вставить непосредственно перед `var TransmissionClient = (function () {` (≈2287):

```javascript
    // Нормализация имени для матча DLNA-файла с торрентом Transmission:
    // срезаем расширение, разделители .[_-] → пробел, в lower-case.
    function normTorrentName(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/\.[a-z0-9]{2,4}$/, '')
            .replace(/[._\-\s]+/g, ' ')
            .trim();
    }

    /**
     * Ищет торрент в списке torrent-get, которому принадлежит DLNA-файл.
     * Матч: нормализованное имя файла == нормализованному torrent.name или
     * basename любого files[].name; либо одно содержит другое (overlap ≥ 6,
     * чтобы короткие имена не давали ложных). Возврат { id, name } | null.
     */
    function findTorrentForFile(fileTitle, list) {
        if (!fileTitle || !Array.isArray(list)) return null;
        var target = normTorrentName(fileTitle);
        if (target.length < 3) return null;
        function basename(p) {
            var s = String(p || '');
            var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
            return i >= 0 ? s.slice(i + 1) : s;
        }
        var best = null;
        for (var i = 0; i < list.length; i++) {
            var t = list[i] || {};
            var cands = [t.name];
            if (Array.isArray(t.files)) {
                for (var j = 0; j < t.files.length; j++) cands.push(basename(t.files[j] && t.files[j].name));
            }
            for (var c = 0; c < cands.length; c++) {
                var n = normTorrentName(cands[c]);
                if (n.length < 3) continue;
                if (n === target) return { id: t.id, name: t.name };
                if (n.indexOf(target) >= 0 || target.indexOf(n) >= 0) {
                    var overlap = Math.min(n.length, target.length);
                    if (overlap >= 6 && (!best || overlap > best.overlap)) best = { id: t.id, name: t.name, overlap: overlap };
                }
            }
        }
        return best ? { id: best.id, name: best.name } : null;
    }
```

- [ ] **Step 4: Запустить тест — убедиться что проходит**

Run: `node tools/verify-torrent-match.js`
Expected: PASS — все 6 проверок `✅`, «Все проверки пройдены.»

- [ ] **Step 5: Подключить к `npm test`**

В `package.json` заменить строку скрипта:

```json
    "test": "node tools/verify-parser.js && node tools/verify-torrent-match.js"
```

Run: `npm test`
Expected: оба набора зелёные, exit 0.

- [ ] **Step 6: Commit**

```bash
git add plugins/dlna.js tools/verify-torrent-match.js package.json
git commit -m "feat(torrent): матчер DLNA-файл → торрент Transmission + юнит-тест"
```

---

## Task 2: Расширить `TransmissionClient` — общий `rpc()`, `list`, `remove`

**Files:**
- Modify: `plugins/dlna.js` — `TransmissionClient` IIFE (≈2287–2399)

XHR-методы не покрываются node-юнитом; проверка — структурная (`npm test` всё ещё зелёный, плагин парсится) + ручной ping. Цель шага: убрать дублирование и добавить два метода БЕЗ изменения reason-кодов, на которые завязаны Noty в Settings.

- [ ] **Step 1: Добавить приватный `rpc()` внутрь `TransmissionClient`**

Сразу после `function basicAuthHeader() {...}` добавить общий вызов с 409-retry:

```javascript
        // Один RPC-вызов с обработкой 409 (CSRF session-id) и basic-auth.
        // onDone(arguments), onFail({ reason, ... }) — reason-коды стабильны:
        // auth | network | forbidden | server | rpc | parse | no_proxy.
        function rpc(method, args, onDone, onFail, _retried) {
            var url = rpcUrl();
            if (!url) { onFail({ reason: 'no_proxy' }); return; }
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            var auth = basicAuthHeader();
            if (auth) xhr.setRequestHeader('Authorization', auth);
            if (sessionId) xhr.setRequestHeader('X-Transmission-Session-Id', sessionId);
            xhr.timeout = 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                var sid = xhr.getResponseHeader('X-Transmission-Session-Id');
                if (xhr.status === 409 && sid && !_retried) {
                    sessionId = sid;
                    rpc(method, args, onDone, onFail, true);
                    return;
                }
                if (xhr.status === 401) { onFail({ reason: 'auth' }); return; }
                if (xhr.status === 403) { onFail({ reason: 'forbidden' }); return; }
                if (xhr.status === 0)   { onFail({ reason: 'network' }); return; }
                if (xhr.status >= 500)  { onFail({ reason: 'server', status: xhr.status }); return; }
                var data;
                try { data = JSON.parse(xhr.responseText || '{}'); }
                catch (e) { onFail({ reason: 'parse', body: xhr.responseText }); return; }
                if (!data || data.result !== 'success') { onFail({ reason: 'rpc', message: data && data.result }); return; }
                onDone(data.arguments || {});
            };
            xhr.ontimeout = function () { onFail({ reason: 'network' }); };
            xhr.onerror   = function () { onFail({ reason: 'network' }); };
            xhr.send(JSON.stringify({ method: method, arguments: args || {} }));
        }
```

- [ ] **Step 2: Переписать `addTorrent` через `rpc()`**

Заменить тело `send`/`postOnce`/`handleFinal`-цепочки. Удалить функции `send`, `postOnce`, `handleFinal`, а `addTorrent` в return-объекте сделать таким:

```javascript
            addTorrent: function (opts, onDone, onFail) {
                onDone = onDone || function () {};
                onFail = onFail || function () {};
                if (!opts || !opts.magnet) { onFail({ reason: 'no_magnet' }); return; }
                var args = { filename: opts.magnet };
                var dir = trDownloadDir();
                if (dir) args['download-dir'] = dir;
                rpc('torrent-add', args, function (a) {
                    var added = a['torrent-added'], dup = a['torrent-duplicate'];
                    if (added) onDone({ added: true, name: added.name || '' });
                    else if (dup) onDone({ duplicate: true, name: dup.name || '' });
                    else onFail({ reason: 'empty_args' });
                }, onFail);
            },
```

- [ ] **Step 3: Переписать `ping` через `rpc()`**

```javascript
            ping: function (onDone, onFail) {
                rpc('session-stats', {}, onDone || function () {}, onFail || function () {});
            },
```

- [ ] **Step 4: Добавить `list` и `remove` в return-объект**

```javascript
            list: function (onDone, onFail) {
                onDone = onDone || function () {};
                onFail = onFail || function () {};
                var fields = ['id', 'name', 'percentDone', 'rateDownload', 'status', 'eta', 'totalSize', 'downloadDir', 'files'];
                rpc('torrent-get', { fields: fields }, function (a) {
                    onDone((a && a.torrents) || []);
                }, onFail);
            },
            remove: function (ids, deleteLocal, onDone, onFail) {
                onDone = onDone || function () {};
                onFail = onFail || function () {};
                if (!Array.isArray(ids)) ids = [ids];
                rpc('torrent-remove', { ids: ids, 'delete-local-data': !!deleteLocal }, function () {
                    onDone({ removed: true });
                }, onFail);
            },
```

- [ ] **Step 5: Проверить парсинг и regress**

Run: `node -e "require('fs');new Function(require('fs').readFileSync('plugins/dlna.js','utf8'));console.log('parse ok')"`
Expected: `parse ok` (нет синтаксических ошибок после удаления старых функций).

Run: `npm test`
Expected: оба verify-скрипта зелёные (pure-функции не задеты).

- [ ] **Step 6: Commit**

```bash
git add plugins/dlna.js
git commit -m "refactor(transmission): общий rpc() + методы list/remove"
```

---

## Task 3: Категория «Закачки» — список с прогрессом, отмена, авто-poll

**Files:**
- Modify: `plugins/dlna.js` — `TABS` (≈1069), `stacks` (≈1151), `openCurrent` (≈1255), новые методы компонента

Зависит от Task 2 (`TransmissionClient.list`/`remove`). Ручная проверка — на живом Transmission (memory: verify-against-live-dlna).

- [ ] **Step 1: Добавить вкладку в `TABS` и `stacks`**

В `TABS` после `{ id: 'folders', title: 'Папки' }` добавить:

```javascript
        { id: 'downloads',     title: 'Закачки' }
```

В `stacks` после `folders: [...]` добавить:

```javascript
            downloads:     [{ kind: 'downloads', title: 'Закачки' }]
```

- [ ] **Step 2: Ветка `downloads` в `openCurrent`**

В `this.openCurrent` сразу после блока `if (top.kind === 'seasons')` (до `episodes`) добавить:

```javascript
            if (top.kind === 'downloads') {
                renderDownloads(opts);
                return;
            }
```

- [ ] **Step 3: Реализовать `renderDownloads` / `renderDownloadRow` / статусы / poll**

Добавить эти функции внутрь `Component` (рядом с `renderEntries`). `self` и `scroll` уже в замыкании.

```javascript
        var DL_STATUS = { 0: 'на паузе', 1: 'проверка', 2: 'проверка', 3: 'в очереди', 4: 'качается', 5: 'в очереди', 6: 'раздаётся' };

        function fmtSpeed(bps) {
            if (!bps || bps < 1) return '';
            var mb = bps / 1048576;
            if (mb >= 1) return '↓ ' + mb.toFixed(1) + ' МБ/с';
            return '↓ ' + Math.round(bps / 1024) + ' КБ/с';
        }
        function fmtEta(sec) {
            if (sec == null || sec < 0) return '';
            if (sec < 60) return 'ETA ' + sec + ' с';
            if (sec < 3600) return 'ETA ' + Math.round(sec / 60) + ' мин';
            return 'ETA ' + Math.round(sec / 3600) + ' ч';
        }

        function downloadRowHtml(t) {
            var pct = Math.round((t.percentDone || 0) * 100);
            var bits = [DL_STATUS[t.status] || ''];
            var sp = fmtSpeed(t.rateDownload); if (sp) bits.push(sp);
            var eta = fmtEta(t.eta); if (eta) bits.push(eta);
            return '<div class="dlna-row__title"><b>' + escapeHtml(t.name || '') + '</b></div>' +
                '<div class="dlna-row__progress" style="margin-top:0.4em; height:0.3em; background:rgba(255,255,255,0.1); border-radius:0.15em; overflow:hidden;">' +
                '<div style="height:100%; background:linear-gradient(90deg,#3a73ff,#7ed957); width:' + Math.min(100, pct) + '%;"></div></div>' +
                '<div class="dlna-row__meta" style="margin-top:0.3em; opacity:0.7; font-size:0.85em;">' + pct + '% · ' + bits.filter(Boolean).join(' · ') + '</div>';
        }

        function renderDownloadRow(t) {
            var row = $('<div class="selector dlna-row" data-tid="' + t.id + '" style="margin:0.3em 1em; padding:0.8em 1em; background:rgba(255,255,255,0.06); border-radius:0.5em;"></div>');
            row.html(downloadRowHtml(t));
            row.on('hover:focus', function () { scroll.update(row); });
            row.on('hover:enter', function () { openDownloadMenu(t); });
            return row;
        }

        function openDownloadMenu(t) {
            Lampa.Select.show({
                title: t.name || 'Закачка',
                items: [
                    { title: 'Отменить закачку (удалить файл)', _act: 'del' },
                    { title: 'Отменить, файл оставить', _act: 'keep' },
                    { title: 'Закрыть', _act: 'close' }
                ],
                onSelect: function (a) {
                    if (a._act === 'close') { Lampa.Controller.toggle('content'); return; }
                    confirmRemove(t, a._act === 'del');
                },
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
        }

        function confirmRemove(t, deleteLocal) {
            Lampa.Select.show({
                title: 'Точно отменить «' + (t.name || '') + '»?',
                items: [{ title: 'Да, отменить', _yes: true }, { title: 'Назад', _yes: false }],
                onSelect: function (a) {
                    if (!a._yes) { Lampa.Controller.toggle('content'); return; }
                    TransmissionClient.remove([t.id], deleteLocal, function () {
                        Lampa.Noty.show('Закачка отменена');
                        scroll.render().find('[data-tid="' + t.id + '"]').remove();
                        Lampa.Controller.toggle('content');
                    }, function (err) {
                        Lampa.Noty.show('Не удалось отменить: ' + (err && err.reason || 'ошибка'));
                        Lampa.Controller.toggle('content');
                    });
                },
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
        }

        function paintDownloads(torrents, opts) {
            opts = opts || {};
            var existing = {};
            scroll.render().find('.dlna-row[data-tid]').each(function () { existing[$(this).attr('data-tid')] = this; });
            if (!torrents.length && !opts.silent) {
                scroll.clear();
                scroll.append($('<div style="padding:1.5em; opacity:0.6;">Нет активных закачек</div>'));
                return;
            }
            var seen = {};
            torrents.forEach(function (t) {
                seen[t.id] = true;
                var el = existing[String(t.id)];
                if (el) $(el).html(downloadRowHtml(t));
                else scroll.append(renderDownloadRow(t));
            });
            Object.keys(existing).forEach(function (id) { if (!seen[id]) $(existing[id]).remove(); });
        }

        function renderDownloads(opts) {
            opts = opts || {};
            stopDownloadsPoll();
            if (!trAddr()) {
                scroll.clear();
                var msg = $('<div style="margin:1em; padding:1.2em; background:rgba(255,217,102,0.15); border-left:4px solid #ffd966; border-radius:0.4em; line-height:1.5;"></div>');
                msg.html('<b>Transmission не настроен</b><br><br>Открой <b>Настройки → Keenetic DLNA</b> и заполни <b>Transmission RPC</b>.<br>Инструкция — README: <a href="https://github.com/gudlayv/lampa-keenetic-dlna#интеграция-с-transmission" style="color:#ffd966;">github.com/…</a>');
                scroll.append(msg);
                self.activity.loader(false);
                if (!opts.skipControllerToggle) { self.activity.toggle(); Lampa.Controller.toggle('content'); }
                return;
            }
            var first = true;
            var load = function () {
                TransmissionClient.list(function (torrents) {
                    if (first) { scroll.clear(); first = false; }
                    paintDownloads(torrents, { silent: false });
                    self.activity.loader(false);
                    if (first === false && !opts.skipControllerToggle && opts._toggled !== true) {
                        opts._toggled = true; self.activity.toggle(); Lampa.Controller.toggle('content');
                    }
                }, function (err) {
                    if (first) {
                        scroll.clear();
                        var box = $('<div style="margin:1em; padding:1em; background:rgba(255,100,100,0.15); border-left:4px solid #ff6464; border-radius:0.4em;"></div>');
                        box.append('<b>Ошибка Transmission:</b> ' + escapeHtml((err && err.reason) || 'unknown'));
                        scroll.append(box);
                        self.activity.loader(false);
                        first = false;
                        if (!opts.skipControllerToggle) { self.activity.toggle(); Lampa.Controller.toggle('content'); }
                    }
                });
            };
            load();
            self._dlTimer = setInterval(load, 4000);
        }

        function stopDownloadsPoll() {
            if (self._dlTimer) { clearInterval(self._dlTimer); self._dlTimer = null; }
        }
```

- [ ] **Step 4: Гасить poll при уходе с вкладки и в lifecycle**

В `filter.onSelect` (≈1203), в начале хендлера до `reloadCurrent()` добавить `stopDownloadsPoll();`.
В `reloadCurrent` (≈1251) первой строкой добавить `stopDownloadsPoll();`.
В методах компонента `this.pause` и `this.destroy` (найти существующие; если нет — добавить) вызвать `stopDownloadsPoll();`. Если `this.destroy` уже есть — добавить вызов первой строкой; иначе добавить:

```javascript
        this.pause = function () { stopDownloadsPoll(); };
```

(не перетирая существующую логику, если она есть — дополнить).

- [ ] **Step 5: Проверить парсинг + regress**

Run: `node -e "new Function(require('fs').readFileSync('plugins/dlna.js','utf8'));console.log('parse ok')"`
Expected: `parse ok`

Run: `npm test`
Expected: оба verify зелёные.

- [ ] **Step 6: Ручная проверка на живом Transmission**

Запустить серв/прокси, открыть плагин в LAMPA, переключить фильтр на «Закачки». Ожидать: список текущих раздач, прогресс растёт каждые ~4 с; OK на строке → меню → «Отменить» → строка исчезает, Noty. Уйти с вкладки → poll прекращается (проверить, что нет лишних запросов в логе `serve.py`).

- [ ] **Step 7: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(downloads): вкладка «Закачки» — прогресс, отмена, авто-poll"
```

---

## Task 4: Удаление фильма long-press'ом на карточке

**Files:**
- Modify: `plugins/dlna.js` — `renderMovieCard` (≈1658, перед `return card;`)

Зависит от Task 1 (`findTorrentForFile`) и Task 2 (`list`/`remove`).

- [ ] **Step 1: Добавить `hover:long`-меню в `renderMovieCard`**

Перед `return card;` (после `card.on('hover:enter', ...)`):

```javascript
            card.on('hover:long', function () {
                Lampa.Select.show({
                    title: entry.title || 'Фильм',
                    items: [{ title: 'Удалить с диска', _act: 'del' }, { title: 'Закрыть', _act: 'close' }],
                    onSelect: function (a) {
                        if (a._act !== 'del') { Lampa.Controller.toggle('content'); return; }
                        deleteMovieFile(entry, card);
                    },
                    onBack: function () { Lampa.Controller.toggle('content'); }
                });
            });
```

- [ ] **Step 2: Реализовать `deleteMovieFile` в компоненте**

Рядом с `playEntry`:

```javascript
        function deleteMovieFile(entry, card) {
            if (!trAddr()) { Lampa.Noty.show('Transmission не настроен — удаление недоступно'); Lampa.Controller.toggle('content'); return; }
            TransmissionClient.list(function (list) {
                var hit = findTorrentForFile(entry.title, list);
                if (!hit) {
                    Lampa.Noty.show('Не нашёл раздачу для файла в Transmission — удалить можно только через web-UI роутера');
                    Lampa.Controller.toggle('content');
                    return;
                }
                Lampa.Select.show({
                    title: 'Удалить «' + hit.name + '» с диска?',
                    items: [{ title: 'Да, удалить', _yes: true }, { title: 'Назад', _yes: false }],
                    onSelect: function (a) {
                        if (!a._yes) { Lampa.Controller.toggle('content'); return; }
                        TransmissionClient.remove([hit.id], true, function () {
                            Lampa.Noty.show('Удалено. Обновите список — MiniDLNA уберёт фильм после ресканирования');
                            if (card) card.remove();
                            Lampa.Controller.toggle('content');
                        }, function (err) {
                            Lampa.Noty.show('Не удалось удалить: ' + (err && err.reason || 'ошибка'));
                            Lampa.Controller.toggle('content');
                        });
                    },
                    onBack: function () { Lampa.Controller.toggle('content'); }
                });
            }, function (err) {
                Lampa.Noty.show('Ошибка Transmission: ' + (err && err.reason || 'unknown'));
                Lampa.Controller.toggle('content');
            });
        }
```

- [ ] **Step 3: Проверить парсинг + regress**

Run: `node -e "new Function(require('fs').readFileSync('plugins/dlna.js','utf8'));console.log('parse ok')"`
Expected: `parse ok`

Run: `npm test`
Expected: зелёные.

- [ ] **Step 4: Ручная проверка**

Long-press OK на карточке фильма, который качали через плагин → «Удалить с диска» → подтверждение с именем раздачи → Noty, карточка убирается. На фильме без раздачи → Noty «не нашёл раздачу».

- [ ] **Step 5: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(delete): удаление фильма с диска long-press'ом (Transmission delete-local-data)"
```

---

## Task 5: Версия + README + финал

**Files:**
- Modify: `plugins/dlna.js` (`PLUGIN_VERSION`, строка 18)
- Modify: `README.md` (раздел Transmission)

- [ ] **Step 1: Поднять версию**

В `plugins/dlna.js:18` заменить:

```javascript
    var PLUGIN_VERSION = '0.12.0';
```

- [ ] **Step 2: Обновить README**

В разделе «### Что не делает» удалить пункты про управление торрентами/прогресс/удаление и добавить раздел:

```markdown
### Что умеет

- Вкладка **«Закачки»** — список активных раздач Transmission с прогрессом,
  скоростью и ETA, авто-обновление каждые ~4 с; OK → отменить закачку
  (с удалением файла или без).
- **Удаление фильма** — long-press OK на карточке фильма → «Удалить с диска»
  (через `torrent-remove` с `delete-local-data`). Работает только для фильмов,
  которые ещё числятся раздачей в Transmission; остальное — через web-UI роутера.
```

- [ ] **Step 3: Финальный regress + парсинг**

Run: `npm test`
Expected: зелёные.

Run: `node -e "new Function(require('fs').readFileSync('plugins/dlna.js','utf8'));console.log('parse ok')"`
Expected: `parse ok`

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js README.md
git commit -m "v0.12.0: вкладка «Закачки» и удаление фильма с диска через Transmission"
```

---

## Заметки по реализации

- **Lampa.Select API:** используется `{ title, items, onSelect, onBack }`; после закрытия меню возвращаем фокус `Lampa.Controller.toggle('content')`. Если в этой сборке LAMPA сигнатура иная — свериться с существующим вызовом `Lampa.Select.show` в `dlna.js` (≈2178) и привести к нему.
- **`hover:long`:** стандартное событие карточки-`.selector` в LAMPA (тот же механизм, что long-press на торрент-раздаче). Если на целевой сборке не стреляет — fallback: добавить пункт через тот же `Lampa.Select`, повешенный на отдельную кнопку (вне scope, только если long не работает).
- **`self.activity.toggle()` дважды:** poll не должен повторно дёргать toggle — отслеживаем флагом `opts._toggled`, чтобы фокус выставлялся один раз при первой загрузке.
- **DRY:** `downloadRowHtml` используется и при первичном рендере, и при патче строки в poll — не дублировать разметку.
```
