# Названия аудиодорожек в плеере (ffprobe-релейблинг)

Дата: 2026-06-04
Статус: согласовано

## Проблема

В скачанных фильмах (MKV с несколькими дорожками — разные дубляжи) плеер
LAMPA показывает дорожки как `1 / Неизвестно / 6 Ch / audio/x-ac3`. Выбрать
нужную озвучку невозможно: нативный плеер телевизора (Tizen avplay) читает
из файла только поле language (часто пустое), а имя студии дубляжа лежит в
поле **Title** дорожки, которое плеер игнорирует.

Плагин отдаёт плееру прямой URL MiniDLNA (`http://192.168.1.1:8200/MediaItems/N.mkv`),
меню дорожек строит сам плеер из метаданных стрима. MiniDLNA в DIDL-ответе
раскладку по дорожкам не отдаёт (только один `<res>`).

## Решение

Портируем механизм community-плагина `cub.red/plugin/tracks` в наш `dlna.js`.
Он умеет подменять дорожки в панели плеера через `Lampa.PlayerPanel.setTracks()`
/ `setSubs()`, беря метаданные из ffprobe. Оригинал берёт ffprobe из TorrServe
(WebSocket) и гейтит по `data.torrent_hash` — у нас этого нет, поэтому:

- источник ffprobe — **новый endpoint на нашем `serve.py`** (вариант A,
  выбран пользователем);
- гейт — по принадлежности `data.url` нашему DLNA-серверу.

Файлы НЕ перетегируются — Title читается на лету.

## Компоненты

### 1. `serve.py` — endpoint `GET /ffprobe?url=<media-url>`

- Парсит query-параметр `url`.
- Валидирует `url` тем же `host_allowed()`, что и `/proxy` (allowlist
  `ALLOWED_HOSTS`). Чужой хост → `403`.
- Находит бинарь `ffprobe` через `shutil.which('ffprobe')`. Нет → `503`
  (фича молча выключается на стороне плагина).
- Запускает (без shell, url — отдельный argv, инъекции невозможны):
  `ffprobe -v quiet -print_format json -show_streams <url>`
  с таймаутом ~20 c. ffprobe для MKV читает только заголовок (он в начале
  файла) → быстро, без скачивания целиком.
- Отдаёт тело ffprobe как `application/json` (`{streams:[...]}`) с CORS
  (через существующий `end_headers`). Таймаут/ненулевой код ffprobe → `502`.
- In-memory кэш `{url: body}` на время жизни процесса (файлы не меняются),
  с мягким лимитом размера.

### 2. `entware-install.sh`

- Добавить `ffprobe` в строку `opkg install` (с фолбэком: если пакета
  `ffprobe` нет — `ffmpeg`). Имя пакета уточняется при реализации
  (`opkg list | grep ffprobe`).
- Endpoint работает и без бинаря — отдаёт 503, фича выключается без ошибок.

### 3. `dlna.js` — релейблинг (модуль `TrackRelabel`)

Хелперы:
- `ffprobeEndpoint()` — origin от `proxyBase()` + `/ffprobe`
  (`scheme://host:port/ffprobe`). Origin-подход устойчив к кастомному пути
  прокси; если у пользователя сторонний прокси без `/ffprobe` — вернётся
  404, фича молча выключается.
- `isOurMedia(url)` — `url` содержит `dlnaAddr()` (наш DLNA-хост).

Поток (порт `subscribeTracks` из tracks.js):
- На `Lampa.Player.listener('start', data)`: если `isOurMedia(data.url)` —
  запускаем подписку.
- `GET ffprobeEndpoint()?url=<encodeURIComponent(data.url)>` (jQuery GET,
  dataType json, timeout ~20s, без кастомных заголовков → без preflight).
- Подписываемся на события `Lampa.PlayerVideo.listener`:
  `tracks` / `subs` / `canplay` / `webos_tracks` / `webos_subs` (покрываем
  Tizen и webOS).
- Маппинг ffprobe-`streams` → дорожки плеера: `language = tags.language`,
  `label = tags.title || tags.handler_name`; `Lampa.PlayerPanel.setTracks()` /
  `setSubs()`. Индексная арифметика (`minus`), фильтры dts/truehd/pgs —
  как в оригинале.
- На `Lampa.Player.listener('destroy')` — снять все слушатели (иначе копятся
  мёртвые closures; в проекте эту проблему уже ловили — см. `_onPlayerDestroy`).

Любая ошибка (нет прокси, 404/503, таймаут, пустой ffprobe) → no-op,
плеер показывает дефолтное меню как раньше. Фича строго неломающая.

### Что НЕ делаем

- `parseMetainfo`/`torrent_file`-часть оригинала (список файлов TorrServe) —
  не нужна.
- Fallback на публичный WebSocket-хост `185.204.0.61` из оригинала.
- Перетегирование файлов (mkvpropedit), настройку выбора плеера.

## Риск

Поведение `Lampa.PlayerVideo` / `PlayerPanel.setTracks` на конкретном Tizen
локально проверить нельзя — проверяется на телевизоре. Логика зеркалится с
рабочего `tracks.js`. Финальная верификация — на устройстве.

## Версия

`PLUGIN_VERSION` 0.11.0 → 0.12.0 (новая фича).
