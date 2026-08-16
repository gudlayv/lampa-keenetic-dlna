# Запоминание озвучки и субтитров между сериями — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выбранная в плеере озвучка (и субтитры) запоминается по сериалу в `Lampa.Storage` и автоматически восстанавливается при переключении серии и при продолжении просмотра в другой день.

**Architecture:** Все изменения внутри существующего модуля `TrackRelabel` в `plugins/dlna.js` (порт cub.red/tracks): выбор дорожки уже проходит через наши сеттеры `enabled`/`mode` — там записываем выбор; восстановление — в `setTracks()`/`setSubs()` после релейблинга, каскадом label → language → index. Ключ сериала берется из `card` первого старта и живет в переменной модуля (переключение плейлиста приходит без `card`).

**Tech Stack:** vanilla JS (ES5, плагин LAMPA), Lampa.Storage, тест-раннер проекта — node-скрипты в `tools/` с извлечением pure-функций brace-matching + eval (см. `tools/verify-torrent-match.js`).

**Spec:** `docs/superpowers/specs/2026-08-16-track-memory-design.md`

---

### Task 1: Чистый хелпер `matchSavedTrack` + юнит-тест

**Files:**
- Modify: `plugins/dlna.js` (top-level, рядом с `findTorrentForFile`, ~line 2550)
- Create: `tools/verify-track-memory.js`
- Modify: `package.json` (scripts.test)

- [ ] **Step 1: Написать падающий тест**

Создать `tools/verify-track-memory.js`:

```javascript
#!/usr/bin/env node
/**
 * tools/verify-track-memory.js — юнит-тест сопоставления сохраненного
 * выбора дорожки со списком дорожек меню (matchSavedTrack из dlna.js).
 * Извлечение pure-функции — brace-matching + eval, как verify-parser.js.
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
eval(extract('matchSavedTrack'));

let failed = 0;
function ok(cond, msg) { if (!cond) { console.error('  ❌', msg); failed++; } else console.log('  ✅', msg); }

const tracks = [
    { index: 0, language: 'eng', label: 'Original' },
    { index: 1, language: 'rus', label: 'LostFilm' },
    { index: 2, language: 'rus', label: 'HDRezka' }
];

console.log('Проверка matchSavedTrack:');
ok(matchSavedTrack({ label: 'HDRezka', language: 'rus', index: 1 }, tracks) === 2, 'точный label важнее language и index');
ok(matchSavedTrack({ label: 'Кубик в кубе', language: 'rus', index: 5 }, tracks) === 1, 'нет label-матча → первый матч по language');
ok(matchSavedTrack({ label: 'Кубик в кубе', language: 'ukr', index: 2 }, tracks) === 2, 'нет label/language → фолбэк по index (поле index, не позиция)');
ok(matchSavedTrack({ label: 'Кубик в кубе', language: 'ukr', index: 9 }, tracks) === null, 'ничего не совпало → null');
ok(matchSavedTrack({ label: '', language: '', index: 0 }, tracks) === 0, 'пустые label/language не матчатся, index работает');
ok(matchSavedTrack(null, tracks) === null, 'null-выбор → null');
ok(matchSavedTrack({ label: 'LostFilm' }, []) === null, 'пустой список дорожек → null');

if (failed) { console.error('\nРЕГРЕСС: ' + failed + ' проверок упало.'); process.exit(1); }
console.log('Все проверки пройдены.');
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node tools/verify-track-memory.js`
Expected: exit 1, `Error: not found in dlna.js: matchSavedTrack`

- [ ] **Step 3: Реализовать `matchSavedTrack`**

В `plugins/dlna.js`, top-level сразу после `findTorrentForFile` (перед `var TransmissionClient`):

```javascript
    /**
     * Сопоставление сохраненного выбора дорожки со списком дорожек меню.
     * Каскад: точный label (имя студии) → language → index. Возвращает индекс
     * элемента в массиве tracks или null. Пустые label/language не матчим —
     * иначе два безымянных релиза дадут ложное совпадение.
     */
    function matchSavedTrack(saved, tracks) {
        if (!saved || !Array.isArray(tracks) || !tracks.length) return null;
        var i;
        if (saved.label) {
            for (i = 0; i < tracks.length; i++) if (tracks[i].label === saved.label) return i;
        }
        if (saved.language) {
            for (i = 0; i < tracks.length; i++) if (tracks[i].language === saved.language) return i;
        }
        if (typeof saved.index === 'number') {
            for (i = 0; i < tracks.length; i++) if (tracks[i].index === saved.index) return i;
        }
        return null;
    }
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node tools/verify-track-memory.js`
Expected: exit 0, все ✅

- [ ] **Step 5: Подключить тест в npm test**

В `package.json` заменить строку scripts.test:

```json
    "test": "node tools/verify-parser.js && node tools/verify-torrent-match.js && node tools/verify-track-memory.js",
```

Run: `npm test`
Expected: exit 0, все три скрипта зеленые

- [ ] **Step 6: Commit**

```bash
git add plugins/dlna.js tools/verify-track-memory.js package.json
git commit -m "feat(tracks): хелпер matchSavedTrack + юнит-тест сопоставления дорожек"
```

---

### Task 2: Память выбора в Lampa.Storage (внутри TrackRelabel)

**Files:**
- Modify: `plugins/dlna.js` — IIFE `TrackRelabel` (~line 2906, после `var installed = false;`)

- [ ] **Step 1: Добавить хранилище и ключ сериала**

Внутри `var TrackRelabel = (function () {` сразу после `var installed = false;`:

```javascript
        var MEM_STORAGE_KEY = 'dlna_track_memory';
        var MEM_LIMIT = 50;
        /**
         * Ключ текущего сериала живет на уровне модуля: при переключении серии
         * плейлиста Player.start приходит без card (в элементах плейлиста только
         * title/url/timeline), поэтому ключ вычисляется на первом старте
         * через playMovie и переиспользуется последующими стартами.
         */
        var memSeriesKey = null;

        function seriesKeyFromCard(card) {
            if (!card) return null;
            if (card.id) return 'tmdb' + card.id;
            var t = card.title || card.name || card.original_title || card.original_name;
            return t ? 'name_' + normKey(t) : null;
        }

        function memLoad() {
            try {
                var m = Lampa.Storage.get(MEM_STORAGE_KEY, {});
                if (typeof m === 'string') m = JSON.parse(m);
                return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
            } catch (e) { return {}; }
        }

        function memGet(kind) {
            if (!memSeriesKey) return null;
            var rec = memLoad()[memSeriesKey];
            return (rec && rec[kind]) || null;
        }

        function memSet(kind, choice) {
            if (!memSeriesKey) return;
            try {
                var map = memLoad();
                var rec = map[memSeriesKey] || {};
                rec[kind] = choice;
                rec.time = Date.now();
                map[memSeriesKey] = rec;
                var keys = Object.keys(map);
                while (keys.length > MEM_LIMIT) {
                    var oldest = keys.reduce(function (a, b) { return (map[a].time || 0) <= (map[b].time || 0) ? a : b; });
                    delete map[oldest];
                    keys = Object.keys(map);
                }
                Lampa.Storage.set(MEM_STORAGE_KEY, map);
            } catch (e) {}
        }
```

- [ ] **Step 2: Обновлять ключ при старте**

В начале `function subscribe(data) {` (первая строка тела):

```javascript
            var startKey = seriesKeyFromCard(data.card);
            if (startKey) memSeriesKey = startKey;
```

- [ ] **Step 3: Проверить, что ничего не сломалось**

Run: `npm test`
Expected: exit 0 (поведение плеера не менялось, только новые функции)

Run: `node -e "new Function(require('fs').readFileSync('plugins/dlna.js','utf8'))"`
Expected: без ошибок (синтаксис валиден)

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(tracks): хранилище выбора дорожек по сериалу в Lampa.Storage"
```

---

### Task 3: Запись выбора в сеттерах + восстановление после релейблинга

**Files:**
- Modify: `plugins/dlna.js` — функции `setTracks`/`setSubs` внутри `subscribe` (~lines 2942–3005)

- [ ] **Step 1: Запись выбора аудио в сеттере `enabled`**

В `setTracks()`, в `Object.defineProperty(elem, 'enabled', ...)`, внутри `if (v) { ... }` после строки `if (trk) { trk.enabled = true; trk.selected = true; }` добавить:

```javascript
                                memSet('audio', { label: elem.label, language: elem.language, index: elem.index });
```

- [ ] **Step 2: Восстановление аудио**

Внутри `subscribe`, рядом с `setTracks`, добавить функцию:

```javascript
            function applySavedAudio(new_tracks) {
                var saved = memGet('audio');
                if (!saved) return;
                var at = matchSavedTrack(saved, new_tracks);
                if (at === null) return;
                var aud = getTracks();
                var trk = aud[new_tracks[at].index];
                if (!trk) return;
                for (var i = 0; i < aud.length; i++) { aud[i].enabled = false; aud[i].selected = false; }
                trk.enabled = true; trk.selected = true;
                new_tracks.forEach(function (t, j) { t.selected = j === at; });
            }
```

В конце `setTracks()` заменить:

```javascript
                if (parse_tracks.length) Lampa.PlayerPanel.setTracks(new_tracks);
```

на:

```javascript
                applySavedAudio(new_tracks);
                if (parse_tracks.length) Lampa.PlayerPanel.setTracks(new_tracks);
```

- [ ] **Step 3: Запись выбора субтитров + «выключено» в сеттере `mode`**

В `setSubs()`, заменить целиком `Object.defineProperty(elem, 'mode', ...)`:

```javascript
                    Object.defineProperty(elem, 'mode', {
                        set: function (v) {
                            if (v === 'disabled' || v === 'hidden') {
                                /**
                                 * Панель гасит сабы по одному; когда ни один не showing —
                                 * это явное «Отключить». Выбор конкретного саба панель
                                 * делает следом — memSet перезапишет off корректным выбором.
                                 */
                                var all = getSubs();
                                var any = false;
                                for (var i = 0; i < all.length; i++) if (all[i].mode === 'showing') any = true;
                                if (!any) memSet('subs', { off: true });
                                return;
                            }
                            if (v) {
                                var txt = getSubs();
                                var sub = txt[elem.index];
                                for (var i = 0; i < txt.length; i++) { txt[i].mode = 'disabled'; txt[i].selected = false; }
                                if (sub) { sub.mode = 'showing'; sub.selected = true; }
                                memSet('subs', { label: elem.label, language: elem.language, index: elem.index });
                            }
                        },
                        get: function () {}
                    });
```

- [ ] **Step 4: Восстановление субтитров**

Рядом с `applySavedAudio` добавить:

```javascript
            function applySavedSubs(new_subs) {
                var saved = memGet('subs');
                if (!saved) return;
                var txt = getSubs();
                var i;
                if (saved.off) {
                    for (i = 0; i < txt.length; i++) { txt[i].mode = 'disabled'; txt[i].selected = false; }
                    new_subs.forEach(function (s) { s.selected = false; });
                    return;
                }
                var at = matchSavedTrack(saved, new_subs);
                if (at === null) return;
                var sub = txt[new_subs[at].index];
                if (!sub) return;
                for (i = 0; i < txt.length; i++) { txt[i].mode = 'disabled'; txt[i].selected = false; }
                sub.mode = 'showing'; sub.selected = true;
                new_subs.forEach(function (s, j) { s.selected = j === at; });
            }
```

В конце `setSubs()` заменить:

```javascript
                if (parse_subs.length) Lampa.PlayerPanel.setSubs(new_subs);
```

на:

```javascript
                applySavedSubs(new_subs);
                if (parse_subs.length) Lampa.PlayerPanel.setSubs(new_subs);
```

- [ ] **Step 5: Проверка**

Run: `npm test`
Expected: exit 0

Run: `node -e "new Function(require('fs').readFileSync('plugins/dlna.js','utf8'))"`
Expected: без ошибок

- [ ] **Step 6: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(tracks): запись выбора озвучки/сабов и восстановление между сериями"
```

---

### Task 4: Версия 0.14.0 + README

**Files:**
- Modify: `plugins/dlna.js:18` (PLUGIN_VERSION)
- Modify: `README.md` (раздел «Возможности»)

- [ ] **Step 1: Поднять версию**

`plugins/dlna.js:18`:

```javascript
    var PLUGIN_VERSION = '0.14.0';
```

- [ ] **Step 2: README**

В раздел «Возможности» после пункта про названия дорожек (или последним) добавить:

```markdown
- Выбранная озвучка и субтитры запоминаются по сериалу: при следующей
  серии и при продолжении просмотра в другой день включаются сами
```

- [ ] **Step 3: Финальная проверка**

Run: `npm test`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js README.md
git commit -m "v0.14.0: запоминание озвучки и субтитров между сериями"
```

---

## Ручная верификация на устройстве (после деплоя)

На телевизоре с живым DLNA (memory: verify-against-live-dlna):

1. Запустить серию сериала с несколькими озвучками → выбрать не-дефолтную студию.
2. Дождаться автоперехода (или переключить вручную) → озвучка та же, галка в меню на ней.
3. Выйти из плеера, перезапустить LAMPA, продолжить сериал → озвучка та же.
4. Включить сабы → следующая серия → сабы те же. Выключить → следующая серия → выключены (если пункт «Отключить» панели дергает наши сеттеры — иначе задокументированное ограничение).
5. Фильм/сериал без ffprobe-прокси → поведение как раньше, без ошибок в консоли.
