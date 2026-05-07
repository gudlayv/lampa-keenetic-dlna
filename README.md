# lampa-keenetic-dlna

DLNA-клиент для [LAMPA](https://github.com/yumata/lampa-source), работает с
DLNA-сервером Кинетика (MiniDLNA). Видеотека на USB-диске роутера превращается
в опрятный список с постерами TMDB, прогрессом просмотра и навигацией как в
самой LAMPA.

![screenshot](docs/screenshot.png)

## Возможности

- Главная — `Все / Фильмы / Сериалы / Папки`, фильтр через `new Lampa.Filter`
- Постеры, рейтинг, описание из TMDB на каждой строке
- Серии сериала автоматически группируются по `S01E03` / `1x03` →
  одна карточка сезона, внутри список серий с TMDB-кадрами
- Прогресс-бар на строке (timeline LAMPA), бейдж «просмотрено» при ≥ 80 %
- При запуске видео — попадает в **Историю** LAMPA, при возврате в плагин
  прогресс-бар обновляется автоматически
- Стандартный пульт LAMPA, всё навигируется

## Зачем нужен прокси

Tizen / Android-WebView / лампа-веб блокируют прямые SOAP-запросы плагина
к Кинетику:

1. **CORS preflight.** Браузер шлёт `OPTIONS` перед `POST /ctl/ContentDir` с
   `SOAPAction`. MiniDLNA отвечает `501 Not Implemented` → preflight падает.
2. **Private Network Access.** LAMPA загружается с `file://` или публичного
   домена; браузер режет XHR/fetch на `192.168.x.x`.

Решение — HTTPS-прокси, форвардит запросы на DLNA-сервер с правильными
CORS-заголовками. Без прокси плагин **технически** не работает.

## Быстрый старт

### 1. Прокси на Кинетике (рекомендуемо)

Сначала [установи Entware](https://help.keenetic.com/hc/ru/articles/360021214160) на USB-стик в роутере (один раз, в web-интерфейсе).

Дальше один из двух режимов:

**1a. Локальный HTTP** (по умолчанию, без внешних сервисов)

```sh
ssh root@<keenetic-ip>
opkg install ca-certificates
curl -sSL https://raw.githubusercontent.com/gudlayv/lampa-keenetic-dlna/main/scripts/entware-install.sh | sh
```

В конце скрипт напечатает:
```
    http://<keenetic-ip>:8780/proxy/
```

Этот URL стабильный, не меняется, ничего не уходит наружу. Не работает только
через web-LAMPA (lampa.mx) и на платформах с агрессивным Private Network Access.

**1b. С Cloudflare-туннелем** (если 1a не работает на твоей платформе)

```sh
curl -sSL https://raw.githubusercontent.com/gudlayv/lampa-keenetic-dlna/main/scripts/entware-install.sh | sh -s -- --tunnel
```

Получишь публичный HTTPS-URL вида `https://<random>.trycloudflare.com/proxy/`.

> ⚠️ Quick-туннель `trycloudflare.com` **выдаёт новый URL при каждом
> перезапуске Кинетика**. `S99lampa-dlna status` покажет текущий — обнови
> в настройках LAMPA. Для постоянного URL — [Cloudflare named tunnel](#cloudflare-named-tunnel).

**Безопасность.** Прокси по умолчанию имеет allowlist: форвардит запросы
**только** на `192.168.1.1:8200` (DLNA-сервер). Запросы на админку Кинетика
(порт 80/443) и другие LAN-сервисы возвращают `403 Forbidden`. Допустимые
хосты можно изменить через переменную окружения `DLNA_PROXY_ALLOW`.

### 2. Альтернативы прокси

- **Lampac** ([immisterio/Lampac](https://github.com/immisterio/Lampac)) — у него
  встроенный `/proxy`. Поставить на NAS / Raspberry Pi / Docker / VPS.
- **Свой VPS** + WireGuard от Кинетика → запустить `serve.py` на VPS.
- **Локальный комп** с Mac/Linux: `python3 serve.py 8080` + `cloudflared tunnel
  --url http://localhost:8080`. Удобно для разработки, не для постоянной работы.

### 3. Установка плагина в LAMPA

В LAMPA на TV: **Расширения → Добавить URL**

```
https://cdn.jsdelivr.net/gh/gudlayv/lampa-keenetic-dlna@main/plugins/dlna.js
```

> Используем jsdelivr-CDN потому что `raw.githubusercontent.com` отдаёт
> `Content-Type: text/plain` + `nosniff`, и браузер LAMPA отказывается
> выполнять такой ответ как JavaScript. jsdelivr отдаёт правильный
> `application/javascript`.
>
> jsdelivr кеширует. Если правишь код, добавляй querystring (`?v=2`) или
> используй commit-hash в URL (`@<sha>`) чтобы подхватить свежую версию.

### 4. Настройка плагина

В LAMPA: **Настройки → Keenetic DLNA**

| Поле | Значение |
|---|---|
| Адрес DLNA-сервера | `192.168.1.1:8200` (или `<ip>:<порт>` твоего MiniDLNA) |
| Прокси URL | URL из шага 1, например `https://abcd-1234.trycloudflare.com/proxy/` |

Открой **Расширения → Keenetic DLNA** в боковом меню. Должен загрузиться
список «Все».

## Cloudflare named tunnel

Чтобы URL не менялся при каждом перезапуске:

1. Заведи бесплатный аккаунт на [dash.cloudflare.com](https://dash.cloudflare.com/).
2. Привяжи любой домен (можно из freenom / купить за $1).
3. На Кинетике:
   ```sh
   /opt/bin/cloudflared tunnel login
   /opt/bin/cloudflared tunnel create lampa-dlna
   /opt/bin/cloudflared tunnel route dns lampa-dlna lampa-dlna.<твой-домен>.com
   ```
4. Конфиг `/opt/etc/cloudflared/config.yml`:
   ```yaml
   tunnel: <UUID-туннеля-из-вывода-create>
   credentials-file: /root/.cloudflared/<UUID>.json
   ingress:
     - hostname: lampa-dlna.<твой-домен>.com
       service: http://localhost:8780
     - service: http_status:404
   ```
5. Замени в `/opt/lampa-keenetic-dlna/start.sh` строку с `cloudflared tunnel --url ...`
   на `cloudflared tunnel run lampa-dlna`.
6. В LAMPA → Настройки → Keenetic DLNA → Прокси URL:
   `https://lampa-dlna.<твой-домен>.com/proxy/`

URL стабильный, переживает любые перезапуски.

## Архитектура

```
[ TV ]                                              [ Кинетик ]
LAMPA → plugin/dlna.js  ──HTTPS──▶  Cloudflare ──▶  cloudflared
                                                       ↓
                                                    serve.py:8780
                                                       ↓
                                          MiniDLNA :8200 (ContentDirectory)
                                                       ↓
                                                  USB-диск /media/...
```

- `serve.py` — простой Python-прокси: `POST /proxy/<url>` форвардит запрос с
  CORS-заголовками. Также: `GET /ping`, `GET /reports/last` (для отладки).
- `cloudflared` — туннель Cloudflare → выдаёт HTTPS-URL.
- TV-плагин шлёт `POST <proxy>/proxy/http://192.168.1.1:8200/ctl/ContentDir`
  с SOAPAction-заголовком, парсит DIDL-Lite ответ, рисует UI.

Для воспроизведения медиа-потока берётся **прямой URL Кинетика**
(`http://192.168.1.1:8200/MediaItems/N.mkv`) — у Tizen avplay нет CORS-
ограничений, играет напрямую.

## Структура репо

```
plugins/
  dlna.js            — основной плагин LAMPA
serve.py             — Python HTTP-прокси для CORS-обхода
scripts/
  entware-install.sh — установка прокси на Кинетике через Entware
docs/
  lampa-api.md       — заметки по Lampa.Reguest, Component, Filter
  findings.md        — отчёт по Tizen 6 / MiniDLNA исследованию
  refs/              — исходники reference-плагинов LAMPA
  superpowers/specs/ — design-доки
tools/
  browse.js          — Playwright-обёртка: открывает LAMPA в Chrome,
                       инжектит плагин, делает скриншот. Для отладки.
```

## Разработка

```sh
# Поднять локальный прокси для итераций
python3 serve.py 8080

# В другом терминале — туннель
cloudflared tunnel --url http://localhost:8080
```

Подключить плагин в LAMPA по URL:
```
https://<ваш-tunnel>.trycloudflare.com/plugins/dlna.js?v=dev
```

Headless-отладка в Chrome (без TV):
```sh
npm install
node tools/browse.js --component keenetic_dlna --keys "up,enter" --wait 5000
# смотрит результат в shots/lampa-<timestamp>.png
```

## Лицензия

MIT.
