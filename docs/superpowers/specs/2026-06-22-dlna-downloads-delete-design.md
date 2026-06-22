# Закачки и удаление фильма с DLNA — дизайн

## Контекст

Плагин `lampa-keenetic-dlna` (`plugins/dlna.js`, один IIFE) показывает видеотеку
с DLNA-сервера Кинетика (MiniDLNA) карточной сеткой. Уже есть интеграция с
встроенным в Кинетик Transmission: пункт «Скачать на Кинетик» в context-меню
торрент-раздач LAMPA-онлайна (`TransmissionClient.addTorrent`). README в разделе
«Что не делает» перечисляет именно то, что добавляем:

- не управляет существующими торрентами (пауза/удаление);
- не показывает прогресс скачивания;
- не удаляет фильмы.

Прокси `serve.py` форвардит любой `POST /proxy/<url>` на хосты из allowlist; в
allowlist уже есть `192.168.1.1:8090` (Transmission RPC). Бэкенд трогать не надо.

## Решения (зафиксированы с пользователем)

1. **Удаление файла — только через Transmission** `torrent-remove` с
   `delete-local-data: true`. Работает лишь для фильмов, которые ещё числятся
   раздачей в Transmission; для остального — честное «нельзя удалить».
2. **Список закачек — отдельная категория «Закачки»** в фильтре рядом с
   `Все / Фильмы / Сериалы / … / Папки`.
3. **Удаление фильма — long-press OK** на карточке фильма (context-меню).
4. **Прогресс закачек — авто-poll** каждые ~4 сек, пока открыт экран «Закачки».

## Архитектура

### Бэкенд (`serve.py`)

Без изменений. Всё идёт через существующий
`POST /proxy/http://192.168.1.1:8090/transmission/rpc`.

### `TransmissionClient` (`dlna.js`)

Сейчас экспортирует `addTorrent` / `ping` / `_resetSession`, внутри —
дублирующаяся XHR-логика session-id / basic-auth / 409-retry. Рефактор:

- Вынести общий `rpc(method, args, onDone, onFail)` — один XHR, обработка 409→
  retry с `X-Transmission-Session-Id`, 401/403/0/5xx → `onFail({reason})`,
  парсинг `result === 'success'`. `addTorrent`/`ping` переписать через него
  (поведение и reason-коды сохранить — на них завязаны Noty в Settings).
- Новые методы:
  - `list(onDone, onFail)` → `torrent-get`, поля
    `id, name, percentDone, rateDownload, status, eta, totalSize, downloadDir`
    и `files` (только `name`). `onDone(torrents[])`.
  - `remove(ids, deleteLocal, onDone, onFail)` → `torrent-remove`,
    `arguments: { ids, "delete-local-data": !!deleteLocal }`. Transmission на
    успех возвращает пустой результат — считаем успехом `result==='success'`.
- Хелпер (вне клиента, рядом с парсерами) `findTorrentForFile(fileTitle, list)`:
  нормализует имя так же, как `parseFilename` (убрать расширение, `[._]+`→пробел,
  trim, lower-case), сравнивает с нормализованным `torrent.name` и каждым
  `torrent.files[].name` (по basename). Возврат `{ id, name } | null`. Матч —
  при полном совпадении нормализованных строк ИЛИ если одна содержит другую
  как подстроку длиной ≥ разумного порога (избегаем ложных по коротким именам).

### Категория «Закачки»

- `TABS` (≈1069): добавить `{ id: 'downloads', title: 'Закачки' }` последним.
- `stacks` (≈1151): `downloads: [{ kind: 'downloads', title: 'Закачки' }]`.
- `openCurrent` (≈1255): ветка `top.kind === 'downloads'` **до** ветки index —
  вызывает `renderDownloads()`.
- `entryCategory` / index-ветки не трогаем: downloads не из индекса.

### `renderDownloads()`

- Если Transmission не настроен (`trAddr()` пуст) → плашка-инструкция в стиле
  существующей `no_proxy` (жёлтая, ссылка на README#transmission).
- `TransmissionClient.list`:
  - ошибка → красная плашка (как `browseError`) с reason.
  - пусто → «Нет активных закачек».
  - иначе — список строк (НЕ карточки-постеры): `renderDownloadRow(torrent)`.
- Авто-poll: `setInterval(~4000)` → повторный `list`, точечное обновление строк
  по `id` (прогресс/скорость/ETA/статус) без `scroll.clear()` — фокус не сбиваем.
  Новые id добавляем, исчезнувшие удаляем.
- Таймер хранить в поле компонента (`this._dlTimer`); гасить в `this.pause`,
  `this.destroy` и при `filter.onSelect` уходе с вкладки (в `reloadCurrent`/
  смене `currentTab`). Гасить и заводить идемпотентно (clear перед set).

### `renderDownloadRow(torrent)`

Строка (паттерн `dlna-row`, как экран серий): имя · прогресс-бар · `47%` ·
`↓ 2.3 МБ/с` · `ETA 3 мин`. Маппинг `status` → текст
(0 stopped «на паузе», 3 queued «в очереди», 4 downloading, 6 seeding «раздаётся»);
`eta < 0` → «—». `hover:enter` → `Lampa.Select.show`:
- **Отменить закачку (удалить файл)** → подтверждение → `remove([id], true)`.
- **Отменить, файл оставить** → подтверждение → `remove([id], false)`.
- **Закрыть**.

Подтверждение — второй `Lampa.Select` («Точно удалить “имя”?» / «Назад»). После
успеха — убрать строку из DOM + `Noty`; на ошибке — `Noty` с reason.

### Удаление фильма (long-press)

- В `renderMovieCard` (≈1658): `card.on('hover:long', …)` → `Lampa.Select.show`
  с пунктами **«Удалить с диска»** / «Закрыть».
- По выбору: `TransmissionClient.list` → `findTorrentForFile(entry.title, list)`:
  - нашли → подтверждение с именем раздачи → `remove([id], true)` → `Noty`
    «Удалено, обновите список — MiniDLNA уберёт после ресканирования».
  - не нашли → `Noty` «Не нашёл раздачу для этого файла в Transmission —
    удалить можно только через web-UI роутера».
- Только на карточках фильмов (`renderMovieCard`). На серии/сезоны — нет (YAGNI,
  матчинг по многим файлам ненадёжен).

## Поток данных

```
Закачки:  filter→downloads → openCurrent → renderDownloads → TransmissionClient.list
          → renderDownloadRow[] → poll(4s) → list → patch rows by id
          → cancel → Select(confirm) → remove(ids, deleteLocal) → Noty + drop row

Удаление: card hover:long → Select(«Удалить») → list → findTorrentForFile(title)
          → Select(confirm) → remove([id], true) → Noty
```

## Обработка ошибок

- Нет прокси / нет Transmission-addr → плашка-инструкция, без запросов.
- `list`/`remove` reason `auth|network|forbidden|server|rpc|parse` → Noty/плашка.
- Матч не найден → явный Noty, не удаляем вслепую.
- Poll: ошибочный тик не ломает экран (оставляем прошлые данные, тихо).

## Тестирование

- Юнит на `findTorrentForFile`: точный матч по `name`, матч по `files[].name`,
  расширение/разделители, отсутствие матча, короткие имена (нет ложного).
  Добавить в существующий каталог тестов (`scripts/`/`tools/` — где лежат
  регресс-тесты парсера, см. `09cc338`).
- Ручная проверка end-to-end на живом Transmission/DLNA (memory:
  verify-against-live-dlna): реальная закачка → прогресс растёт → отмена →
  исчезает; удаление фильма → файл уходит → после рескана пропал из «Все».

## Версия

`PLUGIN_VERSION` → `0.12.0`; коммит `v0.12.0: …` (memory: bump-plugin-version).

## Риски

1. **Матчинг DLNA-title ↔ имя раздачи** — нормализация + матч по `files[].name`;
   при неуверенности честно «не нашёл», не удаляем.
2. **Фокус при poll** — точечный патч DOM по `id`, `scroll`/фокус не трогаем.
3. **Статусы/eta Transmission** — явный маппинг, `eta<0` → «—».
4. **Жизненный цикл таймера** — clear в pause/destroy/смене вкладки, идемпотентно.

## Вне scope (YAGNI)

- Пауза/resume торрента, выбор файлов, изменение лимитов — отсылаем в web-UI.
- Форс-рескан MiniDLNA после удаления (нет управляющего API в allowlist).
- Удаление сериалов/серий, удаление файлов без раздачи в Transmission.
