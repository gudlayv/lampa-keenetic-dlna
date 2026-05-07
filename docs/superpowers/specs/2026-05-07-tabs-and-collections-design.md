# DLNA-плагин: вкладки + индекс коллекций

Статус: design approved · 2026-05-07

## Цель

Главная страница плагина превращается из обзора DLNA-папок в каталог
видео с сегмент-контролом наверху. По умолчанию открывается «Все»
(плоский список всех видео из MiniDLNA). Это даёт быстрый доступ к
контенту и масштабируется на 1000+ файлов: индексатор собирает
коллекции (movies, series, by_genre, by_lang, anime) для будущих
фильтров.

Не входит в это spec: UI фильтров, full-card LAMPA-страница,
сортировка по жанрам.

## Архитектура

### Вкладки

Один компонент `keenetic_dlna` со state.currentTab. Сегмент-контрол
сверху (4 вкладки), под ним — список, зависящий от вкладки.

| Вкладка | Источник | Фильтр |
|---|---|---|
| Все | `Browse('All Video')` MiniDLNA, sort `dc:date` desc | — |
| Фильмы | тот же индекс | `kind === 'movie'` |
| Сериалы | тот же индекс | серии сгруппированы в виртуальные карточки `Show · Сезон N` |
| Папки | `Browse('0')` → дерево | текущее поведение без изменений |

Точка входа — «Все».

### Layout

```
┌───────────────────────────────────────────────────┐
│ Keenetic DLNA                          [хедер]    │
├───────────────────────────────────────────────────┤
│ Keenetic Ultra                  [breadcrumb]      │
├───────────────────────────────────────────────────┤
│ ┌────┬───────┬─────────┬───────┐                  │
│ │Все │Фильмы │Сериалы  │Папки  │ [tabs]           │
│ └────┴───────┴─────────┴───────┘                  │
├───────────────────────────────────────────────────┤
│ [строки видео]                                    │
└───────────────────────────────────────────────────┘
```

Хлебные крошки видны только в «Папки» (DLNA-путь) и в «Сериалы» когда
зашли в конкретный сезон.

### Сегмент-контрол

DOM:
```html
<div class="dlna-keenetic__tabs">
  <div class="selector dlna-keenetic__tab dlna-keenetic__tab--active" data-tab="all">Все</div>
  <div class="selector dlna-keenetic__tab" data-tab="movies">Фильмы</div>
  <div class="selector dlna-keenetic__tab" data-tab="series">Сериалы</div>
  <div class="selector dlna-keenetic__tab" data-tab="folders">Папки</div>
</div>
```

Стиль: базовый прозрачный, активная вкладка — `background: rgba(255,255,255,0.18)`
(тот же приём что фокус — без теней/transition, чтобы Tizen не лагал).

Навигация с пульта:
- В сегмент-контроле `←/→` переключают вкладки
- `↓` уводит в список
- Из верхней строки списка `↑` возвращает в tabs
- `Enter` на вкладке = переключение

Состояние per-tab:
- Скролл-позиция (Map<tab, scrollY>)
- Стек навигации для «Папок» и «Сериалов» (когда зашли внутрь)

В `Activity.push` передаём `tab: 'all'` — возврат к той же вкладке после
перезагрузки приложения.

## Кеш

Два уровня в `Lampa.Storage`.

### 1. DLNA Browse cache (TTL 5 мин)

Ключ: `dlna_browse_<objectId>`. Значение `{ts, entries}`. Снимает
повторные SOAP-запросы при переключении вкладок.

### 2. TMDB resolve cache (TTL 30 дней)

Ключ: `dlna_tmdb_<source>_<query>`, source ∈ {`movie`, `tv`, `season`}.
Значение `{ts, hit}`. Один и тот же фильм/сериал не резолвим повторно.

При удалении файла из DLNA TMDB-кеш **не очищаем** — если позже появится
файл с тем же названием, экономим запрос.

## Локальный индекс

`Lampa.Storage` ключ `dlna_index`:

```js
{
  ts: 1778180000,
  updateId: 27,                  // последний UPnP UpdateID
  byUrl: {
    'http://192.168.1.1:8200/MediaItems/27.mkv': {
      kind: 'movie',             // movie | episode
      title: 'Достать ножи…',
      year: 2025,
      duration: 8775,            // секунды
      size: 22292922255,
      resolution: '3840x2160',
      addedAt: '2026-05-03T23:01:42',
      tmdb: {
        id: 1357633, media_type: 'movie',
        original_title: 'Wake Up Dead Man',
        poster_path: '/abc.jpg',
        genre_ids: [9648, 53],
        original_language: 'en',
        vote_average: 7.2
      }
    },
    'http://192.168.1.1:8200/MediaItems/45.mkv': {
      kind: 'episode',
      show: 'A Knight of the Seven Kingdoms',
      season: 1, episode: 1,
      tmdb: { /* tmdb сериала */ }
    }
  },
  collections: {
    movies: ['url1', 'url2', …],
    series: { 'show|season': ['url1', …] },
    by_genre: { 9648: ['url…'], 16: [...] },
    by_lang: { 'en': […], 'ja': […], 'ru': […] },
    anime: ['url…']              // genre_id===16 + original_language==='ja'
  }
}
```

`collections` — задел на будущие фильтры. Заполняется индексатором при
TMDB-резолве.

## Инвалидация кеша

### 1. UPnP UpdateID

При открытии плагина шлём `Browse(ObjectID=0, BrowseFlag=BrowseMetadata)`,
читаем `<UpdateID>`. Сравниваем с `index.updateId`:
- не изменился → отдаём индекс из кеша мгновенно
- изменился → перезапрашиваем `All Video` и делаем дифф

### 2. Дифф по URL'ам

```js
fresh_urls = new Set(entries.url)
indexed_urls = new Set(Object.keys(index.byUrl))

added   = fresh_urls \ indexed_urls    → резолвим TMDB, добавляем в индекс
removed = indexed_urls \ fresh_urls    → убираем из byUrl и из collections
```

### 3. Ручная инвалидация

Кнопка «Обновить индекс» (в крошках или меню вкладки). Чистит `dlna_index`
целиком, не трогая `dlna_tmdb_*`.

### 4. Bust by staleness

Если `index.ts` старше 7 дней — принудительный полный ре-скан, даже если
UpdateID совпал.

## Lazy TMDB resolve

### При открытии вкладки

Сразу из индекса (или Browse + минимальная инициализация):
- Имя файла (из DLNA), размер, длительность, разрешение
- Прогресс-бар (`Lampa.Timeline.view(hash)`)
- Если `byUrl[url].tmdb` уже есть — постер + название тоже сразу

### При попадании строки в viewport

`IntersectionObserver` (буфер ~200 px сверху и снизу) триггерит резолв,
если ещё не делался.

Очередь:
- Параллелизм 5
- Видимые строки имеют приоритет

Источники:
1. `dlna_tmdb_*` cache → берём оттуда
2. Иначе: `Lampa.TMDB.api('search/movie' | 'search/tv')` через
   `Lampa.Reguest.silent` с timeout 10 s

При успехе — обновляем DOM и кладём в `index.byUrl`.

При неудаче — мелкая надпись «TMDB: не найдено», title из имени файла.

### Серии (без изменений)

При входе в виртуальную папку сериала — один запрос
`tv/<id>/season/<n>`, обогащаем все эпизоды разом. Это уже работает
в v0.4.3.

## Классификация

При резолве TMDB определяем для каждого файла:
- `kind`: `movie` или `episode` (по парсингу имени `SxxExx` → episode)
- `media_type`: `movie` / `tv` (от TMDB)
- `genre_ids`: массив (от TMDB)
- `original_language`: код (от TMDB)
- `is_anime`: `genre_ids.includes(16) && original_language === 'ja'`

При обновлении `byUrl[url]` — обновляем соответствующие коллекции в
`collections`.

## Пограничные случаи

- **Файл не парсится** (имя без года, без SxxExx) → `kind: 'movie'`,
  `tmdb: null`. Появляется в «Все» и «Фильмы». Title = имя файла.
- **TMDB upstream недоступен** (РКН на этой сети) → запрос падает,
  fallback на имя файла. Lazy-resolve будет повторно пытаться при
  следующем скролле в viewport.
- **DLNA upstream упал** (Кинетик off, прокси down) → показываем кеш
  + красная плашка «не удалось обновить индекс».
- **Сериал без TMDB-резолва** → виртуальная папка с техническими
  именами файлов как сейчас. При следующем скролле может зарезолвиться.
- **Файл с одинаковым именем как у сериала, но без SxxExx**: попадает
  в «Фильмы». Это правильно (одиночный документальный, например).

## Ограничения и не-цели

- UI фильтров (по жанрам, языку, аниме) — не делаем. Только сбор
  данных.
- Виртуализация DOM (рендер только видимого) — не делаем сразу.
  Если на 500+ строк начнёт тормозить — добавим в отдельной итерации.
- Сортировка кроме `dc:date desc` — не делаем.
- Сериалы как одна карточка с сезонами внутри (вместо
  «Show · Сезон 1», «Show · Сезон 2» рядом) — не в этой итерации.

## Структура кода

`plugins/dlna.js` уже ~700 строк. С новым функционалом подойдёт к
~1200. Делим на чёткие секции в одном файле (без build step):

```
─ const PLUGIN_VERSION
─ injectStyles()
─ utils: escapeHtml, formatSize, parseDurationToSeconds
─ parsers: parseFilename, parseEpisode
─ classifier: classifyEntry, isAnime
─ tmdb: tmdbSearch, tmdbSeason, tmdbPosterUrl, lampaHash
─ cache: cacheGet, cacheSet (browse + tmdb + index)
─ index: rebuildIndex, diffUpdate, addToCollections
─ dlna: browse, getUpdateID
─ ui:
    renderTabs, renderRow (movie | episode | series | folder)
    renderAll, renderMovies, renderSeries, renderFolders
─ component:
    Component(), startPlugin()
```

Если файл превышает ~1500 строк — выделяем модули и вводим
простой concat-build.

## Тестирование

- `tools/browse.js` уже работает — открывает LAMPA в Chrome через
  Playwright, инжектит плагин, делает скриншоты.
- Проверки во время разработки:
  1. Открыть «Все» с пустым кешем — все строки появляются с
     placeholder, постеры подгружаются по мере скролла.
  2. Закрыть и открыть плагин снова — индекс из кеша, постеры сразу.
  3. Имитировать смену UpdateID (вручную в индексе изменить число) —
     должен пойти полный ре-скан.
  4. Удалить файл с роутера, открыть плагин — пропадает из «Все»
     и «Фильмы».
  5. Переключение между вкладками — мгновенное (один и тот же индекс).
  6. Скролл-позиция между вкладками — сохраняется per-tab.
- Финальная проверка — на TV вживую.
