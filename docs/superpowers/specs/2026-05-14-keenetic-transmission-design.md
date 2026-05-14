# Интеграция с Keenetic Transmission

**Дата:** 2026-05-14
**Файлы, которые меняем:** `plugins/dlna.js` (single-file плагин) + `serve.py` (CORS-прокси)
**Версия плагина:** `0.8.0 → 0.9.0`

## Цель

В контекстном меню торрент-раздачи (long-press OK на любом результате во
встроенном LAMPA-онлайне) появляется пункт **«Скачать на Кинетик»**. Клик
отправляет magnet-ссылку (или `.torrent`-URL) в Transmission, встроенный в
Кинетик. Файл качается на USB-диск, который сканирует MiniDLNA, и через
короткое время появляется в нашем DLNA-индексе и на карточке фильма как
«Смотреть с DLNA».

Это замыкает цикл: TMDB → поиск торрентов в LAMPA → скачивание на роутер →
просмотр через DLNA. Все из дивана, без админки.

## Скоуп

В скоупе:

- Кнопка «Скачать на Кинетик» в контекст-меню торрент-раздачи
  (long-press на любом result-row в активити с `component='torrents'`).
- Клиент Transmission RPC внутри плагина: один POST с `torrent-add`.
- Настройки в существующей секции «Keenetic DLNA»: адрес RPC,
  пользователь, пароль, опционально download-dir.
- Расширение `serve.py`: allowlist + CORS-headers для Transmission RPC.
- Уведомления Lampa.Noty о результате (успех / дубликат / ошибка).

Вне скоупа:

- Установка Transmission. У Кинетика это встроенный модуль, ставится через
  web-UI. Скриптовая установка не нужна.
- Прогресс-бар скачивания внутри LAMPA. Для этого есть web-UI Transmission.
- Управление существующими торрентами из LAMPA (пауза, удаление, выбор
  файлов).
- Своя UI для поиска торрентов: переиспользуем встроенный LAMPA-онлайн.
- Категории, labels, лимиты скорости.
- Поддержка нескольких Transmission-серверов одновременно.

## Архитектура

```
┌──────────────── TV / LAMPA ────────────────┐
│  plugins/dlna.js                            │
│  ├── DLNA-индекс, плеер, кнопка на карточке │
│  └── TransmissionAddon                      │
│       ├─ wraps Lampa.Select.show           │
│       ├─ инжектит пункт в context-меню     │
│       │  торрент-раздачи                    │
│       └─ TransmissionClient (RPC)          │
└────────────────────────────────────────────┘
                        │  HTTPS
                        ▼
┌──────────────────── Keenetic ──────────────────────┐
│  serve.py                                           │
│   ├─ POST /proxy/http://192.168.1.1:8200/...  → DLNA
│   └─ POST /proxy/http://192.168.1.1:8091/...  → Transmission
│                                                     │
│  Transmission (встроенный модуль Кинетика)          │
│   ├─ RPC на :8091/transmission/rpc                  │
│   ├─ basic-auth (логин/пароль из web-UI)            │
│   └─ download-dir управляется Кинетиком             │
│                                                     │
│  minidlna  ←─── сканирует USB-диск (тот же, что     │
│                использует Transmission)             │
└─────────────────────────────────────────────────────┘
```

На стороне Кинетика ничего нового не появляется. Transmission уже стоит
(встроен), `serve.py` уже стоит (используется DLNA-плагином) — только
allowlist расширяется.

## Компоненты

### TransmissionAddon (модуль внутри `plugins/dlna.js`)

Изолированный IIFE, рядом с `CardButton` и `IndexService`. Не трогает
существующий DLNA-код. Всегда активен; при ошибке отправки показывает Noty,
override никогда не ломает нативное поведение `Lampa.Select.show`.

Публичный API:

- `init()` — оборачивает `Lampa.Select.show` один раз. Вызывается из
  `startPlugin()`.

Override `Lampa.Select.show` устроен так:

1. `try`/`catch` обертка: если override упадет, `finally` вызовет
   оригинальный `Select.show`. Плагин **никогда** не должен ломать
   нативное поведение LAMPA.
2. Проверка контекста: `Lampa.Activity.active().component === 'torrents'`
   (точное имя компонента уточним при разработке — возможно `online` или
   `torrents`, в LAMPA-source это hard-coded).
3. Эвристика «это меню одной раздачи, а не глобальное меню фильтра/сортировки»:
   ищем в `params.items` пункт со словом `magnet` / `torrent` или флагом
   `_torrent`. Если не нашли — оставляем `params` как есть.
4. Извлечение magnet-URL из исходных данных. Здесь два candidate-источника:
   - `params.items[i]._torrent.magnet` или аналогичное поле,
   - сама `data`-структура текущего фокусного `selectbox-item` через
     `Lampa.Controller.enabled()`.
   Точную точку извлечения определим при реализации (см. «Открытые
   вопросы» ниже).
5. Префиксуется `params.items` нашим пунктом:
   ```js
   {
     title: 'Скачать на Кинетик',
     subtitle: name + ' · ' + (seeds ? seeds + ' сидов' : ''),
     _transmission: { magnet: '...', name: '...' },
     onSelect: TransmissionAddon._send
   }
   ```

`TransmissionAddon._send(item)` дергает `TransmissionClient.addTorrent`,
показывает Noty с результатом.

### TransmissionClient (модуль внутри `plugins/dlna.js`)

Тонкий wrapper над `Lampa.Reguest`. Один публичный метод:

- `addTorrent({ magnet, name }, onDone, onFail)` — POST на
  `${proxy}/proxy/http://${rpc_addr}/transmission/rpc` с телом:
  ```json
  {
    "method": "torrent-add",
    "arguments": { "filename": "<magnet|torrent_url>" }
  }
  ```
  Если в Settings задан `download-dir` — добавляется в `arguments`.
  Если есть user/pass — добавляется `Authorization: Basic <base64>`.

Обработка ответа:

- `result === "success"` + `arguments["torrent-added"]` → onDone({ added: true,
  name: arguments["torrent-added"].name }).
- `result === "success"` + `arguments["torrent-duplicate"]` → onDone({ duplicate: true,
  name: arguments["torrent-duplicate"].name }).
- Иначе → onFail(reason).

Имя для Noty **берется из ответа Transmission**, а не из параметра `dn=`
магнита. Подтверждено спайком: Transmission заменяет `dn=` на настоящее имя,
которое получает из torrent-metadata через DHT/пиров. В момент `torrent-add`
до подключения к пирам имя в ответе может быть равно `dn=` или хешу — это
нормально, дальше Transmission сам обновит.

**CSRF-логика:**

- На сборке Transmission в Кинетике CSRF отключен (подтверждено спайком —
  `session-stats` сразу возвращает 200 OK без `X-Transmission-Session-Id`).
- Для robustness на случай других сборок: если первый POST вернет
  HTTP 409, плагин читает `X-Transmission-Session-Id` из ответа и
  повторяет POST с этим заголовком. Session-id кешируется в памяти модуля
  на сессию.
- Это две строчки кода в `TransmissionClient`, поэтому выгоднее иметь, чем
  потом долго отлаживать у пользователя нестандартного билда.

### Settings (Lampa.SettingsApi, секция «Keenetic DLNA»)

Дополняем существующую секцию (НЕ создаем отдельную):

| Поле                          | Тип     | Default              | Описание                                              |
|------------------------------|---------|----------------------|-------------------------------------------------------|
| Transmission RPC             | input   | `192.168.1.1:8090`   | host:port RPC. 8090 — дефолт Кинетика; если в web-UI Кинетика поменяли (у автора, например, на 8091) — задать вручную. |
| Пользователь Transmission     | input   | `admin`              | Из web-UI Кинетика → Transmission.                    |
| Пароль Transmission           | input   | `` (пусто)           | Хранится в Lampa.Storage в открытом виде — disclaimer в `description`. |
| Папка скачивания (опц.)       | input   | `` (пусто)           | Если пусто — Transmission решает сам. Если задано — `arguments.download-dir`. |
| Тест соединения               | trigger | `false`              | По нажатию — `session-stats` → Noty с результатом.   |

При смене RPC-адреса/пароля сбрасываем кешированный session-id (если был).

### `serve.py` (две минимальные правки)

1. Дефолт `ALLOWED_HOSTS` расширяется до
   `192.168.1.1:8200,192.168.1.1:8091`. У пользователей с
   перепрописанным портом — нужно задать `DLNA_PROXY_ALLOW`.
2. Заголовки CORS:
   - `Access-Control-Allow-Headers`: добавить `Authorization,
     X-Transmission-Session-Id`.
   - `Access-Control-Expose-Headers: X-Transmission-Session-Id` —
     добавить новой строкой (чтобы JS мог прочитать его при 409).
3. Дефолт `ALLOWED_HOSTS` совпадает с тем, что захардкожен в
   `scripts/entware-install.sh` через `DLNA_PROXY_ALLOW`. При апдейте
   скрипта на Кинетике у пользователя — оба значения должны быть
   синхронизированы.

В скрипте `scripts/entware-install.sh` ничего не меняем: пользователь
ставил Transmission через web-UI Кинетика и сам задает порт в
настройках плагина.

## Поток данных (happy path)

1. Пользователь в LAMPA открывает карточку фильма → жмет «Онлайн» →
   выбирает источник → видит список раздач.
2. Long-press OK на нужной раздаче.
3. LAMPA вызывает `Lampa.Select.show({ title: 'Название раздачи', items: [...] })`.
4. Наш override:
   - детектит, что `Activity.active().component === 'torrents'` и в `items`
     есть магнит-pункт;
   - извлекает magnet, имя, число сидов;
   - префиксует `items` своим пунктом «Скачать на Кинетик»;
   - вызывает оригинальный `Lampa.Select.show(params)`.
5. Пользователь нажимает OK на нашем пункте.
6. `TransmissionAddon._send`:
   - `Lampa.Noty.show('Отправляю в Transmission…')`;
   - `TransmissionClient.addTorrent({ magnet, name })` → POST на прокси →
     прокси на `192.168.1.1:8091/transmission/rpc`.
7. Успех → `Lampa.Noty.show('Добавлено: <name>')`. В фоне Transmission
   качает; когда файл готов, MiniDLNA индексирует, наш `IndexService`
   через 5-10 минут (или после ручного «Обновить DLNA-индекс») увидит
   новый файл, и на карточке появится кнопка «Смотреть с DLNA».

## Обработка ошибок

| Ситуация                                          | Поведение                                                                                            |
|--------------------------------------------------|------------------------------------------------------------------------------------------------------|
| Прокси недоступен (timeout/502)                  | `Noty.show('Прокси недоступен. Проверь serve.py', { type: 'error' })`.                                |
| Transmission RPC ответил 401                     | `Noty.show('Неверный логин/пароль Transmission')`. Сбрасываем session-id.                              |
| 409 без `X-Transmission-Session-Id` в ответе     | `Noty.show('Прокси режет CORS-headers. Перезапусти serve.py с обновленным allowlist.')`.            |
| `arguments["torrent-duplicate"]`                 | `Noty.show('Уже в очереди: <name>')` (НЕ error, это нормальный сценарий).                            |
| `result !== "success"`                            | `Noty.show('Ошибка Transmission: ' + result, { type: 'error' })`.                                     |
| Не извлекли magnet из item                       | `Noty.show('Не удалось определить magnet')`. В `console.warn` логируем структуру item для диагностики. |
| Override упал                                    | `try`/`catch` → fallback на оригинальный `Lampa.Select.show`. Плагин **никогда** не должен ломать нативное поведение. |
| Адрес RPC не задан / RPC выключен                | Тихо: пункт «Скачать на Кинетик» не инжектится. Никаких Noty, никаких console.error.                 |

## Безопасность

- `serve.py` по-прежнему имеет allowlist. Только два конкретных host:port,
  все остальное — 403.
- Transmission слушает на LAN-интерфейсе Кинетика — это управляется
  Кинетиком, не плагином. Если пользователь не хочет открывать порт в
  LAN — он закрывает через web-UI Кинетика.
- Пароль Transmission хранится в `Lampa.Storage` (localStorage TV) в
  открытом виде. Приемлемо для домашнего сценария. В `description` поля —
  явный disclaimer.
- Прокси по-прежнему не раздает статики и не имеет `/reports`-эндпоинта
  для Transmission.

## Тестирование

- **Спайк (уже сделан).** `tools/test-transmission.sh` — POSIX-shell скрипт
  для запуска на Кинетике через SSH. Эмулирует те же шаги, что будет
  делать плагин: probe → (опц.) retry с session-id → torrent-add.
  Подтвердил: RPC доступен, auth работает, CSRF отключен в этой сборке.
- **Headless (`tools/browse.js`).** Инжектим плагин в LAMPA в Chrome,
  эмулируем `Lampa.Select.show` с фейковыми `items` (один с магнит-полем,
  один — глобальное меню без магнита) и проверяем:
  - в магнит-меню пункт «Скачать на Кинетик» появился сверху;
  - в глобальном меню — не появился;
  - после `onSelect` уходит POST на прокси (мок-сервер логирует запрос).
- **TV-ручное.** На реальном Кинетике:
  - открыть фильм → онлайн → long-press на раздаче → видим пункт;
  - нажать → Noty «Отправляю» → Noty «Добавлено»;
  - проверить в web-UI Кинетика → Transmission, что раздача появилась
    и качается;
  - дождаться завершения (или удалить через web-UI после проверки);
  - после завершения — «Обновить DLNA-индекс» в плагине, файл должен
    появиться в списке «Все».

## Открытые вопросы (решаем при реализации)

1. **Точное имя компонента LAMPA для торрент-списка.** Кандидаты:
   `torrents`, `online`, `lampac_online`. Уточним через `Activity.active()`
   в console прямо в LAMPA. От этого зависит точность фильтра в override.
2. **Точка извлечения magnet из item.** В разных online-плагинах структура
   `params.items` отличается. Стратегия: при первом запуске override
   с `params` в torrents-контексте — логируем структуру в console, дальше
   подбираем robust-extractor (несколько fallback-полей, regex по
   `subtitle`/`title` на `magnet:?xt=...` как last resort).
3. **Дефолтный пользователь Transmission.** У Кинетика admin/пароль из
   web-UI. По умолчанию admin — но пароль пустой, и при пустом пароле
   плагин не должен отправлять Authorization-header (basic-auth с пустым
   паролем работает иначе и может ломать запрос). Логика: если пароль
   пустой — Authorization не шлем.
4. **Чтение HTTP-статуса и заголовков ответа в `Lampa.Reguest`.** Для
   retry на 409 нужны: код статуса + значение
   `X-Transmission-Session-Id`. Если `Lampa.Reguest` это не пробрасывает —
   на CSRF-ветке fallback на нативный `fetch`/`XMLHttpRequest`. Для
   Кинетика, где CSRF отключен, путь — обычный `Lampa.Reguest.silent`.

Все четыре решаются на этапе реализации (in-flight), не блокируют дизайн.

## Версионирование

`PLUGIN_VERSION` в `plugins/dlna.js`: `0.8.0 → 0.9.0`. Описание плагина в
LAMPA-манифесте не меняется (это все еще «DLNA-клиент для Keenetic Ultra»;
Transmission — addon, а не отдельный плагин).

## YAGNI

- Не делаем установку Transmission через `entware-install.sh` — у Кинетика
  встроенный модуль.
- Не делаем прогресс-бар скачивания в LAMPA.
- Не делаем управление существующими торрентами.
- Не делаем выбор файлов в multi-file раздаче.
- Не делаем категории/labels.
- Не делаем сетевую авто-настройку Кинетика (download-dir, allow-list).
- Не делаем своего поиска торрентов — переиспользуем LAMPA online.
