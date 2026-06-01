# Фильтр по категориям: Фильмы / Сериалы / Мультфильмы / Мультсериалы / Аниме

Дата: 2026-06-01
Файл: `plugins/dlna.js`

## Проблема

Пользователь сообщил «фильтры перестали работать». Расследование (живой DLNA
192.168.1.1:8200, headless-репро в `tools/repro-filter.js`) показало, что
текущий фильтр «Фильмы/Сериалы» работает корректно end-to-end: индекс
собирается (32 тайтла: 18 сериалов + 14 фильмов), popup открывается, выбор
«Фильмы» → 14 карточек (0 сериалов), «Сериалы» → 18 карточек (0 фильмов).
Воспроизводимой регрессии в коде нет — вероятный реальный кейс на ТВ —
одноразовая пересборка стухшего кеша после бампа `INDEX_VERSION`.

Настоящая задача — фича: пользователь хочет больше категорий вместо двух.

## Цель

Расширить фильтр с 4 табов (Все/Фильмы/Сериалы/Папки) до 7:

`Все · Фильмы · Сериалы · Мультфильмы · Мультсериалы · Аниме · Папки`

## Решения (согласовано с пользователем)

- **Мультик** = TMDB-жанр «Анимация» (id 16), НЕ аниме.
- **Аниме** = жанр 16 И `original_language === 'ja'`. Один таб (полный метр и
  сериалы вместе).
- Аниме имеет приоритет над мульт-категориями (проверяется первым).
- Набор табов: «Все» + 4 категории + «Папки».

## Подход

Классификация **на рендере** из уже сохранённого в индексе `entry._tmdb`
(результат `search/movie|tv`, содержит `genre_ids` и `original_language`).
Схема индекса НЕ меняется — `_tmdb` уже сериализуется в snapshot
(`resolveAndStore` ставит `entry._tmdb = hit` / `ep._tmdb = hit`, `persist`
сохраняет весь entry). Поэтому **`INDEX_VERSION` не бампим, переиндексация не
нужна**.

Отклонённая альтернатива: хранить `entry._cat` на этапе сборки — требует бамп
версии + полную пересборку, правила нельзя менять без реиндекса.

## Изменения

### 1. Чистая функция `entryCategory(entry)` (рядом с `groupEpisodes`)

```
entryCategory(e):
  tmdb  = e._tmdb
  anim  = tmdb && tmdb.genre_ids && tmdb.genre_ids.indexOf(16) !== -1
  anime = anim && tmdb.original_language === 'ja'
  series = !!e._episode
  if (anime)            return 'anime'
  if (anim &&  series)  return 'cartoonseries'
  if (anim && !series)  return 'cartoonmovies'
  return series ? 'series' : 'movies'
```

Без TMDB-матча (`_tmdb` отсутствует) → fallback на `movies`/`series` по
`_episode` (как сейчас).

### 2. `TABS` и `stacks`

```js
var TABS = [
  { id: 'all',           title: 'Все' },
  { id: 'movies',        title: 'Фильмы' },
  { id: 'series',        title: 'Сериалы' },
  { id: 'cartoonmovies', title: 'Мультфильмы' },
  { id: 'cartoonseries', title: 'Мультсериалы' },
  { id: 'anime',         title: 'Аниме' },
  { id: 'folders',       title: 'Папки' }
];
```

`stacks` получает по записи на каждый индекс-таб:
`{ kind: '<id>', title: '<title>' }`; `folders` без изменений (`id:'0'`).

### 3. `renderFromIndex`

Заменить ветку movies/series на общий фильтр по категории:

```js
if (currentTab !== 'all') {
  entries = entries.filter(function (e) {
    return !e.isFolder && entryCategory(e) === currentTab;
  });
} else {
  entries = entries.filter(function (e) { return !e.isFolder; });
}
```

«Все» и «Папки» (живой browse) — без изменений.

### 4. Тест

В `tools/verify-parser.js` добавить регресс-блок для `entryCategory` на
синтетических `_tmdb`:
- фильм без жанра 16 → `movies`
- сериал (есть `_episode`) без жанра 16 → `series`
- фильм с жанром 16, lang en → `cartoonmovies`
- сериал с жанром 16, lang en → `cartoonseries`
- фильм с жанром 16, lang ja → `anime`
- сериал с жанром 16, lang ja → `anime`
- без `_tmdb` → fallback `movies`/`series` по `_episode`

### 5. Версия

User-facing → бамп `PLUGIN_VERSION` (`0.10.5` → `0.11.0`), коммит
`v0.11.0: фильтр по 7 категориям (+мультфильмы/мультсериалы/аниме)`.

## Не трогаем

Сборку индекса, группировку (`groupEpisodes`/`groupShows`), навигацию,
контроллеры, обёртку `Select.show` (torrent-инжект). Эпизоды одного шоу несут
общий `_tmdb` → шоу не разъезжается между табами.

## Ограничение

Жанр берётся из результата **поиска** TMDB — обычно точный, но при неверном
матче поиска возможна редкая мисс-классификация. Согласовано как приемлемое.
TMDB недоступен из dev-sandbox, поэтому жанровая ветка проверяется юнит-тестом,
а не живым репро; на ТВ TMDB работает штатно.
```
