# LAMPA API заметки

Источник: [yumata/lampa-source](https://github.com/yumata/lampa-source).

## Lampa.Reguest (HTTP-клиент)

Под капотом на Tizen/web — `jQuery.ajax` с `crossDomain: true`. На Android — `Android.httpReq()` (Cordova plugin). Ограничения CORS такие же как у обычного XHR. Поэтому для UPnP-сервера, не отдающего CORS-заголовки, нужен прокси.

```js
var network = new Lampa.Reguest();
network.timeout(10000);

// Получить с обработкой жизненного цикла (start/complite/error/end events)
network.get(url, success, error, post_data);

// Тихий, прерывается при новом запросе
network.silent(url, success, error, post_data, params);

// Тихий, без прерывания (можно слать несколько параллельно)
network.quiet(url, success, error, post_data, params);

// Только последний из стека отработает
network.last(url, success, error, post_data);

// На Android — Cordova-плагин, на остальных — то же что get/silent
network.native(url, success, error, post_data, params);

network.clear();   // отменить все
network.again();   // повторить последний
```

### params (объект, 5-й аргумент silent/quiet/native)

```js
{
  dataType: 'json' | 'text' | 'xml' | 'html',  // default: 'json'
  timeout: 10000,                               // override default
  headers: { 'X-Header': 'value' },             // dictionary
  type: 'POST',                                  // override (если post_data передан, type=POST автоматически)
  withCredentials: true,                         // xhrFields.withCredentials
  beforeSend: { name, value },                   // одна пара header
  attempts: 2,                                   // retry на ошибку
  cache: { life: 60 }                            // кеш в минутах
}
```

### Разбор ошибок

`error(jqXHR, exception)` где:
- `jqXHR.status` — HTTP-код или 0 если сеть упала
- `jqXHR.responseText` — тело ответа (даже если был не-JSON: `dataType: 'json'` распарсить не смог)
- `jqXHR.responseJSON` — если успешно распарсилось как JSON
- `exception` — `'parsererror' | 'timeout' | 'abort' | строка`

**Важно:** если сервер вернул валидный HTTP-ответ, но не JSON, при `dataType: 'json'`
вызовется `error` callback с `readyState: 4` и текстом в `responseText`. Так что для
SOAP/XML обязательно ставить `dataType: 'text'` или `'xml'`.

## Регистрация плагина

```js
(function () {
  'use strict';
  if (window.plugin_my_thing) return;
  window.plugin_my_thing = true;

  function Component(object) {
    this.create = function () { /* активити создается */ };
    this.start  = function () { /* подключение Controller, фокус */ };
    this.pause  = function () {};
    this.stop   = function () {};
    this.render = function () { return html; };
    this.destroy= function () {};
  }

  function startPlugin() {
    var manifest = {
      type: 'plugin', version: '1.0.0',
      name: 'My Thing', description: '...',
      component: 'my_thing'
    };
    Lampa.Manifest.plugins = manifest;
    Lampa.Component.add(manifest.component, Component);
    Lampa.Template.add('my_thing_main', '<div>...</div>');
    Lampa.SettingsApi.addComponent({ component: 'my_thing_config', name: 'My Thing', icon: '<svg/>' });
    Lampa.SettingsApi.addParam({ component: 'my_thing_config', param: { name: 'host', type: 'input', default: '' }, field: { name: 'Адрес', description: '...' } });
    function add() {
      var btn = $('<li class="menu__item selector">...</li>');
      btn.on('hover:enter', function () {
        Lampa.Activity.push({ url: '', title: manifest.name, component: manifest.component, page: 1 });
      });
      $('.menu .menu__list').eq(0).append(btn);
    }
    if (window.appready) add();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') add(); });
  }
  startPlugin();
})();
```

## Воспроизведение

```js
Lampa.Player.play({ title: 'name', url: 'http(s)://host/file.mp4' });
Lampa.Player.playlist([{...}, ...]);
```

URL должен быть прямым стримом (mp4/mkv/m3u8). На Tizen LAMPA внутри использует свой плеер
поверх Tizen avplay — теоретически HTTP-стрим из LAN может играться напрямую без CORS-
ограничений (медиа-теги в браузерах сделаны под no-cors).

## Архитектура DLNA-плагина (на основе synology_dlna.js)

1. **Settings**: два поля — адрес DLNA-сервера и (опционально) прокси.
2. **State**: `tree = { device: {name}, tree: [{title, id}] }` — стек папок.
3. **Browse**:
   ```
   POST <proxy?> + http://<server>/ContentDirectory/control
   SOAPAction: "urn:schemas-upnp-org:service:ContentDirectory:1#Browse"
   Content-Type: text/xml
   <s:Envelope ...><s:Body><u:Browse><ObjectID>0</ObjectID>...</u:Browse></s:Body></s:Envelope>
   ```
   Ответ — XML, в `<Result>` — escaped XML с `<container>` и `<item>` (DIDL-Lite).
4. **Render**: items с типами `object.container.storageFolder`, `object.item.videoItem`,
   `object.item.audioItem.musicTrack`, `object.item.imageItem.photo`.
5. **Play**: `Lampa.Player.play({ title, url: proxyURL(item.url) })`.

См. `docs/refs/synology_dlna.js` — полный исходник.

## Прокси (когда нужен)

UPnP-серверы (Synology DSM, Кинетик, MiniDLNA, Twonky) НЕ отдают CORS-заголовки. Браузерный
preflight OPTIONS на `Content-Type: text/xml + SOAPAction` упадет.

Решения:
- **Lampac**: встроенный proxy-режим, эндпойнт `/proxy/<url>` с CORS-обвязкой. Поднимается на
  Windows/Linux/Docker. Может быть на роутере если Кинетик это поддерживает.
- **Свой мини-прокси**: 30 строк Python в нашем `serve.py` — `POST /proxy { url, headers, body }`
  пересылает на UPnP-сервер и возвращает с `Access-Control-Allow-Origin: *`.
