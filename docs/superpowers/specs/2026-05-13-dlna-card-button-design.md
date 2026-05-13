# DLNA-кнопка на стандартной карточке LAMPA

**Дата:** 2026-05-13
**Файл, который меняем:** `plugins/dlna.js` (single-file плагин)
**Версия плагина:** `0.7.0 → 0.8.0`

## Цель

В стандартной TMDB-карточке фильма или сериала в LAMPA автоматически появляется
кнопка **«Смотреть с DLNA»**, если контент найден в нашем DLNA-индексе на
Кинетике. Клик по кнопке играет файл (или открывает выбор файла/серии).

Это убирает необходимость каждый раз заходить в отдельный раздел плагина и
искать фильм заново — если он есть на DLNA, кнопка ведет туда напрямую из
обычного UI LAMPA.

## Скоуп

В скоупе:

- Фоновый индекс DLNA, доступный любой странице LAMPA через единый сервис.
- Кнопка в `.full-start-new__buttons` / `.full-start__buttons` на странице
  карточки. Появляется только когда матч найден.
- Поведение клика: фильм → плеер (или Select при нескольких копиях); сериал →
  Activity со списком серий.
- Рефакторинг существующей вкладки «Movies» на единый `IndexService` — чтобы
  не было двух разных code-path'ов для одной задачи.
- Кнопка «Обновить DLNA-индекс» в Settings.

Вне скоупа:

- Online-источник / балансер (DLNA как «провайдер онлайн» в стандартной
  кнопке «Смотреть онлайн»).
- Интеграция в любые места LAMPA, кроме открытой карточки (recommendations,
  скроллы, главный экран и т.д.).
- Авто-обновление индекса при возврате LAMPA в foreground (если такой event
  вообще есть в Tizen-LAMPA) — оставлено на будущее.
- Поддержка нескольких DLNA-серверов одновременно — индекс строится по
  одному настроенному адресу.

## Архитектура

```
┌──────────────────────────────────────────────────────────────┐
│  IndexService                                                │
│  ─────────────                                               │
│  state: 'idle' | 'loading' | 'ready' | 'error'               │
│  byMovieId:  Map<tmdb_id, Entry[]>                           │
│  bySeriesId: Map<tmdb_id, Map<'SxxExx', Entry>>              │
│                                                              │
│  load()       → читает Storage-кеш, ставит state=ready       │
│  refresh()    → fresh sweep (DLNA Browse + TMDB), пишет кеш  │
│  quickCheck() → сравнивает urls с кешем, при diff → refresh  │
│  lookupMovie(tmdb_id) → Entry[] | null                       │
│  lookupSeries(tmdb_id) → SeriesMatch | null                  │
│  on('ready' | 'error', cb)                                   │
└──────────────────────────────────────────────────────────────┘
              ▲                              ▲
              │                              │
   ┌──────────┴──────────┐         ┌─────────┴────────────┐
   │  CardButton         │         │  Component (Movies)  │
   │  on full:complite   │         │  (рефакторинг)       │
   │  + on dlna:ready    │         │                      │
   │  injects DOM-кнопку │         │                      │
   └─────────────────────┘         └──────────────────────┘
                                                ▲
                                                │
                                   ┌────────────┴──────────┐
                                   │  EpisodeListComponent │
                                   │  'keenetic_dlna_      │
                                   │   episodes'           │
                                   └───────────────────────┘
```

`IndexService` — единая точка истины. И вкладка «Movies», и `CardButton`, и
новая Activity со списком серий читают данные из него. Sweep DLNA + TMDB
запускается только в одном месте.

## Структура `dlna.js` после изменений

```
1. settings / utils         (как сейчас)
2. DLNA SOAP browse / parse (как сейчас)
3. TMDB helpers             (как сейчас)
4. IndexService             ← новое
5. CardButton               ← новое
6. playMovie() + EpisodeListComponent (выделено из текущего Component)
7. Component (Movies)       — упрощен, использует IndexService
8. startPlugin              — регистрация всего
```

Файл вырастет с ~940 строк до ~1200-1300. Дальнейшее разбиение на несколько
файлов через сборку — вне скоупа.

## IndexService — детально

### Структуры данных

`Entry` — DLNA-item (как уже парсится в `parseNode`), плюс:

```js
{
  id, parentID, title, upnpClass, url, size, duration, resolution,
  protocolInfo, date, isFolder, kind,
  _parsed:  { title, year }                         // для фильма
  _episode: { show, season, episode }               // для серии, если распознали
  _tmdb:    { id, original_title, name, ... }       // TMDB hit либо null
}
```

In-memory:

```js
state = {
  status: 'idle' | 'loading' | 'ready' | 'error',
  byMovieId:  Map<number, Entry[]>,
  bySeriesId: Map<number, Map<string, Entry>>,  // ключ "S2E10"
  allEntries: Entry[],                          // плоский список для diff
  ts: number,
  addr: string,
  error: string | null
}
```

Снапшот в `Lampa.Storage` под `dlna_index_v1`:

```json
{
  "version": 1,
  "ts": 1778800000000,
  "addr": "192.168.1.1:8200",
  "entries": [ ... ],
  "movies": { "603": ["entry_url_1"] },
  "series": { "1399": { "S1E1": "entry_url_2" } }
}
```

`movies` / `series` хранят URL'ы, а не сами entry — entries в `entries[]`. При
загрузке восстанавливаем Map'ы.

### Жизненный цикл

При `app:ready`:

1. `IndexService.load()` — синхронно читает Storage-кеш. Если кеш есть и
   адрес совпадает — `status = 'ready'` мгновенно, шлет `dlna:index_ready`.
2. С задержкой ~2с (чтобы LAMPA доинициализировалась) — фоновый
   `IndexService.quickCheck()`.

`quickCheck()`:

1. Browse корня → Browse All Video (только id + url, без TMDB).
2. Сравниваем set URL'ов c `state.allEntries`.
3. Идентично → обновляем `ts` в Storage, выходим.
4. diff → `refresh()` инкрементально:
   - удаленные entries выбрасываем из map'ов;
   - новые → парсим имя, дергаем TMDB, добавляем в map'ы.

`refresh({ full: true })` — полная пересборка (для случая смены адреса DLNA
или ручной кнопки «Обновить»):

1. Browse All Video → список entries.
2. `groupEpisodes(entries)` → `{ singles, seriesGroups }`.
3. Для каждого `single` параллельно (concurrency=5): `parseFilename` →
   `tmdbSearch(title, year, 'movie')`.
4. Для каждой `seriesGroup`: 1 запрос `tmdbSearch(show, null, 'tv')`; ID
   серии наследуется всеми эпизодами группы.
5. Собираем `byMovieId` и `bySeriesId`.
6. Пишем снапшот в `Lampa.Storage`.
7. Шлем `dlna:index_ready` (или `dlna:index_updated`).

### Инвалидация

- Изменение `dlna_address` в Settings → `refresh({ full: true })`.
- Кнопка в Settings «Обновить DLNA-индекс» → `refresh({ full: true })`.
- TTL «жесткий» 7 дней: при `load()` если `now - ts > 7d` — после quickCheck
  делаем мягкий refresh TMDB-данных для известных URL (постеры / локализация
  могли обновиться). Это редкий путь.

### События

Используем `Lampa.Listener` (тот же что слушает плагин для `app`):

```js
Lampa.Listener.send('dlna_index', { type: 'ready' });
Lampa.Listener.send('dlna_index', { type: 'updated' });
Lampa.Listener.send('dlna_index', { type: 'error', error: ... });
```

Listener-ключ `dlna_index` — пространство имен плагина, не конфликтует с
LAMPA-событиями.

### API

```js
IndexService.load()             // sync
IndexService.refresh(opts)      // async (фоновый)
IndexService.quickCheck()       // async
IndexService.lookupMovie(id)    // Entry[] | null
IndexService.lookupSeries(id)   // { byEp: Map<'SxxExx', Entry>, seasons: number[] } | null
IndexService.state              // 'idle' | 'loading' | 'ready' | 'error'
IndexService.on(type, cb)       // 'ready' | 'updated' | 'error'
```

## CardButton — детально

### Хук

```js
Lampa.Listener.follow('full', function (e) {
    if (e.type === 'complite') CardButton.tryInject(e.object);
});
Lampa.Listener.follow('dlna_index', function (e) {
    if (e.type === 'ready' || e.type === 'updated') CardButton.refreshCurrent();
});
```

### Логика

```
tryInject(activity):
    card = activity.card
    if !card || !card.id: return
    isSeries = card.method === 'tv' || card.number_of_seasons != null
    match = isSeries
        ? IndexService.lookupSeries(card.id)
        : IndexService.lookupMovie(card.id)
    if !match || (isSeries && match.byEp.size === 0): return
    if (!activity.activity.render) return            // защита
    container = activity.activity.render()
        .find('.full-start-new__buttons, .full-start__buttons').eq(0)
    if !container.length: return
    container.find('.view--dlna').remove()           // идемпотентность
    btn = renderButton(match, isSeries)
    container.prepend(btn)
    Lampa.Controller.collectionSet(container)        // переиндексировать фокус
```

`refreshCurrent()`:

```
active = Lampa.Activity.active()
if active && active.component === 'full': tryInject(active)
```

### DOM-разметка

```html
<div class="full-start__button selector view--dlna">
  <svg>...иконка DLNA...</svg>
  <span>Смотреть с DLNA</span>
  <div class="full-start__button-subtitle">DLNA · 2 файла</div>
</div>
```

Subtitle вариативный:

| Случай | Subtitle |
|---|---|
| Фильм, 1 копия | "DLNA · {duration}" (если есть) или просто "DLNA" |
| Фильм, N копий | "DLNA · {N} файлов" |
| Сериал | "DLNA · {N сезонов} · {N серий}" |

### Совместимость с темами

Сначала ищем `.full-start-new__buttons` (актуальная тема LAMPA), потом
`.full-start__buttons` (старая). Если ни одного нет — silently exit.
Класс `full-start__button` работает в обеих темах.

## Поведение клика

`playMovie(entry, card)` — вынесена из текущего `playEntry` (строки ~720-756):

```js
function playMovie(entry, card, displayTitle) {
    var hash = lampaHash(card);
    var timeline = (Lampa.Timeline && Lampa.Timeline.view)
        ? Lampa.Timeline.view(hash) : null;
    if (timeline) timeline.hash = hash;
    if (Lampa.Favorite && Lampa.Favorite.add) {
        Lampa.Favorite.add('history', card, 100);
    }
    Lampa.Player.play({
        title: displayTitle || (card.title || card.original_title),
        url: entry.url, card: card, timeline: timeline
    });
    Lampa.Player.playlist([{
        title: displayTitle, url: entry.url, card: card, timeline: timeline
    }]);
}
```

### Фильм

```
entries = match
if entries.length === 1:
    playMovie(entries[0], card)
else:
    Lampa.Select.show({
        title: 'Выбор файла',
        items: entries.map(function (e) {
            return {
                title: (e.resolution || 'HD') + ' · ' + formatSize(e.size),
                subtitle: e.title,
                entry: e
            };
        }),
        onSelect: function (item) { playMovie(item.entry, card); }
    })
```

### Сериал

```
Lampa.Activity.push({
    url: '',
    title: card.name + ' · DLNA',
    component: 'keenetic_dlna_episodes',
    card: card,
    page: 1
})
```

Новый компонент `EpisodeListComponent` ('keenetic_dlna_episodes'):

- Принимает `{ card }` через `Lampa.Activity.active()`.
- Делает `IndexService.lookupSeries(card.id)` → знает, какие S/E доступны.
- Запрашивает у TMDB `tv/{id}/season/{s}` для каждого сезона, в котором есть
  файлы (`tmdbSeason` уже есть в коде).
- Рендерит тайлы только для серий, которые есть в DLNA. Недостающие
  скрываются (UI не лжет про доступность).
- Тайл — постер эпизода + название + overview + vote + прогресс timeline
  (как уже умеет текущий код во вкладке Movies).
- Клик по тайлу → `playMovie(entry, seriesCard, 'S{s}E{e} · {ep_title}')`,
  hash от `lampaHash(card, season, episode)`.

## Settings

В существующем разделе «Keenetic DLNA» добавляем третий пункт:

```js
Lampa.SettingsApi.addParam({
    component: 'keenetic_dlna_config',
    param: { name: 'dlna_refresh_index', type: 'button' },
    field: {
        name: 'Обновить DLNA-индекс',
        description: 'Пересканировать DLNA и обновить кеш совпадений с TMDB'
    },
    onChange: function () {
        IndexService.refresh({ full: true });
        if (Lampa.Noty) Lampa.Noty.show('DLNA: обновление индекса запущено');
    }
});
```

Тип `button` соответствует тому, как в LAMPA-source оформлены другие
триггерные действия в настройках. Если тип не отрисует кнопку — fallback
на `trigger` с default=false и сбросом флага в `onChange`.

## Edge cases

| Случай | Поведение |
|---|---|
| DLNA-сервер недоступен (cold start, нет кеша) | `status = 'error'`, кнопка нигде не появляется. |
| DLNA-сервер недоступен (warm start, кеш есть) | Отдаем stale-кеш, кнопка появляется. При клике плеер сам падает с ошибкой. |
| Прокси не настроен | То же, что недоступен. |
| Файл с тем же `tmdb_id`, что и серия (коллизия) | Не возможно: маппинг movies / series раздельный. |
| 4K + 1080p одного фильма | Lampa.Select выбор. |
| Серий мало (только S1E1) | Кнопка появляется, в списке серий 1 серия. |
| Имя файла не распарсилось | Идет в "rest", не попадает в индекс — нормально. |
| `card.id` отсутствует на полностью кастомных карточках | Без матча, кнопка не появляется. |
| Темы LAMPA без `.full-start__buttons` | silently exit. |
| Повторный `full:complite` (например, навигация назад) | `idempotent`-проверка `.view--dlna` сначала удаляет старую. |
| `dlna:index_ready` пришел, пока активити уже другая | `refreshCurrent()` смотрит `Activity.active()` и просто не делает ничего. |

## Изменения существующего кода

| Что | Зачем |
|---|---|
| Component (Movies) | Перевести на `IndexService.refresh()` + listener `dlna_index:ready`. Текущая логика рендеринга остается. |
| `playEntry` (~720-756) | Вынести в `playMovie(entry, card, title)`. |
| Эпизод-рендерер из Component | Вынести в `EpisodeListComponent` (новый зарегистрированный компонент `keenetic_dlna_episodes`). Текущая вкладка эпизодов и новая Activity используют один и тот же код. |
| `app:ready` обработчик | Добавить `IndexService.load()` + `setTimeout(quickCheck, 2000)`. |
| Manifest | Регистрировать второй компонент. |

## Ручное тестирование (план)

1. **Cold start без кеша**: удалить `dlna_index_v1` из Storage → перезапустить
   LAMPA → открыть фильм, который есть в DLNA → кнопка появляется через
   несколько секунд (после индексации).
2. **Warm start**: перезапуск → открыть тот же фильм → кнопка мгновенно.
3. **Quick check без изменений**: в DLNA ничего не менять → перезапуск → в
   логах sweep не запускается, только quickCheck.
4. **Quick check с добавлением**: новый фильм на DLNA → перезапуск → файл
   подтягивается, кнопка появляется на его карточке.
5. **Quick check с удалением**: удалить файл → перезапуск → кнопка на
   карточке исчезает.
6. **Фильм, 1 копия**: клик → плеер запускается сразу.
7. **Фильм, 2 копии**: клик → Lampa.Select с двумя пунктами.
8. **Сериал**: клик → Activity со списком серий → клик по серии → плеер.
9. **DLNA-сервер недоступен**: stale-кеш позволяет кнопке появиться, плеер
   падает (стандартное поведение LAMPA).
10. **Темы LAMPA**: проверить на актуальной теме (`.full-start-new__buttons`)
    и старой (`.full-start__buttons`).
11. **Раздел Movies (рефакторинг)**: вкладка работает как раньше — фильтр,
    серии, прогресс timeline.
12. **Кнопка в Settings**: «Обновить DLNA-индекс» запускает refresh,
    карточка в фоне получает свежие данные через event.

## Открытые вопросы

Нет — все решения зафиксированы при брейнсторминге.

## Версия

`PLUGIN_VERSION = '0.8.0'`
