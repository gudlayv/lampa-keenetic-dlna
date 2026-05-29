# Карточная сетка в dlna.js — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить вертикальный список строк (`.dlna-row`) в плагине LAMPA на сетку постеров-карточек (5 в ряд), с агрегат-карточкой на сериал и экраном выбора сезона.

**Architecture:** Кастомные tile-билдеры внутри существующего `Lampa.Scroll` (не нативный `Lampa.Card`). Новый слой группировки `groupShows` поверх текущего `groupEpisodes` сворачивает сезоны одного сериала в одну карточку. Серии остаются списком. Фокус — Tizen-safe (рамка через `box-shadow`, без transition/scale).

**Tech Stack:** Vanilla JS (IIFE-плагин), jQuery (`$`), LAMPA API (`Lampa.Scroll`, `Lampa.Controller`, `Lampa.Timeline`), TMDB. Все правки — в одном файле `plugins/dlna.js`.

---

## Замечание по верификации

В проекте **нет юнит-тестов** (`npm test` — заглушка). Проверка — визуальная, по сложившемуся паттерну:

- **Инъекция без ошибок**: `node tools/browse.js --plugin plugins/dlna.js` грузит lampa.mx (headless Chromium), инжектит плагин, снимает скриншот в `shots/` и логирует `console`/`pageerror`. Критерий прохождения каждой задачи: **в логе нет `pageerror` и нет новых ошибок плагина**. Без настроенного прокси UI покажет желтую плашку «Прокси не настроен» — это норма для headless-прогона (проверяем, что плашка рендерится в новом контейнере, а не ломает разметку).
- **Раскладка с данными**: проверяется вручную на устройстве/в headed-браузере с реальной DLNA-библиотекой через `serve.py`-прокси (у карточек должны появиться постеры/мета). Каждая задача содержит конкретный ручной чек-лист.

TDD в классическом виде неприменим (нет раннера) — поэтому «тест» = прогон `browse.js` + ручной чек. Это сознательно следует существующим практикам репозитория, новый тест-харнес не вводим (вне scope спеки).

## File Structure

Все изменения — в `plugins/dlna.js` (один файл, IIFE-плагин — таков паттерн проекта, не дробим).

Логические блоки, которые трогаем (анкеримся по именам функций, не по номерам строк — они сдвинутся):

- `injectStyles()` — добавляем CSS сетки и карточки.
- helpers-секция (рядом с `escapeHtml`/`formatSize`) — новый `ruPlural()`.
- `groupEpisodes()` — рядом добавляем `groupShows()`.
- row-билдеры → tile-билдеры: новые `renderMovieCard()`, `renderShowCard()`, `renderFolderCard()`, диспетчер `renderCard()`.
- `renderEntries()` — ветвление: сетка карточек vs список серий; контейнер `.dlna-grid`.
- `renderSeasonPicker()` — новый экран `kind:'seasons'`.
- `this.openCurrent` — ветка для `top.kind === 'seasons'`.
- `refreshProgress()` — расширяем селектор на `.dlna-card[data-hash]`.

Без изменений: `playEntry`, `playMovie`, `buildCard`, `lampaHash`, `tmdbSearch`, `tmdbSeason`, `tmdbPosterUrl`, `parseFilename`, фокус/скролл-интеграция, `Lampa.Controller`. `renderVideoRow` (ветка эпизода) остается — используется на экране серий.

---

## Task 1: CSS сетки и карточки (Tizen-safe фокус)

**Files:**
- Modify: `plugins/dlna.js` — функция `injectStyles()` (конкатенация в `style.textContent`)

- [ ] **Step 1: Добавить CSS в `injectStyles`**

В `injectStyles()` найди конец строки со стилем плейсхолдер-svg:

```js
            '.dlna-keenetic .dlna-row__poster svg{width:2em!important;height:2em!important;}';
```

Замени завершающую `;` на `+` и допиши блок сетки (вставляется перед `document.head.appendChild(style);`):

```js
            '.dlna-keenetic .dlna-row__poster svg{width:2em!important;height:2em!important;}' +
            // --- Карточная сетка ---
            '.dlna-grid{display:flex;flex-wrap:wrap;gap:1.4em 1.2em;padding:0.6em 1em 1.4em;}' +
            '.dlna-card{width:calc((100% - 4 * 1.2em) / 5);position:relative;}' +
            '.dlna-card__poster{position:relative;width:100%;padding-bottom:150%;border-radius:0.7em;overflow:hidden;background:rgba(255,255,255,0.07) center/cover no-repeat;}' +
            '.dlna-card__ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0.35;}' +
            '.dlna-card__progress{height:0.32em;background:rgba(255,255,255,0.12);border-radius:0.16em;margin-top:0.4em;overflow:hidden;}' +
            '.dlna-card__progress > div{height:100%;background:#7ed957;}' +
            '.dlna-card__title{font-size:1.02em;font-weight:600;line-height:1.2;margin-top:0.45em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
            '.dlna-card__meta{font-size:0.82em;opacity:0.72;margin-top:0.2em;}' +
            '.dlna-card__meta .rate{color:#ffd966;}' +
            '.dlna-card__meta .watched{color:#7ed957;margin-right:0.35em;font-weight:bold;}' +
            // Фокус: рамка на постере через box-shadow, без transition/scale (Tizen WebKit 76).
            // Сама плитка фон не подсвечивает — перебиваем общий .selector.focus.
            '.dlna-keenetic .dlna-card.focus,.dlna-keenetic .dlna-card.hover{background:transparent!important;}' +
            '.dlna-keenetic .dlna-card.focus .dlna-card__poster,.dlna-keenetic .dlna-card.hover .dlna-card__poster{box-shadow:0 0 0 0.22em #fff;}' +
            '.dlna-keenetic .dlna-card__ph svg{width:2.4em!important;height:2.4em!important;}';
```

- [ ] **Step 2: Прогон инъекции**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: завершается без `pageerror`; в `shots/` появился свежий png; в логе нет ошибок плагина. (CSS пока ни на что не влияет — карточек в DOM еще нет.)

- [ ] **Step 3: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(grid): CSS карточной сетки и Tizen-safe фокус"
```

---

## Task 2: Хелпер `ruPlural` и группировка `groupShows`

**Files:**
- Modify: `plugins/dlna.js` — рядом с `escapeHtml`/`formatSize` (helpers) и рядом с `groupEpisodes`

- [ ] **Step 1: Добавить `ruPlural` в секцию helpers**

Рядом с `function formatSize(...)` добавь:

```js
// Русская плюрализация: ruPlural(2, ['сезон','сезона','сезонов']) -> 'сезона'
function ruPlural(n, forms) {
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
    return forms[2];
}
```

- [ ] **Step 2: Добавить `groupShows` рядом с `groupEpisodes`**

Сразу после функции `groupEpisodes` добавь:

```js
// Слой поверх groupEpisodes: виртуальные сезоны одного сериала сворачиваются
// в одну агрегат-карточку. Фильмы/папки проходят как есть, порядок сохраняется.
function groupShows(entries) {
    var shows = {};
    var result = [];
    entries.forEach(function (entry) {
        if (entry.isVirtualSeries) {
            var key = entry.show.toLowerCase();
            if (!shows[key]) {
                shows[key] = {
                    isVirtualShow: true,
                    show: entry.show,
                    seasons: [],
                    totalEpisodes: 0
                };
                result.push(shows[key]);
            }
            shows[key].seasons.push({ season: entry.season, episodes: entry.episodes });
            shows[key].totalEpisodes += entry.episodes.length;
        } else {
            result.push(entry);
        }
    });
    result.forEach(function (e) {
        if (e.isVirtualShow) {
            e.seasons.sort(function (a, b) { return a.season - b.season; });
        }
    });
    return result;
}
```

- [ ] **Step 3: Прогон инъекции**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: без `pageerror`. (Функции объявлены, но еще не вызываются — проверяем отсутствие синтаксических ошибок.)

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(grid): ruPlural + groupShows (агрегация сезонов в сериал)"
```

---

## Task 3: `renderMovieCard` — карточка фильма

**Files:**
- Modify: `plugins/dlna.js` — добавить функцию рядом с `renderVideoRow`

- [ ] **Step 1: Добавить `renderMovieCard`**

```js
function renderMovieCard(entry) {
    var hash = fileHash(entry.url || entry.id || (entry.title || ''));
    entry._hash = hash;
    var savedTl = (window.Lampa && Lampa.Timeline) ? Lampa.Timeline.view(hash) : null;

    var card = $('<div class="selector dlna-card dlna-card--movie" data-hash="' + hash + '"></div>');
    var poster = $('<div class="dlna-card__poster"></div>');
    poster.append('<div class="dlna-card__ph">' + ICON_VIDEO + '</div>');
    card.append(poster);

    // прогресс-бар (0<percent<80) — под постером
    var progress = $('<div class="dlna-card__progress" style="display:none;"><div style="width:0%;"></div></div>');
    card.append(progress);

    var title = $('<div class="dlna-card__title"></div>').text(entry.title);
    card.append(title);
    var meta = $('<div class="dlna-card__meta"></div>');
    card.append(meta);

    function renderMeta(opts) {
        opts = opts || {};
        var bits = [];
        var watched = opts.percent >= 80;
        var html = '';
        if (watched) html += '<span class="watched">✓</span>';
        if (opts.year) bits.push(opts.year);
        bits.push('фильм');
        if (opts.rate) bits.push('<span class="rate">★ ' + opts.rate.toFixed(1) + '</span>');
        if (entry.resolution) bits.push(escapeHtml(entry.resolution));
        meta.html(html + bits.join(' · '));
    }

    function applyProgress(tl) {
        var pct = tl && tl.percent ? Math.min(100, tl.percent) : 0;
        if (pct > 0 && pct < 80) {
            progress.show().find('div').css('width', pct + '%');
        } else {
            progress.hide();
        }
    }

    renderMeta({ percent: savedTl ? savedTl.percent : 0 });
    applyProgress(savedTl);

    function applyTmdb(hit) {
        if (!hit) {
            var parsed = entry._parsed || parseFilename(entry.title);
            title.text(parsed.title || entry.title);
            renderMeta({ year: parsed.year, percent: (Lampa.Timeline.view(entry._hash) || {}).percent || 0 });
            return;
        }
        var tmdbTitle = hit.title || hit.original_title || entry.title;
        var year = (hit.release_date || '').slice(0, 4);
        title.text(tmdbTitle);
        if (hit.poster_path) {
            poster.css('background-image', 'url("' + tmdbPosterUrl(hit.poster_path, 'w300') + '")');
            poster.find('.dlna-card__ph').remove();
        }
        entry.tmdb = hit;
        var newHash = lampaHash(hit);
        if (newHash) {
            entry._hash = newHash;
            card.attr('data-hash', newHash);
        }
        var tl = Lampa.Timeline.view(entry._hash);
        renderMeta({ year: year, rate: hit.vote_average, percent: tl ? tl.percent : 0 });
        applyProgress(tl);
    }

    if (entry._tmdb) applyTmdb(entry._tmdb);
    else {
        var p = entry._parsed || parseFilename(entry.title);
        tmdbSearch(p.title, p.year, 'movie', applyTmdb);
    }

    card.on('hover:focus', function () { scroll.update(card); });
    card.on('hover:enter', function () { playEntry(entry, null); });
    return card;
}
```

- [ ] **Step 2: Прогон инъекции**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: без `pageerror` (функция объявлена, вызов появится в Task 6).

- [ ] **Step 3: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(grid): renderMovieCard"
```

---

## Task 4: `renderShowCard` — агрегат-карточка сериала

**Files:**
- Modify: `plugins/dlna.js` — добавить рядом с `renderSeriesRow`

- [ ] **Step 1: Добавить `renderShowCard`**

```js
function renderShowCard(showEntry) {
    var card = $('<div class="selector dlna-card dlna-card--show"></div>');
    var poster = $('<div class="dlna-card__poster"></div>');
    poster.append('<div class="dlna-card__ph">' + ICON_FOLDER + '</div>');
    card.append(poster);

    var title = $('<div class="dlna-card__title"></div>').text(showEntry.show);
    card.append(title);
    var meta = $('<div class="dlna-card__meta"></div>');
    card.append(meta);

    function metaText(rate) {
        var seasonsN = showEntry.seasons.length;
        var epsN = showEntry.totalEpisodes;
        var parts = [];
        if (seasonsN > 1) parts.push(seasonsN + ' ' + ruPlural(seasonsN, ['сезон', 'сезона', 'сезонов']));
        parts.push(epsN + ' ' + ruPlural(epsN, ['серия', 'серии', 'серий']));
        if (rate) parts.push('<span class="rate">★ ' + rate.toFixed(1) + '</span>');
        return parts.join(' · ');
    }
    meta.html(metaText(null));

    function applyTmdb(hit) {
        if (!hit) { meta.html(metaText(null)); return; }
        showEntry.tmdb = hit;
        var name = hit.name || hit.original_name || showEntry.show;
        title.text(name);
        if (hit.poster_path) {
            poster.css('background-image', 'url("' + tmdbPosterUrl(hit.poster_path, 'w300') + '")');
            poster.find('.dlna-card__ph').remove();
        }
        meta.html(metaText(hit.vote_average));
    }
    // переиспользуем кешированный _tmdb первой серии, если есть
    var cached = showEntry.seasons[0] && showEntry.seasons[0].episodes[0] && showEntry.seasons[0].episodes[0]._tmdb;
    if (cached) applyTmdb(cached);
    else tmdbSearch(showEntry.show, null, 'tv', applyTmdb);

    function openSeason(seasonObj) {
        var stack = getStack();
        var tmdb = showEntry.tmdb || null;
        var payload = seasonObj.episodes.map(function (e) {
            e._series = { show: showEntry.show, tmdb: tmdb, season: seasonObj.season };
            return e;
        });
        stack.push({
            kind: 'episodes',
            title: (tmdb ? (tmdb.name || tmdb.original_name) : showEntry.show) + ' · Сезон ' + seasonObj.season,
            payload: payload
        });
        self.openCurrent();
    }

    card.on('hover:focus', function () { scroll.update(card); });
    card.on('hover:enter', function () {
        if (showEntry.seasons.length > 1) {
            getStack().push({
                kind: 'seasons',
                title: (showEntry.tmdb ? (showEntry.tmdb.name || showEntry.tmdb.original_name) : showEntry.show),
                show: showEntry
            });
            self.openCurrent();
        } else {
            openSeason(showEntry.seasons[0]);
        }
    });
    return card;
}
```

- [ ] **Step 2: Прогон инъекции**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: без `pageerror`.

- [ ] **Step 3: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(grid): renderShowCard (агрегат сериала + навигация в сезоны)"
```

---

## Task 5: `renderFolderCard` + диспетчер `renderCard`

**Files:**
- Modify: `plugins/dlna.js` — рядом с `renderEntryRow`

- [ ] **Step 1: Добавить `renderFolderCard` и `renderCard`**

```js
function renderFolderCard(entry) {
    var card = $('<div class="selector dlna-card dlna-card--folder"></div>');
    var poster = $('<div class="dlna-card__poster"></div>');
    poster.append('<div class="dlna-card__ph">' + ICON_FOLDER + '</div>');
    card.append(poster);
    card.append($('<div class="dlna-card__title"></div>').text(entry.title));
    card.append('<div class="dlna-card__meta">папка</div>');
    card.on('hover:focus', function () { scroll.update(card); });
    card.on('hover:enter', function () {
        getStack().push({ id: entry.id, title: entry.title });
        self.openCurrent();
    });
    return card;
}

// Диспетчер карточки в сетке (не на экране серий — там список через renderEntryRow).
function renderCard(entry) {
    if (entry.isVirtualShow) return renderShowCard(entry);
    if (entry.isFolder) return renderFolderCard(entry);
    return renderMovieCard(entry);
}
```

- [ ] **Step 2: Прогон инъекции**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: без `pageerror`.

- [ ] **Step 3: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(grid): renderFolderCard + диспетчер renderCard"
```

---

## Task 6: Ветвление `renderEntries` — сетка vs список серий

**Files:**
- Modify: `plugins/dlna.js` — функция `renderEntries()`

- [ ] **Step 1: Переписать тело `renderEntries` после кнопки «Назад»**

Найди в `renderEntries` блок, начинающийся с `var top = stack[stack.length - 1];` и заканчивающийся циклом `entries.forEach(function (entry) { var line = renderEntryRow(entry); ... });` плюс хвост (`self.activity.loader(false)` и toggle). Замени от `var top = ...` до конца этого `forEach` (НЕ трогая финальный `loader/toggle`-блок) на:

```js
            var top = stack[stack.length - 1];
            var isEpisodes = top.kind === 'episodes';

            if (isEpisodes) {
                // Экран серий — список (16:9-кадр + описание), как раньше
                var eps = top.kind === 'episodes' || currentTab === 'movies' ? rawEntries : groupEpisodes(rawEntries);
                if (!eps.length) {
                    scroll.append($('<div style="padding:1.5em; opacity:0.6;">Папка пуста</div>'));
                }
                eps.forEach(function (entry) {
                    var line = renderEntryRow(entry);
                    line.on('hover:focus', function () { scroll.update(line); });
                    scroll.append(line);
                });
            } else {
                // Сетка карточек
                var entries = groupShows(groupEpisodes(rawEntries));
                if (!entries.length) {
                    scroll.append($('<div style="padding:1.5em; opacity:0.6;">Папка пуста</div>'));
                } else {
                    var grid = $('<div class="dlna-grid"></div>');
                    entries.forEach(function (entry) { grid.append(renderCard(entry)); });
                    scroll.append(grid);
                }
            }
```

> Примечание: на вкладке `movies` фильтр уже отдает только фильмы (без `_episode`), `groupEpisodes` там no-op, `groupShows` — passthrough. На вкладке `series`/`Все` группировка свернет сериалы в карточки.

- [ ] **Step 2: Прогон инъекции (без данных)**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: без `pageerror`; рендерится плашка «Прокси не настроен» (данных нет) — разметка не сломана.

- [ ] **Step 3: Ручная проверка на устройстве/headed с реальной DLNA**

С настроенным `serve.py`-прокси и реальной библиотекой открой плагин:
- На вкладке «Все»/«Сериалы» сериал из >1 сезона показывается **одной** карточкой с метой «N сезонов · M серий».
- Фильмы и папки — отдельными карточками, 5 в ряд.
- Постеры/рейтинг подтягиваются (async TMDB).
- Фокус пультом рисует белую рамку на постере, плитка не подсвечивается фоном.

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(grid): renderEntries рисует сетку карточек (серии остаются списком)"
```

---

## Task 7: Экран выбора сезона `renderSeasonPicker` + ветка в `openCurrent`

**Files:**
- Modify: `plugins/dlna.js` — добавить `renderSeasonPicker`; добавить ветку в `this.openCurrent`

- [ ] **Step 1: Добавить `renderSeasonPicker` рядом с `renderEntries`**

```js
// Экран выбора сезона. top: { kind:'seasons', title, show }
function renderSeasonPicker(top, opts) {
    opts = opts || {};
    scroll.clear();
    var stack = getStack();
    var backBtn = $('<div class="selector" style="margin:0.4em 1em; padding:0.7em 1em; background:rgba(58,115,255,0.15); border-radius:0.5em;">' + ICON_BACK + 'Назад</div>');
    backBtn.on('hover:enter', function () { stack.pop(); self.openCurrent(); });
    backBtn.on('hover:focus', function () { scroll.update(backBtn); });
    scroll.append(backBtn);

    var showEntry = top.show;
    var tmdb = showEntry.tmdb || null;
    var grid = $('<div class="dlna-grid"></div>');

    showEntry.seasons.forEach(function (seasonObj) {
        var card = $('<div class="selector dlna-card dlna-card--season"></div>');
        var poster = $('<div class="dlna-card__poster"></div>');
        poster.append('<div class="dlna-card__ph">' + ICON_FOLDER + '</div>');
        // fallback: общий постер сериала
        if (tmdb && tmdb.poster_path) {
            poster.css('background-image', 'url("' + tmdbPosterUrl(tmdb.poster_path, 'w300') + '")');
            poster.find('.dlna-card__ph').remove();
        }
        card.append(poster);
        card.append($('<div class="dlna-card__title"></div>').text('Сезон ' + seasonObj.season));
        var epsN = seasonObj.episodes.length;
        card.append($('<div class="dlna-card__meta"></div>').text(epsN + ' ' + ruPlural(epsN, ['серия', 'серии', 'серий'])));

        // посезонный постер TMDB (если есть)
        if (tmdb && tmdb.id != null) {
            tmdbSeason(tmdb.id, seasonObj.season, function (seasonData) {
                if (seasonData && seasonData.poster_path) {
                    poster.css('background-image', 'url("' + tmdbPosterUrl(seasonData.poster_path, 'w300') + '")');
                    poster.find('.dlna-card__ph').remove();
                }
            });
        }

        card.on('hover:focus', function () { scroll.update(card); });
        card.on('hover:enter', function () {
            var payload = seasonObj.episodes.map(function (e) {
                e._series = { show: showEntry.show, tmdb: tmdb, season: seasonObj.season };
                return e;
            });
            stack.push({
                kind: 'episodes',
                title: (tmdb ? (tmdb.name || tmdb.original_name) : showEntry.show) + ' · Сезон ' + seasonObj.season,
                payload: payload
            });
            self.openCurrent();
        });
        grid.append(card);
    });

    scroll.append(grid);
    self.activity.loader(false);
    if (!opts.skipControllerToggle) {
        self.activity.toggle();
        Lampa.Controller.toggle('content');
    }
}
```

- [ ] **Step 2: Добавить ветку в `this.openCurrent`**

В `this.openCurrent`, сразу после `setHead(); scroll.clear(); scroll.append(... 'Загрузка…' ...);` и ПЕРЕД блоком `if (top.kind === 'episodes')` вставь:

```js
            if (top.kind === 'seasons') {
                renderSeasonPicker(top, opts);
                return;
            }
```

- [ ] **Step 3: Прогон инъекции**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: без `pageerror`.

- [ ] **Step 4: Ручная проверка на устройстве**

- Тап по сериалу с >1 сезона → экран «Сезон 1 / Сезон 2 / …» карточками с посезонными постерами (или общим, если посезонного нет).
- Тап по сезону → список серий.
- Сериал с 1 сезоном → экран выбора сезона **пропускается**, сразу серии.
- «Назад» с экрана сезонов возвращает в сетку.

- [ ] **Step 5: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(grid): renderSeasonPicker + ветка kind:seasons в openCurrent"
```

---

## Task 8: Прогресс/просмотрено на карточках (`refreshProgress`)

**Files:**
- Modify: `plugins/dlna.js` — функция `refreshProgress()`

- [ ] **Step 1: Расширить `refreshProgress` на `.dlna-card`**

В конце `refreshProgress`, после существующего `body.find('.dlna-row[data-hash]').each(...)`-блока (внутри той же функции), добавь второй проход по карточкам:

```js
            // Карточки фильмов в сетке
            body.find('.dlna-card[data-hash]').each(function () {
                var card = $(this);
                var hash = card.attr('data-hash');
                if (!hash) return;
                var tl = Lampa.Timeline.view(hash);
                if (!tl) return;
                var pct = tl.percent ? Math.min(100, tl.percent) : 0;
                var progress = card.find('.dlna-card__progress');
                if (pct > 0 && pct < 80) {
                    if (!progress.length) {
                        progress = $('<div class="dlna-card__progress"><div style="width:0%;"></div></div>');
                        card.find('.dlna-card__poster').after(progress);
                    }
                    progress.show().find('div').css('width', pct + '%');
                } else if (progress.length) {
                    progress.hide();
                }
                // маркер просмотрено в мете
                var meta = card.find('.dlna-card__meta');
                var hasWatched = meta.find('.watched').length > 0;
                if (pct >= 80 && !hasWatched) {
                    meta.prepend('<span class="watched">✓</span>');
                } else if (pct < 80 && hasWatched) {
                    meta.find('.watched').remove();
                }
            });
```

- [ ] **Step 2: Прогон инъекции**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: без `pageerror`.

- [ ] **Step 3: Ручная проверка на устройстве**

- Запусти фильм-карточку, выйди из плеера на ~30% → у карточки появился тонкий прогресс-бар под постером.
- Досмотри >80% → бар убирается, в мете появляется `✓`.

- [ ] **Step 4: Commit**

```bash
git add plugins/dlna.js
git commit -m "feat(grid): прогресс и маркер просмотрено на карточках"
```

---

## Task 9: Уборка мертвого кода и полный прогон

**Files:**
- Modify: `plugins/dlna.js` — удалить неиспользуемый `renderSeriesRow`

- [ ] **Step 1: Проверить, что `renderSeriesRow` больше не вызывается**

Run: `grep -n "renderSeriesRow" plugins/dlna.js`
Expected: единственное совпадение — само объявление функции (в `renderEntryRow` ветка `isVirtualSeries` теперь не достигается в сетке, а на экране серий виртуальных серий нет). Если есть вызовы — НЕ удалять, разобраться.

- [ ] **Step 2: Удалить `renderSeriesRow` и недостижимую ветку**

Удали функцию `renderSeriesRow` целиком. В `renderEntryRow` удали ветку `if (entry.isVirtualSeries) { return renderSeriesRow(entry); }` (на экране серий entries — это эпизоды, не виртуальные серии).

- [ ] **Step 3: Полный прогон инъекции**

Run: `node tools/browse.js --plugin plugins/dlna.js`
Expected: без `pageerror`; разметка плашки целая.

- [ ] **Step 4: Полная ручная регрессия на устройстве**

Пройди весь флоу с реальной библиотекой:
- Вкладки «Все / Фильмы / Сериалы / Папки» — сетка карточек, 5 в ряд, постеры/рейтинг.
- Сериал >1 сезона → выбор сезона (посезонные постеры) → серии списком.
- Сериал 1 сезон → сразу серии.
- Фильм → плеер; возврат → прогресс/✓ на карточке.
- «Назад» на всех уровнях.
- История LAMPA и playlist сезона в плеере работают как раньше.
- Состояния: «Прокси не настроен», «Папка пуста», ошибка Browse — рендерятся корректно.

- [ ] **Step 5: Commit**

```bash
git add plugins/dlna.js
git commit -m "refactor(grid): удалить мертвый renderSeriesRow"
```

- [ ] **Step 6: Обновить README и lampa-api.md (опционально, если описывают список)**

Run: `grep -niE "список|строк|сетк|карточк" README.md docs/lampa-api.md`
Если в README описан «опрятный список» — обновить формулировку на «сетку карточек». Коммит:

```bash
git add README.md docs/lampa-api.md
git commit -m "docs: README про карточную сетку вместо списка"
```

---

## Self-Review (выполнено при написании)

- **Покрытие спеки**: раскладка-сетка (T1,T6) ✓; 5 в ряд (T1 CSS) ✓; чистый постер + мета текстом (T3,T4) ✓; группировка сериала в карточку (T2,T4) ✓; экран выбора сезона + посезонные постеры (T7) ✓; серии списком (T6 ветка episodes) ✓; папки карточкой (T5) ✓; «Назад» строкой (T6,T7) ✓; кастомные тайлы, не Lampa.Card ✓; прогресс/просмотрено (T8) ✓; верификация browse.js+ручная ✓.
- **Плейсхолдеры**: нет TBD/TODO; весь код приведен дословно.
- **Согласованность типов**: `isVirtualShow`/`seasons`/`totalEpisodes` заданы в `groupShows` (T2) и читаются в `renderShowCard`/`renderSeasonPicker` (T4,T7); `_series={show,tmdb,season}` ставится в T4/T7 и читается экраном серий (`openCurrent` episodes-ветка по `_series.tmdb`/`_episode.season`); `data-hash` пишется в T3 и обновляется в T8; `ruPlural` (T2) используется в T4/T7. Имена функций единообразны (`renderCard`/`renderMovieCard`/`renderShowCard`/`renderFolderCard`/`renderSeasonPicker`).
