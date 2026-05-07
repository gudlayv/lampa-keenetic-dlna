# mlp — DLNA-плагин для LAMPA на Samsung Tizen 6

Цель: получить рабочий DLNA-клиент в LAMPA на Samsung Neo QLED (Tizen 6+),
который видит DLNA-сервер на Кинетике и играет видео в плеере LAMPA.

Существующий плагин (`http://cub.red/plugin/dlna`) сделан под Tizen 4–5 и
завязан на `webapis.allshare.serviceconnector`, которого в Tizen 6 уже нет.

## План

1. **Debug-плагин** (`plugins/tizen-debug.js`) — собирает дамп `window.tizen` и
   `window.webapis` на конкретном TV и шлет его на dev-сервер на ноуте.
2. На основе дампа понимаем, какие API вообще остались для UPnP/SSDP/сети.
3. Пишем DLNA-плагин (`plugins/dlna.js`, появится позже) — discovery, browse,
   воспроизведение через `Lampa.Player`.

## Быстрый старт (локальная отладка)

Ноут и оба TV в одной Wi-Fi сети.

```bash
# с ноута
python3 serve.py
```

Сервер слушает `0.0.0.0:8080`, отдает все файлы репо и принимает отчеты от
плагина в `POST /report`.

В LAMPA на TV:

1. Меню → Расширения (или Настройки → Плагины) → Добавить.
2. URL: `http://192.168.1.129:8080/plugins/tizen-debug.js`
   (поменяй IP на свой; узнать: `ipconfig getifaddr en0`).
3. После установки в боковом меню появится пункт **Tizen Debug**.
4. Открыть его → нажать **Отправить отчет**. На ноуте появится файл
   `reports/<timestamp>.json`.

Также: `GET http://<ip>:8080/reports/last` — последний отчет в браузере с ноута.

## Что собирает debug-плагин

- `navigator.userAgent`, размеры экрана, `Lampa.Platform.*`
- Quick checks: есть ли `webapis.allshare`, `webapis.network`, `webapis.avplay`,
  `webapis.productinfo`, `tizen.systeminfo`, `tizen.network`, `tizen.SocketAddress` и т.д.
- `tizen.systeminfo.getCapability(...)` для версии платформы, модели, фич сети
  (`network.upnp`, `network.dlna`, `network.wifi`).
- `webapis.productinfo.*` — модель, прошивка, реальное название.
- Полный обход `window.tizen` и `window.webapis` до глубины 3.

Все это пишется и в `console.log` — если подключен Web Inspector
(Tizen developer mode + `chrome://inspect`), смотри во вкладке Console.

## Где меняется адрес отчета

В файле `plugins/tizen-debug.js` константа `REPORT_ENDPOINT_DEFAULT`. Либо
можно положить в `Lampa.Storage` под ключ `tizen_debug_report_url` — тогда
не надо править код.

## Дальше

Когда отчеты с обоих TV собраны — кладем их в `docs/findings.md` с выводами
(какие API доступны, какие нет, что использовать для DLNA), и переходим
к написанию DLNA-плагина.

## Хостинг (на потом)

Когда плагин стабилизируется — переключим URL на raw.githubusercontent.com,
чтобы не держать ноут включенным:

```
https://raw.githubusercontent.com/<user>/mlp/main/plugins/tizen-debug.js
```

Telegram/QR — позже.
