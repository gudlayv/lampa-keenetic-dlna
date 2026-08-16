# Удаление сериала разом через Transmission — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long-press OK на карточке сериала удаляет весь сериал с диска одним действием: все относящиеся раздачи Transmission уходят одним `torrent-remove` с `delete-local-data`.

**Architecture:** Зеркалим существующее удаление фильма (`deleteMovieFile`): новый pure-хелпер `findTorrentsForShow` агрегирует существующий `findTorrentForFile` по всем сериям и дедуплицирует раздачи; `deleteShowFiles` в `Component` показывает подтверждение со списком раздач и зовет уже существующий `TransmissionClient.remove(ids, true, ...)` (метод принимает массив id).

**Tech Stack:** vanilla JS (ES5, плагин LAMPA), Transmission RPC через `serve.py`-прокси, тесты — node-скрипты `tools/` (извлечение pure-функций brace-matching + eval).

**Spec:** `docs/superpowers/specs/2026-08-16-show-delete-design.md`

**Зависимость:** выполняется после плана `2026-08-16-track-memory.md` (версии идут подряд: 0.14.0 → 0.15.0).

---

### Task 1: Хелпер `findTorrentsForShow` + юнит-тест

**Files:**
- Modify: `plugins/dlna.js` (top-level, сразу после `findTorrentForFile`, ~line 2550)
- Create: `tools/verify-show-delete.js`
- Modify: `package.json` (scripts.test)

- [ ] **Step 1: Написать падающий тест**

Создать `tools/verify-show-delete.js`:

```javascript
#!/usr/bin/env node
/**
 * tools/verify-show-delete.js — юнит-тест агрегатора раздач сериала
 * (findTorrentsForShow из dlna.js). Извлечение pure-функций —
 * brace-matching + eval, как verify-parser.js.
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
eval([extract('normTorrentName'), extract('findTorrentForFile'), extract('findTorrentsForShow')].join('\n'));

let failed = 0;
function ok(cond, msg) { if (!cond) { console.error('  ❌', msg); failed++; } else console.log('  ✅', msg); }

const list = [
    { id: 21, name: 'Common.Side.Effects.S01', files: [{ name: 'S01E01 Pilot.mkv' }, { name: 'S01E02 Lakeshore Limited.mkv' }] },
    { id: 22, name: 'Common.Side.Effects.S02', files: [{ name: 'Common.Side.Effects.S02E01.mkv' }] },
    { id: 23, name: 'Some.Movie.2020', files: [{ name: 'Some.Movie.2020.mkv' }] }
];
const show = { seasons: [
    { season: 1, episodes: [{ title: 'S01E01 Pilot.mkv' }, { title: 'S01E02 Lakeshore Limited.mkv' }] },
    { season: 2, episodes: [{ title: 'Common.Side.Effects.S02E01.mkv' }, { title: 'Common.Side.Effects.S02E02.mkv' }] }
] };

console.log('Проверка findTorrentsForShow:');
const r = findTorrentsForShow(show, list);
ok(r.torrents.length === 2, 'сезон-пак дедуплицирован: 3 матч-серии → 2 раздачи');
ok(r.torrents.some(t => t.id === 21) && r.torrents.some(t => t.id === 22), 'найдены обе раздачи сезонов (21, 22)');
ok(!r.torrents.some(t => t.id === 23), 'чужая раздача (фильм) не зацеплена');
ok(r.matchedEpisodes === 3, 'покрыто 3 серии (S02E02 без раздачи)');
ok(r.totalEpisodes === 4, 'всего 4 серии');
const empty = findTorrentsForShow(show, []);
ok(empty.torrents.length === 0 && empty.totalEpisodes === 4, 'пустой список Transmission → 0 раздач');
const none = findTorrentsForShow(null, list);
ok(none.torrents.length === 0 && none.totalEpisodes === 0, 'нет сериала → пустой результат без падения');

if (failed) { console.error('\nРЕГРЕСС: ' + failed + ' проверок упало.'); process.exit(1); }
console.log('Все проверки пройдены.');
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node tools/verify-show-delete.js`
Expected: exit 1, `Error: not found in dlna.js: findTorrentsForShow`

- [ ] **Step 3: Реализовать `findTorrentsForShow`**

В `plugins/dlna.js`, top-level сразу после `findTorrentForFile` (и после `matchSavedTrack` из плана track-memory):

```javascript
    /**
     * Все раздачи Transmission, покрывающие серии сериала. Сезон-пак матчится
     * многими сериями в одну раздачу — id дедуплицируются. Матчинг наследует
     * консервативность findTorrentForFile: лучше не найти, чем удалить чужое.
     */
    function findTorrentsForShow(showEntry, list) {
        var seen = {};
        var res = { torrents: [], matchedEpisodes: 0, totalEpisodes: 0 };
        var seasons = (showEntry && showEntry.seasons) || [];
        for (var s = 0; s < seasons.length; s++) {
            var eps = seasons[s].episodes || [];
            for (var e = 0; e < eps.length; e++) {
                res.totalEpisodes++;
                var hit = findTorrentForFile(eps[e].title, list);
                if (hit) {
                    res.matchedEpisodes++;
                    if (!seen[hit.id]) { seen[hit.id] = true; res.torrents.push(hit); }
                }
            }
        }
        return res;
    }
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node tools/verify-show-delete.js`
Expected: exit 0, все ✅

- [ ] **Step 5: Подключить в npm test**

В `package.json` заменить строку scripts.test (уже включающую verify-track-memory из предыдущего плана):

```json
    "test": "node tools/verify-parser.js && node tools/verify-torrent-match.js && node tools/verify-track-memory.js && node tools/verify-show-delete.js",
```

Run: `npm test`
Expected: exit 0, все четыре скрипта зеленые

- [ ] **Step 6: Commit**

```bash
git add plugins/dlna.js tools/verify-show-delete.js package.json
git commit -m "feat(delete): хелпер findTorrentsForShow + юнит-тест агрегации раздач"
```

---

### Task 2: `deleteShowFiles` + long-press на карточке сериала

**Files:**
- Modify: `plugins/dlna.js` — `Component`: после `deleteMovieFile` (~line 1986) и в `renderShowCard` (~line 1704, перед `return card;`)

- [ ] **Step 1: Добавить `deleteShowFiles`**

Сразу после функции `deleteMovieFile` (после ее закрывающей `}` на ~line 1985):

```javascript
        /**
         * Удаление сериала целиком: все раздачи, чьи файлы матчатся на серии,
         * уходят одним torrent-remove с delete-local-data. Серии, чьих раздач
         * уже нет в Transmission, удалить нельзя — говорим об этом в
         * подтверждении, но найденное удалить даем.
         */
        function deleteShowFiles(showEntry, card) {
            if (!Lampa.Storage.field(STORAGE_TR_ADDR)) {
                Lampa.Noty.show('Transmission не настроен — удаление недоступно');
                Lampa.Controller.toggle('content');
                return;
            }
            var displayName = (showEntry.tmdb && (showEntry.tmdb.name || showEntry.tmdb.original_name)) || showEntry.show;
            TransmissionClient.list(function (list) {
                var found = findTorrentsForShow(showEntry, list);
                if (!found.torrents.length) {
                    Lampa.Noty.show('Не нашел раздач сериала в Transmission — удалить можно только через web-UI роутера');
                    Lampa.Controller.toggle('content');
                    return;
                }
                var subtitle = found.torrents.map(function (t) { return escapeHtml(t.name); }).join(', ');
                if (found.matchedEpisodes < found.totalEpisodes) {
                    subtitle += ' — покрыто ' + found.matchedEpisodes + ' из ' + found.totalEpisodes + ' серий, остальное через web-UI роутера';
                }
                Lampa.Select.show({
                    title: 'Удалить «' + escapeHtml(displayName) + '» с диска?',
                    items: [
                        {
                            title: 'Да, удалить ' + found.torrents.length + ' ' + ruPlural(found.torrents.length, ['раздачу', 'раздачи', 'раздач']),
                            subtitle: subtitle,
                            _yes: true
                        },
                        { title: 'Назад', _yes: false }
                    ],
                    onSelect: function (a) {
                        if (!a._yes) { Lampa.Controller.toggle('content'); return; }
                        var ids = found.torrents.map(function (t) { return t.id; });
                        TransmissionClient.remove(ids, true, function () {
                            Lampa.Noty.show('Удалено раздач: ' + ids.length + '. MiniDLNA уберет сериал после ресканирования');
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

- [ ] **Step 2: Long-press на карточке сериала**

В `renderShowCard`, после блока `card.on('hover:enter', ...)` и перед `return card;` (~line 1704):

```javascript
            // Lampa шлет либо hover:long, либо hover:enter (по длительности нажатия),
            // не оба — меню удаления не конфликтует с открытием сериала.
            card.on('hover:long', function () {
                Lampa.Select.show({
                    title: escapeHtml(showEntry.show || 'Сериал'),
                    items: [{ title: 'Удалить сериал с диска', _act: 'del' }, { title: 'Закрыть', _act: 'close' }],
                    onSelect: function (a) {
                        if (a._act !== 'del') { Lampa.Controller.toggle('content'); return; }
                        deleteShowFiles(showEntry, card);
                    },
                    onBack: function () { Lampa.Controller.toggle('content'); }
                });
            });
```

(`deleteShowFiles` объявлена ниже по файлу — function declarations в scope `Component` хойстятся, как у `deleteMovieFile`, которую `renderMovieCard` тоже зовет до объявления.)

- [ ] **Step 3: Проверка**

Run: `npm test`
Expected: exit 0

Run: `node -e "new Function(require('fs').readFileSync('plugins/dlna.js','utf8'))"`
Expected: без ошибок

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(delete): удаление сериала разом через Transmission по long-press"
```

---

### Task 3: Версия 0.15.0 + README

**Files:**
- Modify: `plugins/dlna.js:18` (PLUGIN_VERSION)
- Modify: `README.md` (раздел про Transmission / «Возможности»)

- [ ] **Step 1: Поднять версию**

`plugins/dlna.js:18`:

```javascript
    var PLUGIN_VERSION = '0.15.0';
```

- [ ] **Step 2: README**

В раздел «Возможности» (рядом с существующим описанием удаления фильма) добавить:

```markdown
- Long-press OK на карточке сериала — удаление всего сериала с диска разом:
  все раздачи Transmission, покрывающие серии, уходят одним действием
```

- [ ] **Step 3: Финальная проверка**

Run: `npm test`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js README.md
git commit -m "v0.15.0: удаление сериала разом через Transmission"
```

---

## Ручная верификация на устройстве (после деплоя)

На живом Transmission/DLNA (memory: verify-against-live-dlna):

1. Сериал с сезон-паком в Transmission → long-press на карточке → в подтверждении одна раздача с именем пака → «Да» → раздача ушла из Transmission, файлы с диска, после рескана MiniDLNA сериал пропал из «Все».
2. Сериал, которого уже нет в Transmission → long-press → Noty «Не нашел раздач…», ничего не удалено.
3. Transmission не настроен → Noty «Transmission не настроен…».
4. Long-press на карточке фильма — работает как раньше (регресс).
